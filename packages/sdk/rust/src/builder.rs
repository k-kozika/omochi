use std::{
    collections::{BTreeMap, BTreeSet},
    marker::PhantomData,
    sync::atomic::{AtomicU64, Ordering},
};

use serde_json::{Map, Value, json};

use crate::{ComponentProps, Declaration, Error, JsonObject, LocalDeclaration, Node, Result, Slot};

pub const STANDARD_CATALOG: &str = crate::BasicCatalog::ID;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionHandle<I>(pub(crate) String, pub(crate) PhantomData<fn(I)>);

#[derive(Clone, Debug, PartialEq)]
pub struct ActionCall {
    pub(crate) action: String,
    pub(crate) input: Value,
}

impl<I> ActionHandle<I> {
    pub fn call(&self, input: Value) -> Result<ActionCall> {
        Ok(ActionCall {
            action: self.0.clone(),
            input,
        })
    }
}

#[derive(Default)]
pub struct TextOptions {
    pub key: Option<String>,
    pub variant: Option<String>,
}
#[derive(Default)]
pub struct ImageOptions {
    pub key: Option<String>,
    pub description: Option<Value>,
    pub fit: Option<String>,
    pub variant: Option<String>,
}
#[derive(Default)]
pub struct LayoutOptions {
    pub key: Option<String>,
    pub justify: Option<String>,
    pub align: Option<String>,
}
#[derive(Default)]
pub struct ListOptions {
    pub key: Option<String>,
    pub direction: Option<String>,
    pub align: Option<String>,
    pub list_style: Option<String>,
}
#[derive(Default)]
pub struct ButtonOptions {
    pub key: Option<String>,
    pub variant: Option<String>,
}
#[derive(Default)]
pub struct TextFieldOptions {
    pub default: Option<String>,
    pub bind: Option<ModelBinding>,
    pub label: Value,
    pub key: Option<String>,
    pub variant: Option<String>,
    pub validation_regexp: Option<String>,
}
#[derive(Default)]
pub struct SliderOptions {
    pub default: Option<f64>,
    pub bind: Option<ModelBinding>,
    pub key: Option<String>,
    pub label: Option<Value>,
}
#[derive(Default)]
pub struct CheckBoxOptions {
    pub default: Option<bool>,
    pub bind: Option<ModelBinding>,
    pub label: Value,
    pub key: Option<String>,
}
#[derive(Default)]
pub struct ChoicePickerOptions {
    pub default: Option<Vec<String>>,
    pub bind: Option<ModelBinding>,
    pub label: Option<Value>,
    pub key: Option<String>,
    pub variant: Option<String>,
    pub display_style: Option<String>,
    pub filterable: Option<bool>,
}
#[derive(Default)]
pub struct DateTimeInputOptions {
    pub default: Option<String>,
    pub bind: Option<ModelBinding>,
    pub key: Option<String>,
    pub label: Option<Value>,
    pub enable_date: Option<bool>,
    pub enable_time: Option<bool>,
    pub min: Option<Value>,
    pub max: Option<Value>,
}

pub struct Tab<F> {
    pub title: Value,
    pub content: F,
}

static MODEL_TOKEN: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug)]
pub struct ModelBinding {
    path: String,
    token: u64,
}

impl From<ModelBinding> for Value {
    fn from(binding: ModelBinding) -> Self {
        json!({ "path": binding.path })
    }
}

pub struct Local {
    key: String,
    token: u64,
}

impl Local {
    pub fn bind(&self, path: &str) -> Result<ModelBinding> {
        validate_pointer(path)?;
        Ok(ModelBinding {
            path: local_path(&self.key, path),
            token: self.token,
        })
    }
    pub fn value(&self, path: &str) -> Result<Value> {
        validate_pointer(path)?;
        Ok(json!({ "$local": self.key, "path": path }))
    }
}

fn validate_pointer(path: &str) -> Result<()> {
    if !path.is_empty() && !path.starts_with('/') {
        return Err(Error::Declaration(
            "local path must be a JSON Pointer".into(),
        ));
    }
    Ok(())
}

pub struct Ui {
    surface_id: String,
    catalog_id: String,
    root: Node,
    target_path: Vec<(usize, usize)>,
    data: JsonObject,
    locals: BTreeMap<String, LocalDeclaration>,
    model_tokens: BTreeSet<u64>,
    uncontrolled_inputs: BTreeSet<String>,
    required_capabilities: BTreeSet<String>,
    keys: BTreeSet<String>,
    auto_key: usize,
}

impl Ui {
    pub fn new(surface_id: impl Into<String>, catalog_id: impl Into<String>) -> Self {
        Self::with_data(surface_id, catalog_id, None)
    }

    pub(crate) fn with_data(
        surface_id: impl Into<String>,
        catalog_id: impl Into<String>,
        previous_data: Option<&JsonObject>,
    ) -> Self {
        let mut keys = BTreeSet::new();
        keys.insert("root".into());
        Self {
            surface_id: surface_id.into(),
            catalog_id: catalog_id.into(),
            root: Node {
                key: "root".into(),
                component: "Column".into(),
                props: Map::new(),
                slots: vec![Slot {
                    path: "/children".into(),
                    kind: "list".into(),
                    nodes: vec![],
                    data_path: None,
                }],
            },
            target_path: vec![],
            data: json!({ "inputs": previous_data.and_then(|data| data.get("inputs")).and_then(Value::as_object).cloned().unwrap_or_default() }).as_object().unwrap().clone(),
            locals: BTreeMap::new(),
            model_tokens: BTreeSet::new(),
            uncontrolled_inputs: BTreeSet::new(),
            required_capabilities: BTreeSet::new(),
            keys,
            auto_key: 0,
        }
    }

    pub fn local(&mut self, key: impl Into<String>, initial: Value) -> Result<Local> {
        self.local_with(key, initial, None)
    }
    pub fn local_with(
        &mut self,
        key: impl Into<String>,
        initial: Value,
        reset_key: Option<Value>,
    ) -> Result<Local> {
        let key = key.into();
        if key.is_empty() || self.locals.contains_key(&key) {
            return Err(Error::Declaration(format!(
                "local key must be unique and non-empty: {key:?}"
            )));
        }
        let token = MODEL_TOKEN.fetch_add(1, Ordering::Relaxed);
        self.model_tokens.insert(token);
        self.locals
            .insert(key.clone(), LocalDeclaration { initial, reset_key });
        Ok(Local { key, token })
    }

    fn resolve_key(&mut self, key: Option<String>) -> Result<String> {
        let key = key.unwrap_or_else(|| {
            let key = format!("auto:{}", self.auto_key);
            self.auto_key += 1;
            key
        });
        if !self.keys.insert(key.clone()) {
            return Err(Error::Declaration(format!(
                "duplicate component key on {:?}: {:?}",
                self.surface_id, key
            )));
        }
        Ok(key)
    }

    fn target_mut(&mut self) -> &mut Vec<Node> {
        let mut nodes = &mut self.root.slots[0].nodes;
        for (node_index, slot_index) in &self.target_path {
            nodes = &mut nodes[*node_index].slots[*slot_index].nodes;
        }
        nodes
    }

    fn append(
        &mut self,
        component: impl Into<String>,
        props: JsonObject,
        key: Option<String>,
    ) -> Result<usize> {
        let node = Node {
            key: self.resolve_key(key)?,
            component: component.into(),
            props,
            slots: vec![],
        };
        let nodes = self.target_mut();
        nodes.push(node);
        Ok(nodes.len() - 1)
    }

    fn add_slot<F>(&mut self, node_index: usize, path: &str, kind: &str, build: F) -> Result<usize>
    where
        F: FnOnce(&mut Self) -> Result<()>,
    {
        let slot_index = {
            let nodes = self.target_mut();
            let node = &mut nodes[node_index];
            node.slots.push(Slot {
                path: path.into(),
                kind: kind.into(),
                nodes: vec![],
                data_path: None,
            });
            node.slots.len() - 1
        };
        self.target_path.push((node_index, slot_index));
        let result = build(self);
        let count = self.target_mut().len();
        self.target_path.pop();
        result?;
        Ok(count)
    }

    pub fn component<P: ComponentProps>(&mut self, key: impl Into<String>, props: P) -> Result<()> {
        self.append(P::NAME, props.into_props(), Some(key.into()))?;
        Ok(())
    }

    pub fn text(&mut self, value: impl Into<Value>) -> Result<()> {
        self.text_with(value, TextOptions::default())
    }
    pub fn text_with(&mut self, value: impl Into<Value>, options: TextOptions) -> Result<()> {
        let mut props = json!({ "text": value.into() }).as_object().unwrap().clone();
        optional(&mut props, "variant", options.variant);
        self.append("Text", props, options.key)?;
        Ok(())
    }
    pub fn image(&mut self, url: impl Into<Value>, options: ImageOptions) -> Result<()> {
        let mut props = json!({ "url": url.into() }).as_object().unwrap().clone();
        optional_value(&mut props, "description", options.description);
        optional(&mut props, "fit", options.fit);
        optional(&mut props, "variant", options.variant);
        self.append("Image", props, options.key)?;
        Ok(())
    }
    pub fn icon(&mut self, name: impl Into<Value>, key: Option<String>) -> Result<()> {
        self.append(
            "Icon",
            json!({ "name": name.into() }).as_object().unwrap().clone(),
            key,
        )?;
        Ok(())
    }
    pub fn video(&mut self, url: impl Into<Value>, key: Option<String>) -> Result<()> {
        self.append(
            "Video",
            json!({ "url": url.into() }).as_object().unwrap().clone(),
            key,
        )?;
        Ok(())
    }
    pub fn audio_player(
        &mut self,
        url: impl Into<Value>,
        description: Option<Value>,
        key: Option<String>,
    ) -> Result<()> {
        let mut props = json!({ "url": url.into() }).as_object().unwrap().clone();
        optional_value(&mut props, "description", description);
        self.append("AudioPlayer", props, key)?;
        Ok(())
    }
    pub fn divider(&mut self, axis: Option<String>, key: Option<String>) -> Result<()> {
        let mut props = Map::new();
        optional(&mut props, "axis", axis);
        self.append("Divider", props, key)?;
        Ok(())
    }

    fn layout<F>(&mut self, component: &str, options: LayoutOptions, build: F) -> Result<()>
    where
        F: FnOnce(&mut Self) -> Result<()>,
    {
        let mut props = Map::new();
        optional(&mut props, "justify", options.justify);
        optional(&mut props, "align", options.align);
        let index = self.append(component, props, options.key)?;
        self.add_slot(index, "/children", "list", build)?;
        Ok(())
    }
    pub fn row<F>(&mut self, options: LayoutOptions, build: F) -> Result<()>
    where
        F: FnOnce(&mut Self) -> Result<()>,
    {
        self.layout("Row", options, build)
    }
    pub fn column<F>(&mut self, options: LayoutOptions, build: F) -> Result<()>
    where
        F: FnOnce(&mut Self) -> Result<()>,
    {
        self.layout("Column", options, build)
    }
    pub fn list<F>(&mut self, options: ListOptions, build: F) -> Result<()>
    where
        F: FnOnce(&mut Self) -> Result<()>,
    {
        let mut props = Map::new();
        optional(&mut props, "direction", options.direction);
        optional(&mut props, "align", options.align);
        optional(&mut props, "listStyle", options.list_style);
        let index = self.append("List", props, options.key)?;
        self.add_slot(index, "/children", "list", build)?;
        Ok(())
    }
    pub fn card<F>(&mut self, key: Option<String>, build: F) -> Result<()>
    where
        F: FnOnce(&mut Self) -> Result<()>,
    {
        let index = self.append("Card", Map::new(), key)?;
        if self.add_slot(index, "/child", "single", build)? != 1 {
            return Err(Error::Declaration(
                "Card must contain exactly one child".into(),
            ));
        }
        Ok(())
    }

    pub fn tabs<F>(&mut self, key: Option<String>, tabs: Vec<Tab<F>>) -> Result<()>
    where
        F: FnOnce(&mut Self) -> Result<()>,
    {
        let summaries: Vec<_> = tabs
            .iter()
            .map(|tab| json!({ "title": tab.title }))
            .collect();
        let index = self.append(
            "Tabs",
            json!({ "tabs": summaries }).as_object().unwrap().clone(),
            key,
        )?;
        for (tab_index, tab) in tabs.into_iter().enumerate() {
            if self.add_slot(
                index,
                &format!("/tabs/{tab_index}/child"),
                "single",
                tab.content,
            )? != 1
            {
                return Err(Error::Declaration(
                    "each tab must contain exactly one child".into(),
                ));
            }
        }
        Ok(())
    }
    pub fn modal<T, C>(&mut self, key: Option<String>, trigger: T, content: C) -> Result<()>
    where
        T: FnOnce(&mut Self) -> Result<()>,
        C: FnOnce(&mut Self) -> Result<()>,
    {
        let index = self.append("Modal", Map::new(), key)?;
        if self.add_slot(index, "/trigger", "single", trigger)? != 1
            || self.add_slot(index, "/content", "single", content)? != 1
        {
            return Err(Error::Declaration(
                "modal trigger and content must each contain exactly one child".into(),
            ));
        }
        Ok(())
    }

    pub fn button(
        &mut self,
        label: impl Into<Value>,
        action: ActionCall,
        options: ButtonOptions,
    ) -> Result<()> {
        let key = self.resolve_key(
            options
                .key
                .or_else(|| Some(format!("action:{}", action.action))),
        )?;
        let label_key = self.resolve_key(Some(format!("{key}:label")))?;
        let mut props = json!({ "action": { "event": { "name": action.action, "context": { "input": resolve_local_values(action.input) } } } }).as_object().unwrap().clone();
        optional(&mut props, "variant", options.variant);
        self.target_mut().push(Node {
            key,
            component: "Button".into(),
            props,
            slots: vec![Slot {
                path: "/child".into(),
                kind: "single".into(),
                nodes: vec![Node {
                    key: label_key,
                    component: "Text".into(),
                    props: json!({ "text": label.into() }).as_object().unwrap().clone(),
                    slots: vec![],
                }],
                data_path: None,
            }],
        });
        Ok(())
    }

    fn input(
        &mut self,
        component: &str,
        name: &str,
        default: Value,
        bind: Option<ModelBinding>,
        mut props: JsonObject,
        key: Option<String>,
    ) -> Result<()> {
        let path = if let Some(binding) = bind {
            if !self.model_tokens.contains(&binding.token) {
                return Err(Error::Declaration(
                    "bind must be a reference returned by local.bind()".into(),
                ));
            }
            binding.path
        } else {
            self.uncontrolled_inputs.insert(name.into());
            self.data["inputs"]
                .as_object_mut()
                .unwrap()
                .entry(name)
                .or_insert(default);
            format!("/inputs/{}", escape_pointer(name))
        };
        props.insert("value".into(), json!({ "path": path }));
        self.append(
            component,
            props,
            key.or_else(|| Some(format!("input:{name}"))),
        )?;
        Ok(())
    }
    pub fn text_field(&mut self, name: &str, options: TextFieldOptions) -> Result<()> {
        validate_control(&options.default, &options.bind)?;
        let mut props = json!({ "label": options.label })
            .as_object()
            .unwrap()
            .clone();
        optional(&mut props, "variant", options.variant);
        optional(&mut props, "validationRegexp", options.validation_regexp);
        self.input(
            "TextField",
            name,
            options.default.unwrap_or_default().into(),
            options.bind,
            props,
            options.key,
        )
    }
    pub fn check_box(&mut self, name: &str, options: CheckBoxOptions) -> Result<()> {
        validate_control(&options.default, &options.bind)?;
        self.input(
            "CheckBox",
            name,
            options.default.unwrap_or(false).into(),
            options.bind,
            json!({ "label": options.label })
                .as_object()
                .unwrap()
                .clone(),
            options.key,
        )
    }
    pub fn choice_picker(
        &mut self,
        name: &str,
        options_data: Vec<Value>,
        options: ChoicePickerOptions,
    ) -> Result<()> {
        validate_control(&options.default, &options.bind)?;
        let mut props = json!({ "options": options_data })
            .as_object()
            .unwrap()
            .clone();
        optional_value(&mut props, "label", options.label);
        optional(&mut props, "variant", options.variant);
        optional(&mut props, "displayStyle", options.display_style);
        if let Some(value) = options.filterable {
            props.insert("filterable".into(), value.into());
        }
        self.input(
            "ChoicePicker",
            name,
            json!(options.default.unwrap_or_default()),
            options.bind,
            props,
            options.key,
        )
    }
    pub fn slider(
        &mut self,
        name: &str,
        minimum: f64,
        maximum: f64,
        options: SliderOptions,
    ) -> Result<()> {
        validate_control(&options.default, &options.bind)?;
        let mut props = json!({ "min": number_value(minimum), "max": number_value(maximum) })
            .as_object()
            .unwrap()
            .clone();
        optional_value(&mut props, "label", options.label);
        self.input(
            "Slider",
            name,
            number_value(options.default.unwrap_or(minimum)),
            options.bind,
            props,
            options.key,
        )
    }
    pub fn date_time_input(&mut self, name: &str, options: DateTimeInputOptions) -> Result<()> {
        validate_control(&options.default, &options.bind)?;
        let mut props = Map::new();
        optional_value(&mut props, "label", options.label);
        optional_value(&mut props, "min", options.min);
        optional_value(&mut props, "max", options.max);
        if let Some(value) = options.enable_date {
            props.insert("enableDate".into(), value.into());
        }
        if let Some(value) = options.enable_time {
            props.insert("enableTime".into(), value.into());
        }
        self.input(
            "DateTimeInput",
            name,
            options.default.unwrap_or_default().into(),
            options.bind,
            props,
            options.key,
        )
    }

    pub fn build(mut self) -> Declaration {
        self.data["inputs"]
            .as_object_mut()
            .unwrap()
            .retain(|name, _| self.uncontrolled_inputs.contains(name));
        Declaration {
            ir_version: "2".into(),
            surface_id: self.surface_id,
            catalog_id: self.catalog_id,
            root: self.root,
            data: self.data,
            locals: self.locals,
            required_capabilities: self.required_capabilities,
        }
    }
}

fn local_path(key: &str, path: &str) -> String {
    format!("/$local/{}{path}", escape_pointer(key))
}
fn resolve_local_values(value: Value) -> Value {
    match value {
        Value::Object(mut object)
            if object.get("$local").and_then(Value::as_str).is_some()
                && object.get("path").and_then(Value::as_str).is_some() =>
        {
            let key = object
                .remove("$local")
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned();
            let path = object.remove("path").unwrap().as_str().unwrap().to_owned();
            json!({ "path": local_path(&key, &path) })
        }
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key, resolve_local_values(value)))
                .collect(),
        ),
        Value::Array(values) => {
            Value::Array(values.into_iter().map(resolve_local_values).collect())
        }
        value => value,
    }
}

fn optional(map: &mut JsonObject, key: &str, value: Option<String>) {
    if let Some(value) = value {
        map.insert(key.into(), value.into());
    }
}
fn validate_control<T>(default: &Option<T>, bind: &Option<ModelBinding>) -> Result<()> {
    if default.is_some() && bind.is_some() {
        return Err(Error::Declaration(
            "default and bind cannot be used together".into(),
        ));
    }
    Ok(())
}
fn optional_value(map: &mut JsonObject, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value);
    }
}
fn escape_pointer(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}
fn number_value(value: f64) -> Value {
    if value.fract() == 0.0 && value >= i64::MIN as f64 && value <= i64::MAX as f64 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}
