use serde_json::{Map, Value};

use crate::{Error, Result};

/// Materializes one shared A2UI stream so a renderer can join without replaying history.
///
/// Mirrors `packages/sdk/typescript/src/node/snapshot.ts` and
/// `packages/sdk/python/src/omochi_ui/snapshot.py`; `spec/fixtures/snapshot.json` pins the
/// three implementations to the same output. Only messages the Runtime itself produced
/// are applied, so the four v0.9 message kinds are matched structurally.
#[derive(Debug, Default)]
pub struct A2uiSnapshot {
    // Insertion order is part of the contract, so surfaces and components are kept in
    // vectors rather than a sorted map.
    surfaces: Vec<(String, SurfaceSnapshot)>,
}

#[derive(Debug)]
struct SurfaceSnapshot {
    create: Value,
    components: Vec<(String, Value)>,
    data: Option<Value>,
    /// A surface whose data model was deleted at the root still needs one replay message.
    has_data: bool,
}

fn is_array_index(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && (value == "0" || !value.starts_with('0'))
}

fn pointer_parts(path: &str) -> Result<Vec<String>> {
    let Some(rest) = path.strip_prefix('/') else {
        return Err(Error::Protocol(format!(
            "data model path must start with \"/\": {path:?}"
        )));
    };
    Ok(rest
        .split('/')
        .map(|part| part.replace("~1", "/").replace("~0", "~"))
        .collect())
}

fn parse_index(part: &str) -> Result<usize> {
    if !is_array_index(part) {
        return Err(Error::Protocol(format!(
            "array data model path segment must be an index: {part:?}"
        )));
    }
    part.parse::<usize>()
        .map_err(|_| Error::Protocol(format!("data model array index is out of range: {part:?}")))
}

/// A write past the end leaves JSON nulls, matching a sparse array on the wire.
fn grow(items: &mut Vec<Value>, index: usize) {
    while items.len() <= index {
        items.push(Value::Null);
    }
}

fn is_container(value: &Value) -> bool {
    value.is_object() || value.is_array()
}

fn descend<'a>(current: &'a mut Value, part: &str, next_is_index: bool) -> Result<&'a mut Value> {
    let placeholder = if next_is_index {
        Value::Array(Vec::new())
    } else {
        Value::Object(Map::new())
    };
    match current {
        Value::Array(items) => {
            let index = parse_index(part)?;
            grow(items, index);
            let slot = &mut items[index];
            if !is_container(slot) {
                *slot = placeholder;
            }
            Ok(slot)
        }
        Value::Object(map) => {
            let slot = map.entry(part.to_owned()).or_insert(Value::Null);
            if !is_container(slot) {
                *slot = placeholder;
            }
            Ok(slot)
        }
        _ => Err(Error::Protocol(
            "data model path traverses a non-container value".into(),
        )),
    }
}

fn assign(current: &mut Value, last: &str, value: Option<Value>) -> Result<()> {
    match current {
        Value::Array(items) => {
            let index = parse_index(last)?;
            match value {
                Some(next) => {
                    grow(items, index);
                    items[index] = next;
                }
                None => {
                    if index < items.len() {
                        items.remove(index);
                    }
                }
            }
        }
        Value::Object(map) => match value {
            Some(next) => {
                map.insert(last.to_owned(), next);
            }
            None => {
                map.remove(last);
            }
        },
        _ => {
            return Err(Error::Protocol(
                "data model path traverses a non-container value".into(),
            ));
        }
    }
    Ok(())
}

fn update_at_pointer(
    root: Option<Value>,
    path: &str,
    value: Option<Value>,
) -> Result<Option<Value>> {
    if path.is_empty() || path == "/" {
        return Ok(value);
    }
    let parts = pointer_parts(path)?;
    let mut result = match root {
        Some(existing) if is_container(&existing) => existing,
        _ if is_array_index(&parts[0]) => Value::Array(Vec::new()),
        _ => Value::Object(Map::new()),
    };
    {
        let mut current = &mut result;
        for index in 0..parts.len() - 1 {
            let next_is_index = is_array_index(&parts[index + 1]);
            current = descend(current, &parts[index], next_is_index)?;
        }
        assign(current, &parts[parts.len() - 1], value)?;
    }
    Ok(Some(result))
}

fn body<'a>(message: &'a Value, key: &str) -> Option<&'a Map<String, Value>> {
    message.get(key).and_then(Value::as_object)
}

fn surface_id(message: &Value, key: &str) -> Result<String> {
    body(message, key)
        .and_then(|object| object.get("surfaceId"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| Error::Protocol(format!("{key} must contain a string surfaceId")))
}

impl A2uiSnapshot {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn apply(&mut self, message: &Value) -> Result<()> {
        if message.get("createSurface").is_some() {
            let id = surface_id(message, "createSurface")?;
            if self.index_of(&id).is_some() {
                return Err(Error::Protocol(format!("surface already exists: {id:?}")));
            }
            self.surfaces.push((
                id,
                SurfaceSnapshot {
                    create: message.clone(),
                    components: Vec::new(),
                    data: None,
                    has_data: false,
                },
            ));
        } else if message.get("updateComponents").is_some() {
            let id = surface_id(message, "updateComponents")?;
            let components = body(message, "updateComponents")
                .and_then(|object| object.get("components"))
                .and_then(Value::as_array)
                .cloned()
                .ok_or_else(|| {
                    Error::Protocol("updateComponents must contain components".into())
                })?;
            let surface = self.surface_mut(&id)?;
            for component in components {
                let component_id = component
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| Error::Protocol("component must contain a string id".into()))?
                    .to_owned();
                match surface
                    .components
                    .iter_mut()
                    .find(|(existing, _)| existing == &component_id)
                {
                    Some(slot) => slot.1 = component,
                    None => surface.components.push((component_id, component)),
                }
            }
        } else if message.get("updateDataModel").is_some() {
            let id = surface_id(message, "updateDataModel")?;
            let update = body(message, "updateDataModel")
                .cloned()
                .unwrap_or_else(Map::new);
            let path = update
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("/")
                .to_owned();
            let value = update.get("value").cloned();
            let surface = self.surface_mut(&id)?;
            surface.data = update_at_pointer(surface.data.take(), &path, value)?;
            surface.has_data = true;
        } else if message.get("deleteSurface").is_some() {
            let id = surface_id(message, "deleteSurface")?;
            self.surfaces.retain(|(existing, _)| existing != &id);
        } else {
            return Err(Error::Protocol(
                "expected an A2UI v0.9 server message".into(),
            ));
        }
        Ok(())
    }

    pub fn messages(&self) -> Vec<Value> {
        let mut messages = Vec::new();
        for (id, surface) in &self.surfaces {
            messages.push(surface.create.clone());
            if !surface.components.is_empty() {
                messages.push(serde_json::json!({
                    "version": "v0.9",
                    "updateComponents": {
                        "surfaceId": id,
                        "components": surface
                            .components
                            .iter()
                            .map(|(_, component)| component.clone())
                            .collect::<Vec<_>>(),
                    },
                }));
            }
            if surface.has_data {
                let mut update = Map::new();
                update.insert("surfaceId".into(), Value::String(id.clone()));
                update.insert("path".into(), Value::String("/".into()));
                if let Some(data) = &surface.data {
                    update.insert("value".into(), data.clone());
                }
                messages.push(serde_json::json!({ "version": "v0.9", "updateDataModel": update }));
            }
        }
        messages
    }

    pub fn surface_ids(&self) -> Vec<String> {
        self.surfaces.iter().map(|(id, _)| id.clone()).collect()
    }

    fn index_of(&self, id: &str) -> Option<usize> {
        self.surfaces
            .iter()
            .position(|(existing, _)| existing == id)
    }

    fn surface_mut(&mut self, id: &str) -> Result<&mut SurfaceSnapshot> {
        let index = self
            .index_of(id)
            .ok_or_else(|| Error::Protocol(format!("unknown surface: {id:?}")))?;
        Ok(&mut self.surfaces[index].1)
    }
}
