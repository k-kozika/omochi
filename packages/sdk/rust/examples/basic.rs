use omochi_ui::{App, ButtonOptions, Result, SliderOptions, TextOptions};
use serde::Deserialize;

struct State {
    temperature: f64,
    result: Option<String>,
}
#[derive(Deserialize)]
struct RunInput {
    temperature: f64,
}

impl Default for State {
    fn default() -> Self {
        Self {
            temperature: 50.0,
            result: None,
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut app = App::new(State::default());

    let run = app.action::<RunInput, _, _>("run", |input, context| async move {
        context
            .update(|state| {
                state.temperature = input.temperature;
                state.result = Some(format!("Ran at temperature {}", input.temperature));
            })
            .await?;
        Ok(())
    })?;

    app.surface("main", move |ui, state| {
        let form = ui.local(
            "form",
            serde_json::json!({ "temperature": state.temperature }),
        )?;
        ui.text_with(
            "Hello",
            TextOptions {
                key: Some("title".into()),
                variant: Some("h2".into()),
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
            run.call(serde_json::json!({ "temperature": form.value("/temperature")? }))?,
            ButtonOptions {
                variant: Some("primary".into()),
                ..Default::default()
            },
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

    app.start().await
}
