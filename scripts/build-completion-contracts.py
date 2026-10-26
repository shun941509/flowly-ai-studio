# 고정 작업 레지스트리에서 공개 도구 계약 목록을 생성한다. 작업과 계약의 일대일 대응을 확인하며 작업 자체를 실행하지 않는다.
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
