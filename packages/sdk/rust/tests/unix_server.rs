use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use omochi_ui::{Transport, UnixSocketServerOptions, UnixSocketServerTransport};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

struct TempRoot(PathBuf);

impl TempRoot {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "omochi-rust-{label}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn read_messages(stream: &mut BufReader<UnixStream>, count: usize) -> Vec<Value> {
    let mut messages = Vec::new();
    while messages.len() < count {
        let mut line = String::new();
        let read = tokio::time::timeout(Duration::from_secs(5), stream.read_line(&mut line))
            .await
            .expect("timed out reading from the service")
            .expect("failed to read from the service");
        assert_ne!(read, 0, "the service closed the connection");
        if !line.trim().is_empty() {
            messages.push(serde_json::from_str(&line).unwrap());
        }
    }
    messages
}

#[tokio::test]
async fn publishes_a_discoverable_service_and_fans_it_out() {
    let root = TempRoot::new("publish");
    let mut transport = UnixSocketServerTransport::bind(
        UnixSocketServerOptions::new("demo")
            .with_name("Demo")
            .with_icon("🎤")
            .with_runtime_dir(root.path()),
    )
    .await
    .unwrap();

    let directory = transport.directory().to_path_buf();
    let socket_path = transport.socket_path().to_path_buf();
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(directory.join("manifest.json")).unwrap())
            .unwrap();
    assert_eq!(
        manifest,
        json!({ "name": "Demo", "icon": "🎤", "socket": "a2ui.sock" })
    );
    let mode = std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o700);

    // The message sequence a Runtime produces for one surface.
    for message in [
        json!({ "version": "v0.9", "createSurface": { "surfaceId": "main", "catalogId": "test", "sendDataModel": true } }),
        json!({ "version": "v0.9", "updateComponents": { "surfaceId": "main", "components": [{ "id": "count", "component": "Text", "text": "Count: 0" }] } }),
        json!({ "version": "v0.9", "updateDataModel": { "surfaceId": "main", "path": "/", "value": { "count": 0 } } }),
    ] {
        transport.send(&message).await.unwrap();
    }

    let mut client = BufReader::new(UnixStream::connect(&socket_path).await.unwrap());
    let initial = read_messages(&mut client, 3).await;
    assert_eq!(initial[0]["createSurface"]["surfaceId"], json!("main"));

    client
        .get_mut()
        .write_all(
            format!(
                "{}\n",
                json!({
                    "version": "v0.9",
                    "action": {
                        "name": "increment",
                        "surfaceId": "main",
                        "sourceComponentId": "action:increment",
                        "timestamp": "2026-08-12T00:00:00.000Z",
                        "context": {},
                    },
                })
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let received = transport.receive().await.unwrap().unwrap();
    assert_eq!(received["action"]["name"], json!("increment"));

    for message in [
        json!({ "version": "v0.9", "updateComponents": { "surfaceId": "main", "components": [{ "id": "count", "component": "Text", "text": "Count: 1" }] } }),
        json!({ "version": "v0.9", "updateDataModel": { "surfaceId": "main", "path": "/count", "value": 1 } }),
    ] {
        transport.send(&message).await.unwrap();
    }
    let updates = read_messages(&mut client, 2).await;
    assert_eq!(
        updates[0]["updateComponents"]["components"][0]["text"],
        json!("Count: 1")
    );

    // A renderer joining later is caught up from the snapshot rather than the history.
    let mut late = BufReader::new(UnixStream::connect(&socket_path).await.unwrap());
    let replay = read_messages(&mut late, 3).await;
    assert_eq!(
        replay[1]["updateComponents"]["components"][0]["text"],
        json!("Count: 1")
    );
    assert_eq!(replay[2]["updateDataModel"]["value"], json!({ "count": 1 }));

    transport.close().await;
    assert!(!directory.exists());
}

#[tokio::test]
async fn refuses_a_live_duplicate_and_recovers_a_stale_socket() {
    let root = TempRoot::new("duplicate");
    let mut first = UnixSocketServerTransport::bind(
        UnixSocketServerOptions::new("demo").with_runtime_dir(root.path()),
    )
    .await
    .unwrap();

    let duplicate = UnixSocketServerTransport::bind(
        UnixSocketServerOptions::new("demo").with_runtime_dir(root.path()),
    )
    .await;
    assert!(duplicate.is_err(), "a second instance must be refused");

    first.close().await;
    assert!(!root.path().join("demo").exists());

    // A socket file left behind by a crash must not block the next start.
    std::fs::create_dir_all(root.path().join("demo")).unwrap();
    std::fs::write(root.path().join("demo/a2ui.sock"), b"").unwrap();
    let mut restarted = UnixSocketServerTransport::bind(
        UnixSocketServerOptions::new("demo").with_runtime_dir(root.path()),
    )
    .await
    .unwrap();
    assert!(restarted.socket_path().exists());
    restarted.close().await;
}

#[tokio::test]
async fn rejects_a_service_id_that_would_escape_the_runtime_directory() {
    let root = TempRoot::new("ids");
    for service_id in [".", "..", "a/b", "", &"x".repeat(65)] {
        let result = UnixSocketServerTransport::bind(
            UnixSocketServerOptions::new(service_id).with_runtime_dir(root.path()),
        )
        .await;
        assert!(result.is_err(), "{service_id:?} must be rejected");
    }
}

#[tokio::test]
async fn drops_client_messages_that_carry_no_action() {
    let root = TempRoot::new("errors");
    let mut transport = UnixSocketServerTransport::bind(
        UnixSocketServerOptions::new("demo").with_runtime_dir(root.path()),
    )
    .await
    .unwrap();
    transport
        .send(&json!({ "version": "v0.9", "createSurface": { "surfaceId": "main", "catalogId": "test" } }))
        .await
        .unwrap();

    let mut client = BufReader::new(UnixStream::connect(transport.socket_path()).await.unwrap());
    read_messages(&mut client, 1).await;
    let error = json!({ "version": "v0.9", "error": { "code": "VALIDATION_FAILED", "surfaceId": "main", "path": "/x", "message": "bad" } });
    let action = json!({ "version": "v0.9", "action": { "name": "run", "surfaceId": "main", "sourceComponentId": "root", "timestamp": "2026-08-12T00:00:00.000Z", "context": {} } });
    client
        .get_mut()
        .write_all(format!("{error}\n{action}\n").as_bytes())
        .await
        .unwrap();

    // The client error is dropped, so the Runtime sees the action next.
    let received = transport.receive().await.unwrap().unwrap();
    assert_eq!(received["action"]["name"], json!("run"));
    transport.close().await;
}
