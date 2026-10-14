use omochi_ui::{App, CallbackTransport, Error, Result, Tab, TextOptions, Ui};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::Notify;

fn text(ui: &mut Ui, value: &str, key: &str) -> Result<()> {
    ui.text_with(
        value,
        TextOptions {
            key: Some(key.into()),
            ..Default::default()
        },
    )
}

#[tokio::test]
async fn tabs_match_shared_fixture() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../../spec/fixtures/tabs.json")).unwrap();
    let mut app = App::new("Second".to_string());
    app.surface("main", |ui, title| {
        let first: fn(&mut Ui) -> Result<()> = |ui| text(ui, "A", "first");
        let second: fn(&mut Ui) -> Result<()> = |ui| text(ui, "B", "second");
        ui.tabs(
            Some("tabs".into()),
            vec![
                Tab {
                    title: "First".into(),
                    content: first,
                },
                Tab {
                    title: title.clone().into(),
                    content: second,
                },
            ],
        )
    })
    .unwrap();
    let mut runtime = app.build();
    assert_eq!(
        runtime.render("main").await.unwrap()[1]["updateComponents"]["components"],
        fixture["initialComponents"]
    );
    assert_eq!(
        runtime.update(|s| *s = "Renamed".into()).await.unwrap(),
        vec![json!({
            "version": "v0.9", "updateComponents": { "surfaceId": "main", "components": fixture["afterUpdateComponents"] }
        })]
    );
}

#[tokio::test]
async fn sends_progress_before_completion_and_returns_it_once() {
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let sent = Arc::new(Mutex::new(Vec::<Value>::new()));
    let mut app = App::new("idle".to_string());
    for id in ["one", "two"] {
        app.surface(id, |ui, s| text(ui, s, "status")).unwrap();
    }
    let (e, r) = (entered.clone(), release.clone());
    app.action::<(), _, _>("work", move |_, ctx| {
        let (e, r) = (e.clone(), r.clone());
        async move {
            ctx.update(|s| *s = "working".into()).await?;
            e.notify_one();
            r.notified().await;
            ctx.update(|s| *s = "done".into()).await?;
            ctx.update(|_| {}).await?;
            Ok(())
        }
    })
    .unwrap();
    let output = sent.clone();
    let transport = CallbackTransport::new(
        move |m| {
            output.lock().unwrap().push(m);
            async { Ok(()) }
        },
        || async { Ok(None) },
    );
    let mut runtime = app.build();
    runtime.start_with(transport).await.unwrap();
    sent.lock().unwrap().clear();
    let observer = async {
        entered.notified().await;
        let messages = sent.lock().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(
            messages[0]["updateComponents"]["components"][0]["text"],
            "working"
        );
        release.notify_one();
    };
    let (messages, ()) = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        tokio::join!(runtime.invoke("work", Value::Null), observer)
    })
    .await
    .unwrap();
    let messages = messages.unwrap();
    assert_eq!(messages, *sent.lock().unwrap());
    assert_eq!(messages.len(), 4);
}

#[tokio::test]
async fn concurrent_context_updates_produce_separate_offline_diffs() {
    let mut app = App::new(0);
    app.surface("main", |ui, s| text(ui, &s.to_string(), "value"))
        .unwrap();
    app.action::<(), _, _>("work", |_, ctx| async move {
        let (a, b) = tokio::join!(ctx.update(|s| *s = 1), ctx.update(|s| *s = 2));
        a?;
        b?;
        Ok(())
    })
    .unwrap();
    let mut runtime = app.build();
    runtime.render("main").await.unwrap();
    let messages = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        runtime.invoke("work", Value::Null),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        messages
            .iter()
            .map(|m| m["updateComponents"]["components"][0]["text"].clone())
            .collect::<Vec<_>>(),
        vec![json!("1"), json!("2")]
    );
}

#[tokio::test]
async fn errors_propagate_without_rollback_or_hanging() {
    let mut app = App::new(0);
    app.surface("main", |ui, s| text(ui, &s.to_string(), "value"))
        .unwrap();
    app.action::<(), _, _>("fail", |_, ctx| async move {
        ctx.update(|s| *s = 1).await?;
        Err(Error::Protocol("action failed".into()))
    })
    .unwrap();
    app.action::<(), _, _>("set", |_, ctx| async move { ctx.update(|s| *s += 1).await })
        .unwrap();
    let fail = Arc::new(AtomicBool::new(false));
    let flag = fail.clone();
    let transport = CallbackTransport::new(
        move |_| {
            let fail = flag.load(Ordering::SeqCst);
            async move {
                if fail {
                    Err(Error::Transport("send failed".into()))
                } else {
                    Ok(())
                }
            }
        },
        || async { Ok(None) },
    );
    let mut runtime = app.build();
    runtime.start_with(transport).await.unwrap();
    assert!(
        runtime
            .invoke("fail", Value::Null)
            .await
            .unwrap_err()
            .to_string()
            .contains("action failed")
    );
    assert_eq!(runtime.read(|s| *s).await, 1);
    fail.store(true, Ordering::SeqCst);
    let error = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        runtime.invoke("set", Value::Null),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert!(error.to_string().contains("send failed"));
    fail.store(false, Ordering::SeqCst);
    assert_eq!(runtime.invoke("set", Value::Null).await.unwrap().len(), 1);
}
