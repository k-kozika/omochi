import json
import unittest
from pathlib import Path

from omochi_ui import A2uiSnapshot

FIXTURE = json.loads((Path(__file__).resolve().parents[4] / "spec" / "fixtures" / "snapshot.json").read_text())


class SnapshotTest(unittest.TestCase):
    def test_materializes_the_shared_fixture(self) -> None:
        snapshot = A2uiSnapshot()
        for message in FIXTURE["messages"]:
            snapshot.apply(message)
        self.assertEqual(snapshot.messages(), FIXTURE["snapshot"])

    def test_rejects_duplicate_and_unknown_surfaces(self) -> None:
        snapshot = A2uiSnapshot()
        snapshot.apply({"version": "v0.9", "createSurface": {"surfaceId": "main", "catalogId": "test"}})
        with self.assertRaises(ValueError):
            snapshot.apply({"version": "v0.9", "createSurface": {"surfaceId": "main", "catalogId": "test"}})
        with self.assertRaises(ValueError):
            snapshot.apply({"version": "v0.9", "updateComponents": {"surfaceId": "other", "components": []}})

    def test_keeps_a_root_deletion_visible_in_the_replay(self) -> None:
        snapshot = A2uiSnapshot()
        snapshot.apply({"version": "v0.9", "createSurface": {"surfaceId": "main", "catalogId": "test"}})
        snapshot.apply({"version": "v0.9", "updateDataModel": {"surfaceId": "main", "path": "/", "value": {"a": 1}}})
        snapshot.apply({"version": "v0.9", "updateDataModel": {"surfaceId": "main", "path": "/"}})
        self.assertEqual(snapshot.messages()[-1], {"version": "v0.9", "updateDataModel": {"surfaceId": "main", "path": "/"}})


if __name__ == "__main__":
    unittest.main()
