use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub type JsonObject = Map<String, Value>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Slot {
    pub path: String,
    pub kind: String,
    #[serde(default)]
    pub nodes: Vec<Node>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub key: String,
    pub component: String,
    #[serde(default)]
    pub props: JsonObject,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub slots: Vec<Slot>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Declaration {
    pub ir_version: String,
    pub surface_id: String,
    pub catalog_id: String,
    pub root: Node,
    pub data: JsonObject,
    pub locals: BTreeMap<String, LocalDeclaration>,
    pub required_capabilities: BTreeSet<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDeclaration {
    pub initial: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_key: Option<Value>,
}
