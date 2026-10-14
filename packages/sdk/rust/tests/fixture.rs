use std::path::PathBuf;

use omochi_ui::{App, ButtonOptions, Result, SliderOptions, TextOptions};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Default)]
struct State {
    temperature: i64,
    result: Option<String>,
    revision: u64,
}
#[derive(Deserialize)]
struct RunInput {
    temperature: i64,
}

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../spec/fixtures/basic.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}
fn runtime() -> Result<omochi_ui::Runtime<State>> {
    let mut app = App::new(State {
        temperature: 50,
        ..Default::default()
    });
    let run = app.action::<RunInput, _, _>("run", |input, context| async move {
        context
            .update(|state| {
                state.temperature = input.temperature;
                state.result = Some(format!("Result: {}", input.temperature));
            })
            .await?;
        Ok(())
    })?;
    app.surface("main", move |ui, state| {
        let form = ui.local("form", json!({ "temperature": state.temperature }))?;
        ui.text_with(
            "Hello",
            TextOptions {
                key: Some("hello".into()),
                ..Default::default()
            },
        )?;
        ui.slider(
            "temperature",
            0.0,
            100.0,
            SliderOptions {
                bind: Some(form.bind("/temperature")?),
                ..Default::default()
            },
        )?;
        ui.button(
            "Run",
            run.call(json!({ "temperature": form.value("/temperature")? }))?,
            ButtonOptions::default(),
        )?;
        if let Some(result) = &state.result {
            ui.text_with(
                result.clone(),
                TextOptions {
                    key: Some("result".into()),
                    ..Default::default()
                },
            )?;
        }
        Ok(())
    })?;
    Ok(app.build())
}

#[tokio::test]
async fn matches_shared_fixture() {
    let fixture = fixture();
    let mut runtime = runtime().unwrap();
    assert_eq!(
        Value::Array(runtime.render("main").await.unwrap()),
        fixture["initialMessages"]
    );
    assert_eq!(
        Value::Array(runtime.handle(fixture["action"].clone()).await.unwrap()),
        fixture["afterActionMessages"]
    );
}

#[tokio::test]
async fn typed_action_is_independent_of_surface() {
    #[derive(Deserialize)]
    struct Input {
        value: i32,
    }
    let mut app = App::new(0i32);
    app.action::<Input, _, _>("set", |input, context| async move {
        context
            .update(|state| {
                *state = input.value;
            })
            .await?;
        Ok(())
    })
    .unwrap();
    let mut runtime = app.build();
    assert!(
        runtime
            .invoke("set", json!({ "value": 7 }))
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(runtime.app_revision(), 1);
    assert_eq!(runtime.read(|state| *state).await, 7);
}

#[tokio::test]
async fn external_update_renders_all_surfaces() {
    let mut app = App::new(0i32);
    app.surface("one", |ui, state| {
        ui.text_with(
            state.to_string(),
            TextOptions {
                key: Some("value".into()),
                ..Default::default()
            },
        )
    })
    .unwrap();
    app.surface("two", |ui, state| {
        ui.text_with(
            state.to_string(),
            TextOptions {
                key: Some("value".into()),
                ..Default::default()
            },
        )
    })
    .unwrap();
    let mut runtime = app.build();
    runtime.render("one").await.unwrap();
    runtime.render("two").await.unwrap();
    let messages = runtime
        .update(|state| {
            *state = 1;
        })
        .await
        .unwrap();
    let surfaces: std::collections::BTreeSet<_> = messages
        .iter()
        .filter_map(|message| message.get("updateComponents")?.get("surfaceId")?.as_str())
        .collect();
    assert_eq!(surfaces, ["one", "two"].into_iter().collect());
}

#[tokio::test]
async fn local_state_resets_only_when_reset_key_changes() {
    let mut app = App::new(State {
        temperature: 50,
        ..Default::default()
    });
    app.surface("main", |ui, state| {
        let form = ui.local_with(
            "form",
            json!({ "temperature": state.temperature }),
            Some(json!(state.revision)),
        )?;
        ui.slider(
            "temperature",
            0.0,
            100.0,
            SliderOptions {
                bind: Some(form.bind("/temperature")?),
                ..Default::default()
            },
        )
    })
    .unwrap();
    let mut runtime = app.build();
    runtime.render("main").await.unwrap();
    assert!(
        runtime
            .update(|state| {
                state.temperature = 75;
            })
            .await
            .unwrap()
            .is_empty()
    );
    let messages = runtime
        .update(|state| {
            state.revision += 1;
        })
        .await
        .unwrap();
    assert_eq!(
        messages,
        vec![
            json!({ "version": "v0.9", "updateDataModel": { "surfaceId": "main", "path": "/$local/form", "value": { "temperature": 75 } } })
        ]
    );
}

#[tokio::test]
async fn get_surface_returns_full_snapshot_after_render() {
    let mut runtime = runtime().unwrap();
    runtime.render("main").await.unwrap();
    assert!(
        runtime
            .handle(json!({ "type": "getSurface", "surface": "main" }))
            .await
            .unwrap()[0]
            .get("createSurface")
            .is_some()
    );
}
