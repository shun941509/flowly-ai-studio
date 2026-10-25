"""Execute the actual extracted runner; provider/network are test-only injected."""
import importlib.util
import contextlib
import io
import json
import socket
from pathlib import Path

def denied(*args, **kwargs):
    raise AssertionError("Network forbidden in catalog contract test")
socket.socket.connect = denied
socket.create_connection = denied
spec = importlib.util.spec_from_file_location("exported_runner", Path.cwd()/"runner.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
contract = json.loads(Path("example-contract.json").read_text(encoding="utf-8"))
marker = "CATALOG_INPUT_" + contract["id"]
evidence = "EVIDENCE:" + contract["id"]
package, package_hash = runner.load_package(Path.cwd()/"workflow.json")
fixture = package["resources"][0]
data_schema = next((node.get("outputSchema",{}).get("properties",{}).get("data") for node in package["workflow"]["definition"]["nodes"] if node["type"] == "agent"), None)
def sample(schema, text):
    if schema["type"] == "object":
        return {key:sample(value,text) for key,value in schema.get("properties",{}).items()}
    if schema["type"] == "array":
        return []
    return 1 if schema["type"] == "number" else False if schema["type"] == "boolean" else text

def test_post(self, url, body, headers, timeout_ms, **kwargs):
        assert url == "https://api.openai.com/v1/responses"
        assert not body.get("tools")
        payload = json.loads(next(m["content"] for m in body["input"] if m.get("role") == "user"))
        mapped = json.dumps(payload["input"], ensure_ascii=False)
        assert marker in mapped, "Original input lost in graph mapping"
        assert any(isinstance(value,str) and (fixture["content"] in value or fixture["id"] in value) for value in payload["input"].values()) or evidence in mapped, "Fixture evidence lost in graph mapping"
        assert contract["problem"] in payload["instruction"], "Project-specific instruction missing"
        text = f"TEST_ADAPTER {marker} {evidence}"
        if data_schema:
            text = '{"unexpected":"TEST_ADAPTER"}' if "CATALOG_BAD_SCHEMA" in mapped else json.dumps(sample(data_schema,text))
        return {"status":"completed","usage":{"total_tokens":3},"output":[{"type":"message","content":[{"type":"output_text","text":text}]}]}, {}

# Exercise exported argparse, .env loading, actual provider request formatting,
# durable command decisions and resume; inject only the HTTP response boundary.
runner.Http.post = test_post
Path(".env").write_text("OPENAI_API_KEY=catalog-test-adapter-placeholder\nFLOWLY_MODEL=test-model\n", encoding="utf-8")
def cli(*args, expected=0):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        status = runner.main(list(args))
    assert status == expected, err.getvalue() or out.getvalue()
    return json.loads(out.getvalue())

run = cli("run", "--input-file", ".test-input.txt")
if run["status"] == "waiting_review":
    cli("accept", run["id"], run["reviews"][0]["id"])
    run = cli("resume", run["id"])
assert run["status"] == "succeeded", run.get("error")
assert marker in run["result"] and evidence in run["result"]
assert run["usage"]["toolCalls"] == 0
review_checked = False
if any(node["type"] == "review" for node in package["workflow"]["definition"]["nodes"]):
    denied_run = cli("run", "--input-file", ".test-input.txt")
    assert denied_run["status"] == "waiting_review"
    cli("reject", denied_run["id"], denied_run["reviews"][0]["id"])
    denied_run = cli("resume", denied_run["id"])
    assert denied_run["status"] == "succeeded"
    assert "거절" in denied_run["result"] and "TEST_ADAPTER" not in denied_run["result"]
    review_checked = True
schema_checked = False
if data_schema:
    Path(".test-invalid.txt").write_text(Path(".test-input.txt").read_text(encoding="utf-8")+"\nCATALOG_BAD_SCHEMA",encoding="utf-8")
    invalid = cli("run","--input-file",".test-invalid.txt", expected=1)
    assert invalid["status"] == "failed"
    schema_checked = True
print(json.dumps({"status":run["status"],"externalCalls":0,"testAdapter":True,"reviewRejected":review_checked,"schemaRejected":schema_checked}))
