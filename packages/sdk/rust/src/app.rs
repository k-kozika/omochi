use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use tokio::{
    sync::{Mutex, mpsc, oneshot},
    task::JoinSet,
};

use crate::{
    ActionHandle, Declaration, Error, Reconciler, Result, STANDARD_CATALOG, StdioTransport,
    Transport, Ui,
};

type ActionFuture = Pin<Box<dyn Future<Output = Result<()>> + Send + 'static>>;
type View<S> = Arc<dyn Fn(&mut Ui, &S) -> Result<()> + Send + Sync>;
type RegisteredAction<S> = Arc<dyn Fn(Value, ActionContext<S>) -> ActionFuture + Send + Sync>;

pub struct ActionContext<S> {
    state: Arc<Mutex<S>>,
    updates: mpsc::UnboundedSender<oneshot::Sender<Result<()>>>,
    update_lock: Arc<Mutex<()>>,
    revision: Arc<AtomicU64>,
}
impl<S> Clone for ActionContext<S> {
    fn clone(&self) -> Self {
        Self {
            state: self.state.clone(),
            updates: self.updates.clone(),
            update_lock: self.update_lock.clone(),
            revision: self.revision.clone(),
        }
    }
}
impl<S> ActionContext<S> {
    pub async fn update<F>(&self, mutator: F) -> Result<()>
    where
        F: FnOnce(&mut S),
    {
        // Keep each mutation and its publication together, including cloned contexts.
        let _update = self.update_lock.lock().await;
        if self.updates.is_closed() {
            return Err(Error::Declaration("action has already completed".into()));
        }
        {
            let mut state = self.state.lock().await;
            mutator(&mut state);
            self.revision.fetch_add(1, Ordering::AcqRel);
        }
        // Rendering must run with the state lock released. Runtime owns the transport.
        let (done, completed) = oneshot::channel();
        self.updates
            .send(done)
            .map_err(|_| Error::Declaration("action has already completed".into()))?;
        completed
            .await
            .map_err(|_| Error::Declaration("action has already completed".into()))?
    }
}

pub struct App<S> {
    catalog_id: String,
    state: Arc<Mutex<S>>,
    views: HashMap<String, View<S>>,
    surface_order: Vec<String>,
    actions: HashMap<String, RegisteredAction<S>>,
}
impl<S: Send + Sync + 'static> App<S> {
    pub fn new(state: S) -> Self {
        Self::with_catalog(state, STANDARD_CATALOG)
    }
    pub fn with_catalog(state: S, catalog_id: impl Into<String>) -> Self {
        Self {
            catalog_id: catalog_id.into(),
            state: Arc::new(Mutex::new(state)),
            views: HashMap::new(),
            surface_order: vec![],
            actions: HashMap::new(),
        }
    }
    pub fn surface<F>(&mut self, surface_id: impl Into<String>, view: F) -> Result<&mut Self>
    where
        F: Fn(&mut Ui, &S) -> Result<()> + Send + Sync + 'static,
    {
        let surface_id = surface_id.into();
        if self.views.contains_key(&surface_id) {
            return Err(Error::Declaration(format!(
                "surface already registered: {surface_id:?}"
            )));
        }
        self.surface_order.push(surface_id.clone());
        self.views.insert(surface_id, Arc::new(view));
        Ok(self)
    }
    pub fn action<I, F, Fut>(
        &mut self,
        name: impl Into<String>,
        action: F,
    ) -> Result<ActionHandle<I>>
    where
        I: DeserializeOwned + Send + 'static,
        F: Fn(I, ActionContext<S>) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<()>> + Send + 'static,
    {
        let name = name.into();
        if self.actions.contains_key(&name) {
            return Err(Error::Declaration(format!(
                "action already registered: {name:?}"
            )));
        }
        self.actions.insert(
            name.clone(),
            Arc::new(move |input, context| {
                let parsed = serde_json::from_value(input)
                    .map_err(|error| Error::Protocol(format!("invalid action input: {error}")));
                match parsed {
                    Ok(input) => Box::pin(action(input, context)),
                    Err(error) => Box::pin(async move { Err(error) }),
                }
            }),
        );
        Ok(ActionHandle(name, std::marker::PhantomData))
    }
    pub fn build(self) -> Runtime<S> {
        Runtime::new(self)
    }
    pub async fn start(self) -> Result<()> {
        self.build().start().await
    }
    pub async fn start_with<T: Transport + 'static>(self, transport: T) -> Result<()> {
        self.build().start_with(transport).await
    }
}

pub struct Runtime<S> {
    catalog_id: String,
    state: Arc<Mutex<S>>,
    views: HashMap<String, View<S>>,
    surface_order: Vec<String>,
    actions: HashMap<String, RegisteredAction<S>>,
    reconciler: Reconciler,
    transport: Option<Box<dyn Transport>>,
    revision: Arc<AtomicU64>,
    started: bool,
    ready: bool,
    closed: bool,
    tasks: JoinSet<Result<()>>,
}
impl<S: Send + Sync + 'static> Runtime<S> {
    fn new(app: App<S>) -> Self {
        Self {
            catalog_id: app.catalog_id,
            state: app.state,
            views: app.views,
            surface_order: app.surface_order,
            actions: app.actions,
            reconciler: Reconciler::default(),
            transport: None,
            revision: Arc::new(AtomicU64::new(0)),
            started: false,
            ready: false,
            closed: false,
            tasks: JoinSet::new(),
        }
    }
    pub fn app_revision(&self) -> u64 {
        self.revision.load(Ordering::Acquire)
    }
    pub async fn read<R, F>(&self, reader: F) -> R
    where
        F: FnOnce(&S) -> R,
    {
        let state = self.state.lock().await;
        reader(&state)
    }
    pub fn ready(&self) -> bool {
        self.ready
    }
    pub fn is_closed(&self) -> bool {
        self.closed
    }
    pub fn spawn<F>(&mut self, task: F)
    where
        F: Future<Output = Result<()>> + Send + 'static,
    {
        self.tasks.spawn(task);
    }
    pub async fn shutdown(&mut self) {
        self.tasks.abort_all();
        while self.tasks.join_next().await.is_some() {}
        self.closed = true;
    }
    pub async fn declaration(&self, surface_id: &str) -> Result<Declaration> {
        let view = self
            .views
            .get(surface_id)
            .ok_or_else(|| Error::Declaration(format!("unknown surface: {surface_id:?}")))?;
        let state = self.state.lock().await;
        let mut ui = Ui::new(surface_id, &self.catalog_id);
        view(&mut ui, &state)?;
        Ok(ui.build())
    }
    pub async fn render(&mut self, surface_id: &str) -> Result<Vec<Value>> {
        let declaration = self.declaration(surface_id).await?;
        self.reconciler.render(declaration)
    }
    pub async fn surface(&self, surface_id: &str) -> Result<Vec<Value>> {
        let mut reconciler = Reconciler::default();
        reconciler.render(self.declaration(surface_id).await?)
    }
    async fn render_all_and_send(&mut self) -> Result<Vec<Value>> {
        let mut all = vec![];
        for surface_id in self.surface_order.clone() {
            let messages = self.render(&surface_id).await?;
            if let Some(transport) = &mut self.transport {
                for message in &messages {
                    transport.send(message).await?;
                }
            }
            all.extend(messages);
        }
        Ok(all)
    }
    pub async fn update<F>(&mut self, mutator: F) -> Result<Vec<Value>>
    where
        F: FnOnce(&mut S),
    {
        {
            let mut state = self.state.lock().await;
            mutator(&mut state);
        }
        self.revision.fetch_add(1, Ordering::AcqRel);
        self.render_all_and_send().await
    }
    pub async fn invoke(&mut self, name: &str, input: Value) -> Result<Vec<Value>> {
        let action = self
            .actions
            .get(name)
            .cloned()
            .ok_or_else(|| Error::Protocol(format!("unknown action: {name:?}")))?;
        let (updates, mut requests) = mpsc::unbounded_channel();
        let mut running = action(
            input,
            ActionContext {
                state: self.state.clone(),
                updates,
                update_lock: Arc::new(Mutex::new(())),
                revision: self.revision.clone(),
            },
        );
        let mut messages = Vec::new();
        let mut receiving = true;
        loop {
            tokio::select! {
                result = &mut running => {
                    result?;
                    return Ok(messages);
                }
                request = requests.recv(), if receiving => {
                    let Some(done) = request else {
                        receiving = false;
                        continue;
                    };
                    let result = self.render_all_and_send().await.map(|batch| messages.extend(batch));
                    // Returning failures through update() lets the action handle them.
                    let _ = done.send(result);
                }
            }
        }
    }
    pub async fn handle(&mut self, message: Value) -> Result<Vec<Value>> {
        let object = message
            .as_object()
            .ok_or_else(|| Error::Protocol("message must be an object".into()))?;
        if object.get("type").and_then(Value::as_str) == Some("getSurface") {
            return self
                .surface(string_field(object, "surface")?.as_str())
                .await;
        }
        if object.get("type").and_then(Value::as_str) == Some("invoke") {
            let name = string_field(object, "action")?;
            return self
                .invoke(&name, object.get("input").cloned().unwrap_or(Value::Null))
                .await;
        }
        let payload = object
            .get("action")
            .and_then(Value::as_object)
            .unwrap_or(object);
        let name = string_field(payload, "name")?;
        let input = payload
            .get("context")
            .and_then(Value::as_object)
            .and_then(|value| value.get("input"))
            .or_else(|| payload.get("input"))
            .cloned()
            .unwrap_or(Value::Null);
        self.invoke(&name, input).await
    }
    pub async fn dispatch(&mut self, message: Value) -> Result<Vec<Value>> {
        self.handle(message).await
    }
    pub async fn start_with<T: Transport + 'static>(&mut self, transport: T) -> Result<()> {
        if self.started {
            return Err(Error::Declaration(
                "runtime has already been started".into(),
            ));
        }
        self.started = true;
        self.reconciler = Reconciler::new(transport.capabilities());
        self.transport = Some(Box::new(transport));
        let result = async {
            self.render_all_and_send().await?;
            self.ready = true;
            loop {
                let message = match self.transport.as_mut().unwrap().receive().await? {
                    Some(value) => value,
                    None => break,
                };
                let observe = message.get("type").and_then(Value::as_str) == Some("getSurface");
                let responses = self.handle(message).await?;
                if observe {
                    if let Some(transport) = &mut self.transport {
                        for response in &responses {
                            transport.send(response).await?;
                        }
                    }
                }
            }
            Ok(())
        }
        .await;
        self.shutdown().await;
        result
    }
    pub async fn start(&mut self) -> Result<()> {
        self.start_with(StdioTransport::new()).await
    }
}
fn string_field(object: &Map<String, Value>, name: &str) -> Result<String> {
    object
        .get(name)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| Error::Protocol(format!("message must contain string {name}")))
}
