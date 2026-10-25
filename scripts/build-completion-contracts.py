"""Generate the public contract inventory from the fixed packaged operation registry."""
from pathlib import Path
import json
import sys

root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root / "export-runtime"))
from flowly_completions import registry

operations, contracts = registry()
if set(operations) != set(contracts):
    raise ValueError("Every registered operation must have one public contract")
entries = []
for name in sorted(operations):
    contract = contracts[name]
    if not isinstance(contract, dict) or not isinstance(contract.get("description"), str):
        raise ValueError("Missing operation description: " + name)
    entries.append({**contract, "id": name})
target = root / "domain" / "completion-operations.json"
target.write_text(json.dumps({"version": 1, "operations": entries}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"operations": len(entries)}))
