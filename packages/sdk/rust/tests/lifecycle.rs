use omochi_ui::{App, CallbackTransport, Error, Result};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::Notify;

struct TaskStopped(Arc<AtomicBool>);
impl Drop for TaskStopped {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn shutdown_runs_on_every_exit_and_preserves_the_original_error() {
    for stage in [
        "render",
        "initial send",
        "receive",
        "action",
        "response send",
        "eof",
    ] {
        let mut app = App::new(());
        app.surface("main", move |ui, _| {
            if stage == "render" {
                return Err(Error::Declaration(stage.into()));
            }
            ui.text("hello")
        })
        .unwrap();
        app.action::<(), _, _>("fail", |_, _| async {
            Err(Error::Protocol("action".into()))
        })
        .unwrap();
        let mut runtime = app.build();
        let stopped = Arc::new(AtomicBool::new(false));
        let entered = Arc::new(Notify::new());
        let notification = entered.clone();
        let guard = TaskStopped(stopped.clone());
        runtime.spawn(async move {
            let _guard = guard;
            notification.notify_one();
            std::future::pending::<Result<()>>().await
        });
        entered.notified().await;

        let responding = Arc::new(AtomicBool::new(false));
        let sending = responding.clone();
        let transport = CallbackTransport::new(
            move |_| {
                let fail = stage == "initial send"
                    || stage == "response send" && sending.load(Ordering::SeqCst);
                async move {
                    if fail {
                        Err(Error::Transport(stage.into()))
                    } else {
                        Ok(())
                    }
                }
            },
            move || {
                responding.store(true, Ordering::SeqCst);
                async move {
                    match stage {
                        "receive" => Err(Error::Transport(stage.into())),
                        "action" => Ok(Some(json!({"type": "invoke", "action": "fail"}))),
                        "response send" => {
                            Ok(Some(json!({"type": "getSurface", "surface": "main"})))
                        }
                        _ => Ok(None),
                    }
                }
            },
        );
        let result = runtime.start_with(transport).await;
        match stage {
            "eof" => assert!(result.is_ok()),
            "render" => assert!(matches!(result, Err(Error::Declaration(ref s)) if s == stage)),
            "action" => assert!(matches!(result, Err(Error::Protocol(ref s)) if s == stage)),
            _ => assert!(matches!(result, Err(Error::Transport(ref s)) if s == stage)),
        }
        assert!(runtime.is_closed(), "runtime remained open after {stage}");
        assert!(stopped.load(Ordering::SeqCst), "task survived {stage}");
    }
}
