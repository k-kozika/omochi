use std::path::PathBuf;

use omochi_ui::A2uiSnapshot;
use serde_json::{Value, json};

fn fixture() -> Value {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../spec/fixtures/snapshot.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn materializes_the_shared_snapshot_fixture() {
    let fixture = fixture();
    let mut snapshot = A2uiSnapshot::new();
    for message in fixture["messages"].as_array().unwrap() {
        snapshot.apply(message).unwrap();
    }
    assert_eq!(
        Value::Array(snapshot.messages()),
        fixture["snapshot"].clone()
    );
}

#[test]
fn rejects_duplicate_and_unknown_surfaces() {
    let mut snapshot = A2uiSnapshot::new();
    let create =
        json!({ "version": "v0.9", "createSurface": { "surfaceId": "main", "catalogId": "test" } });
    snapshot.apply(&create).unwrap();
    assert!(snapshot.apply(&create).is_err());
    assert!(
        snapshot
            .apply(&json!({ "version": "v0.9", "updateComponents": { "surfaceId": "other", "components": [] } }))
            .is_err()
    );
    assert_eq!(snapshot.surface_ids(), vec!["main".to_string()]);
}

#[test]
fn keeps_a_root_deletion_visible_in_the_replay() {
    let mut snapshot = A2uiSnapshot::new();
    snapshot
        .apply(&json!({ "version": "v0.9", "createSurface": { "surfaceId": "main", "catalogId": "test" } }))
        .unwrap();
    snapshot
        .apply(&json!({ "version": "v0.9", "updateDataModel": { "surfaceId": "main", "path": "/", "value": { "a": 1 } } }))
        .unwrap();
    snapshot
        .apply(
            &json!({ "version": "v0.9", "updateDataModel": { "surfaceId": "main", "path": "/" } }),
        )
        .unwrap();
    assert_eq!(
        snapshot.messages().last().unwrap().clone(),
        json!({ "version": "v0.9", "updateDataModel": { "surfaceId": "main", "path": "/" } })
    );
}
