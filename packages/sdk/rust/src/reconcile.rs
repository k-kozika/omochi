use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde_json::{Value, json};

use crate::{Declaration, Error, JsonObject, LocalDeclaration, Node, Result};

pub const PROTOCOL_VERSION: &str = "v0.9";

#[derive(Clone)]
struct Snapshot {
    catalog_id: String,
    components: BTreeMap<String, JsonObject>,
    data: JsonObject,
    locals: BTreeMap<String, LocalDeclaration>,
}

#[derive(Default)]
pub struct Reconciler {
    capabilities: BTreeSet<String>,
    surfaces: HashMap<String, Snapshot>,
}

impl Reconciler {
    pub fn new(capabilities: impl IntoIterator<Item = String>) -> Self {
        Self {
            capabilities: capabilities.into_iter().collect(),
            surfaces: HashMap::new(),
        }
    }

    pub fn render(&mut self, declaration: Declaration) -> Result<Vec<Value>> {
        let missing: Vec<_> = declaration
            .required_capabilities
            .difference(&self.capabilities)
            .cloned()
            .collect();
        if !missing.is_empty() {
            return Err(Error::Capability(missing.join(", ")));
        }
        let surface_id = declaration.surface_id.clone();
        let (component_values, components) = flatten(&declaration.root);
        let mut previous = self.surfaces.get(&surface_id).cloned();
        let mut messages = vec![];
        if previous
            .as_ref()
            .is_some_and(|value| value.catalog_id != declaration.catalog_id)
        {
            messages.push(json!({ "version": PROTOCOL_VERSION, "deleteSurface": { "surfaceId": surface_id } }));
            previous = None;
        }
        if let Some(previous) = previous {
            let changed: Vec<_> = component_values
                .iter()
                .filter(|(key, value)| previous.components.get(key) != Some(value))
                .map(|(_, value)| Value::Object(value.clone()))
                .collect();
            if !changed.is_empty() {
                messages.push(json!({ "version": PROTOCOL_VERSION, "updateComponents": { "surfaceId": surface_id, "components": changed } }));
            }
            for change in data_diff(
                &Value::Object(previous.data),
                &Value::Object(declaration.data.clone()),
                "",
            ) {
                let mut update = json!({ "surfaceId": surface_id, "path": change.path })
                    .as_object()
                    .unwrap()
                    .clone();
                if let Some(value) = change.value {
                    update.insert("value".into(), value);
                }
                messages.push(json!({ "version": PROTOCOL_VERSION, "updateDataModel": update }));
            }
            let local_keys: BTreeSet<_> = previous
                .locals
                .keys()
                .chain(declaration.locals.keys())
                .cloned()
                .collect();
            for key in local_keys {
                let before = previous.locals.get(&key);
                let after = declaration.locals.get(&key);
                if after.is_some()
                    && before.is_some()
                    && before.unwrap().reset_key == after.unwrap().reset_key
                {
                    continue;
                }
                let path = format!("/$local/{}", key.replace('~', "~0").replace('/', "~1"));
                let mut update = json!({ "surfaceId": surface_id, "path": path })
                    .as_object()
                    .unwrap()
                    .clone();
                if let Some(local) = after {
                    update.insert("value".into(), local.initial.clone());
                }
                messages.push(json!({ "version": PROTOCOL_VERSION, "updateDataModel": update }));
            }
        } else {
            let values: Vec<_> = component_values
                .iter()
                .map(|(_, value)| Value::Object(value.clone()))
                .collect();
            let mut initial_data = declaration.data.clone();
            initial_data.insert(
                "$local".into(),
                Value::Object(
                    declaration
                        .locals
                        .iter()
                        .map(|(key, local)| (key.clone(), local.initial.clone()))
                        .collect(),
                ),
            );
            messages.extend([
                json!({ "version": PROTOCOL_VERSION, "createSurface": { "surfaceId": surface_id, "catalogId": declaration.catalog_id, "sendDataModel": true } }),
                json!({ "version": PROTOCOL_VERSION, "updateComponents": { "surfaceId": surface_id, "components": values } }),
                json!({ "version": PROTOCOL_VERSION, "updateDataModel": { "surfaceId": surface_id, "path": "/", "value": initial_data } }),
            ]);
        }
        self.surfaces.insert(
            surface_id,
            Snapshot {
                catalog_id: declaration.catalog_id,
                components,
                data: declaration.data,
                locals: declaration.locals,
            },
        );
        Ok(messages)
    }

    pub fn close(&mut self, surface_id: &str) -> Vec<Value> {
        self.surfaces.remove(surface_id).map(|_| vec![json!({ "version": PROTOCOL_VERSION, "deleteSurface": { "surfaceId": surface_id } })]).unwrap_or_default()
    }

    pub fn sync_data(&mut self, surface_id: &str, data: JsonObject) {
        if let Some(surface) = self.surfaces.get_mut(surface_id) {
            surface.data = data;
        }
    }
}

fn flatten(root: &Node) -> (Vec<(String, JsonObject)>, BTreeMap<String, JsonObject>) {
    fn visit(node: &Node, ordered: &mut Vec<(String, JsonObject)>) -> String {
        let mut value = node.props.clone();
        value.insert("id".into(), node.key.clone().into());
        value.insert("component".into(), node.component.clone().into());
        for slot in &node.slots {
            let ids: Vec<_> = slot
                .nodes
                .iter()
                .map(|child| visit(child, ordered))
                .collect();
            let slot_value = match slot.kind.as_str() {
                "single" if ids.len() == 1 => Value::String(ids[0].clone()),
                "template" if ids.len() == 1 && slot.data_path.is_some() => {
                    json!({ "componentId": ids[0], "path": slot.data_path.as_ref().unwrap() })
                }
                "list" => json!(ids),
                _ => panic!("invalid slot {}", slot.path),
            };
            set_pointer(&mut value, &slot.path, slot_value);
        }
        ordered.push((node.key.clone(), value));
        node.key.clone()
    }

    fn set_pointer(target: &mut JsonObject, pointer: &str, value: Value) {
        let parts: Vec<_> = pointer
            .split('/')
            .skip(1)
            .map(|part| part.replace("~1", "/").replace("~0", "~"))
            .collect();
        assert!(
            !parts.is_empty(),
            "slot path must be a non-root JSON Pointer"
        );
        fn assign(current: &mut Value, parts: &[String], value: Value) {
            let part = &parts[0];
            if parts.len() == 1 {
                match current {
                    Value::Array(array) => {
                        let position: usize =
                            part.parse().expect("array slot path must use an index");
                        if array.len() <= position {
                            array.resize(position + 1, Value::Null);
                        }
                        array[position] = value;
                    }
                    Value::Object(object) => {
                        object.insert(part.clone(), value);
                    }
                    _ => unreachable!(),
                }
                return;
            }
            let array_next = parts[1].parse::<usize>().is_ok();
            let next = match current {
                Value::Array(array) => {
                    let position: usize = part.parse().expect("array slot path must use an index");
                    if array.len() <= position {
                        array.resize(position + 1, Value::Null);
                    }
                    if array[position].is_null() {
                        array[position] = if array_next { json!([]) } else { json!({}) };
                    }
                    &mut array[position]
                }
                Value::Object(object) => object
                    .entry(part)
                    .or_insert_with(|| if array_next { json!([]) } else { json!({}) }),
                _ => unreachable!(),
            };
            assign(next, &parts[1..], value);
        }
        let mut current = Value::Object(std::mem::take(target));
        assign(&mut current, &parts, value);
        *target = current.as_object().unwrap().clone();
    }
    let mut ordered = Vec::new();
    visit(root, &mut ordered);
    let lookup = ordered.iter().cloned().collect();
    (ordered, lookup)
}

struct Change {
    path: String,
    value: Option<Value>,
}

fn data_diff(before: &Value, after: &Value, path: &str) -> Vec<Change> {
    if before == after {
        return vec![];
    }
    if let (Some(left), Some(right)) = (before.as_object(), after.as_object()) {
        let keys: BTreeSet<_> = left.keys().chain(right.keys()).cloned().collect();
        return keys
            .into_iter()
            .flat_map(|key| {
                let child_path = format!("{path}/{}", key.replace('~', "~0").replace('/', "~1"));
                match (left.get(&key), right.get(&key)) {
                    (_, None) => vec![Change {
                        path: child_path,
                        value: None,
                    }],
                    (None, Some(value)) => vec![Change {
                        path: child_path,
                        value: Some(value.clone()),
                    }],
                    (Some(a), Some(b)) => data_diff(a, b, &child_path),
                }
            })
            .collect();
    }
    vec![Change {
        path: if path.is_empty() {
            "/".into()
        } else {
            path.into()
        },
        value: Some(after.clone()),
    }]
}
