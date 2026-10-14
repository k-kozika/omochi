use std::collections::BTreeSet;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{Mutex, mpsc};
use tokio::task::JoinHandle;

use crate::snapshot::A2uiSnapshot;
use crate::transport::Transport;
use crate::{Error, Result};

const SOCKET_FILE_NAME: &str = "a2ui.sock";

/// Linux caps `sun_path` at 108 bytes and macOS at 104; leave room for the null terminator.
const MAX_SOCKET_PATH_BYTES: usize = 100;

/// Mirrors the id constraint the hub applies, so `<serviceId>/<surfaceId>` stays splittable.
pub fn validate_service_id(service_id: &str) -> Result<()> {
    // "." and ".." pass the character check but would collapse or escape the service directory.
    let acceptable = !service_id.is_empty()
        && service_id.len() <= 64
        && service_id != "."
        && service_id != ".."
        && service_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if acceptable {
        Ok(())
    } else {
        Err(Error::Declaration(format!(
            "service id must match [A-Za-z0-9._-]{{1,64}} and cannot be \".\" or \"..\": {service_id:?}"
        )))
    }
}

/// Resolves the directory holding one subdirectory per published service.
///
/// `$XDG_RUNTIME_DIR` is per-user and mode 0700, and that permission is the entire local
/// trust boundary. A world-writable `/tmp/omochi` is never used, because another local
/// user could pre-create a service directory and squat the socket.
pub fn omochi_runtime_root() -> PathBuf {
    match std::env::var_os("XDG_RUNTIME_DIR") {
        Some(configured) => PathBuf::from(configured).join("omochi"),
        None => {
            let uid = unsafe { libc_getuid() };
            std::env::temp_dir()
                .join(format!("omochi-{uid}"))
                .join("omochi")
        }
    }
}

// Avoids a `libc` dependency for the single value the fallback path needs.
unsafe fn libc_getuid() -> u32 {
    unsafe extern "C" {
        fn getuid() -> u32;
    }
    unsafe { getuid() }
}

#[derive(Debug, Clone)]
pub struct UnixSocketServerOptions {
    pub service_id: String,
    /// Human-readable label shown by a hub. Defaults to the service id.
    pub name: Option<String>,
    /// An emoji, or a `data:image/...;base64,` URL a browser can render directly.
    pub icon: Option<String>,
    /// Defaults to `$XDG_RUNTIME_DIR/omochi`.
    pub runtime_dir: Option<PathBuf>,
    pub capabilities: BTreeSet<String>,
}

impl UnixSocketServerOptions {
    pub fn new(service_id: impl Into<String>) -> Self {
        Self {
            service_id: service_id.into(),
            name: None,
            icon: None,
            runtime_dir: None,
            capabilities: BTreeSet::new(),
        }
    }
    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }
    pub fn with_icon(mut self, icon: impl Into<String>) -> Self {
        self.icon = Some(icon.into());
        self
    }
    pub fn with_runtime_dir(mut self, runtime_dir: impl Into<PathBuf>) -> Self {
        self.runtime_dir = Some(runtime_dir.into());
        self
    }
    pub fn with_capabilities(
        mut self,
        capabilities: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        self.capabilities = capabilities.into_iter().map(Into::into).collect();
        self
    }
}

struct Shared {
    clients: Mutex<Vec<mpsc::UnboundedSender<String>>>,
    snapshot: Mutex<A2uiSnapshot>,
}

impl Shared {
    async fn broadcast(&self, line: String) {
        let mut clients = self.clients.lock().await;
        clients.retain(|client| client.send(line.clone()).is_ok());
    }
}

/// Publishes one application on a unix domain socket and advertises it for discovery.
///
/// The transport writes `<runtime_dir>/<service_id>/manifest.json` next to the socket so a
/// hub can find it without configuration. Reaching the socket is the authentication: the
/// runtime directory is mode 0700, so only the owning user can connect.
///
/// One application is fanned out to every connected renderer, and their inbound messages
/// are merged into a single stream for the Runtime.
pub struct UnixSocketServerTransport {
    shared: Arc<Shared>,
    inbound: mpsc::UnboundedReceiver<Value>,
    accept: JoinHandle<()>,
    capabilities: BTreeSet<String>,
    directory: PathBuf,
    socket_path: PathBuf,
    closed: bool,
}

impl UnixSocketServerTransport {
    pub async fn bind(mut options: UnixSocketServerOptions) -> Result<Self> {
        validate_service_id(&options.service_id)?;
        let root = options
            .runtime_dir
            .take()
            .unwrap_or_else(omochi_runtime_root);
        let directory = root.join(&options.service_id);
        fs::create_dir_all(&directory)?;
        // create_dir_all's mode is masked by umask and leaves an existing directory untouched.
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;

        match Self::listen(&directory, options).await {
            Ok(transport) => Ok(transport),
            Err(error) => {
                // Leave no empty directory behind for a discovery pass to walk into.
                // remove_dir refuses a non-empty directory, so a live service is safe.
                let _ = fs::remove_dir(&directory);
                Err(error)
            }
        }
    }

    async fn listen(directory: &Path, options: UnixSocketServerOptions) -> Result<Self> {
        let socket_path = directory.join(SOCKET_FILE_NAME);
        if socket_path.as_os_str().len() > MAX_SOCKET_PATH_BYTES {
            return Err(Error::Transport(format!(
                "unix socket path is too long for this platform: {}",
                socket_path.display()
            )));
        }
        claim_socket_path(&socket_path).await?;

        let listener = UnixListener::bind(&socket_path)?;
        // Linux enforces unix socket permissions on connect, and bind applies the umask.
        fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))?;

        let shared = Arc::new(Shared {
            clients: Mutex::new(Vec::new()),
            snapshot: Mutex::new(A2uiSnapshot::new()),
        });
        let (sender, inbound) = mpsc::unbounded_channel();
        let accept_shared = Arc::clone(&shared);
        let accept = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let connection_shared = Arc::clone(&accept_shared);
                let connection_sender = sender.clone();
                tokio::spawn(async move {
                    serve_connection(stream, connection_shared, connection_sender).await;
                });
            }
        });

        // Advertise only once the socket accepts connections, so a readable manifest is
        // always connectable.
        write_manifest(
            directory,
            options.name.as_deref().unwrap_or(&options.service_id),
            options.icon.as_deref(),
        )?;

        Ok(Self {
            shared,
            inbound,
            accept,
            capabilities: options.capabilities,
            directory: directory.to_path_buf(),
            socket_path,
            closed: false,
        })
    }

    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    /// Retracts the advertisement, stops accepting, and removes the service directory.
    pub async fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        let _ = fs::remove_file(self.directory.join("manifest.json"));
        self.accept.abort();
        self.shared.clients.lock().await.clear();
        let _ = fs::remove_dir_all(&self.directory);
        self.inbound.close();
    }
}

impl Drop for UnixSocketServerTransport {
    fn drop(&mut self) {
        // Last-resort cleanup for a transport dropped without close().
        self.accept.abort();
        if !self.closed {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }
}

#[async_trait]
impl Transport for UnixSocketServerTransport {
    fn capabilities(&self) -> BTreeSet<String> {
        self.capabilities.clone()
    }

    async fn send(&mut self, message: &Value) -> Result<()> {
        self.shared.snapshot.lock().await.apply(message)?;
        self.shared
            .broadcast(format!("{}\n", serde_json::to_string(message)?))
            .await;
        Ok(())
    }

    async fn receive(&mut self) -> Result<Option<Value>> {
        Ok(self.inbound.recv().await)
    }
}

/// Takes ownership of the socket path, removing one left behind by a crash.
///
/// A path that still accepts connections means another instance owns this service id;
/// that probe is also the mutual-exclusion primitive.
async fn claim_socket_path(socket_path: &Path) -> Result<()> {
    if !socket_path.exists() {
        return Ok(());
    }
    if UnixStream::connect(socket_path).await.is_ok() {
        return Err(Error::Transport(format!(
            "another omochi service already owns {}",
            socket_path.display()
        )));
    }
    fs::remove_file(socket_path)?;
    Ok(())
}

/// Publishes the manifest atomically so a discovery pass never reads a half-written file.
fn write_manifest(directory: &Path, name: &str, icon: Option<&str>) -> Result<()> {
    let mut manifest = Map::new();
    manifest.insert("name".into(), Value::String(name.to_owned()));
    if let Some(icon) = icon {
        manifest.insert("icon".into(), Value::String(icon.to_owned()));
    }
    manifest.insert("socket".into(), Value::String(SOCKET_FILE_NAME.to_owned()));
    let temporary = directory.join(format!(".manifest.{}.tmp", std::process::id()));
    fs::write(
        &temporary,
        format!("{}\n", serde_json::to_string(&Value::Object(manifest))?),
    )?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
    fs::rename(&temporary, directory.join("manifest.json"))?;
    Ok(())
}

async fn serve_connection(
    stream: UnixStream,
    shared: Arc<Shared>,
    inbound: mpsc::UnboundedSender<Value>,
) {
    let (reader, mut writer) = stream.into_split();
    let (sender, mut outbound) = mpsc::unbounded_channel::<String>();
    for message in shared.snapshot.lock().await.messages() {
        let Ok(encoded) = serde_json::to_string(&message) else {
            continue;
        };
        if sender.send(format!("{encoded}\n")).is_err() {
            return;
        }
    }
    shared.clients.lock().await.push(sender);

    let writing = tokio::spawn(async move {
        while let Some(line) = outbound.recv().await {
            if writer.write_all(line.as_bytes()).await.is_err() {
                return;
            }
        }
    });

    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            break;
        };
        // "{error}" is a valid client message but carries no action for the Runtime to
        // invoke; dropping it keeps a client-side report from tearing the application down.
        if value.get("action").is_none() {
            continue;
        }
        if inbound.send(value).is_err() {
            break;
        }
    }
    writing.abort();
}
