"""Historical test state only; use the exported Python store, never patch its read results."""
import importlib.util
import json
from pathlib import Path
import socket
import sys

def deny(*args, **kwargs):
    raise AssertionError("External network blocked while preparing historical test state")

socket.socket.connect = deny
socket.create_connection = deny
root = Path.cwd().resolve()
state = (root / sys.argv[1]).resolve()
if not state.is_relative_to(root) or state == root:
    raise ValueError("Fixture state must remain within the extracted test package")
spec = importlib.util.spec_from_file_location("historical_fixture_runner", root / "runner.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
manifest = json.loads((root / "workflow.json").read_text(encoding="utf-8"))
scenario = json.loads((root / ".scenario.json").read_text(encoding="utf-8"))
seeds = scenario.get("memorySeeds", [])
if len(seeds) > 20:
    raise ValueError("Too many historical memory fixtures")
store = runner.Store(state)
with store.locked():
    for index, seed in enumerate(seeds):
        store.memory({"ownerId": manifest["owner"]["userId"], "workflowId": manifest["workflow"]["id"],
                      "operationId": "historical-fixture-" + str(index), "action": "write",
                      "key": seed["key"], "value": seed["value"]})
print(json.dumps({"seeded": len(seeds)}))
