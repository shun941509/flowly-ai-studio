"""Run the ZIP's actual CLI with network blocked and test-only HTTP responses."""
import importlib.util
import json
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

def deny(*args, **kwargs):
    raise AssertionError("External network blocked in workflow scenario tests")

socket.socket.connect = deny
socket.create_connection = deny
spec = importlib.util.spec_from_file_location("exported_workflow", Path.cwd() / "runner.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
scenario = json.loads(Path(".scenario.json").read_text(encoding="utf-8"))
manifest = json.loads(Path("workflow.json").read_text(encoding="utf-8"))
lock = threading.Lock()

def entries(path):
    return [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line] if Path(path).exists() else []

def log(path, value):
    with Path(path).open("a", encoding="utf-8") as file:
        file.write(json.dumps(value, ensure_ascii=False) + "\n")

def test_post(self, url, body, headers, timeout_ms, *args, **kwargs):
    if url == "https://api.openai.com/v1/embeddings":
        data = []
        for index, text in enumerate(body["input"]):
            reply = next((r for r in scenario.get("embeddingReplies", []) if r["text"] == text), None)
            assert reply is not None, "Unexpected embedding input"
            data.append({"index": index, "embedding": reply["vector"]})
        with lock:
            log(".embedding-calls.jsonl", {"texts": body["input"]})
        return {"data": data, "model": body["model"], "usage": {"total_tokens": 2}}, {}
    if url != "https://api.openai.com/v1/responses":
        assert any(c["endpoint"] == url for c in manifest["connections"]), "Unexpected external URL"
        if body["method"] == "initialize":
            return {"jsonrpc": "2.0", "id": body["id"], "result": {"protocolVersion": "2025-11-25", "capabilities": {"tools": {}}}}, {}
        if body["method"] == "notifications/initialized":
            return {}, {}
        assert body["method"] == "tools/call", "Unexpected MCP method"
        name, arguments = body["params"]["name"], body["params"]["arguments"]
        reply = next((r for r in scenario.get("toolReplies", []) if r["name"] == name and r["args"] == arguments), None)
        assert reply is not None, "Unexpected MCP arguments"
        with lock:
            count = sum(c["name"] == name and c["args"] == arguments for c in entries(".tool-calls.jsonl"))
            assert count < reply.get("count", 1), "MCP call repeated beyond test allowance"
            log(".tool-calls.jsonl", {"name": name, "args": arguments})
        local_result = None
        if reply.get("localOperation"):
            local = subprocess.run([sys.executable, "-I", "-X", "utf8", str(Path(__file__).with_name("p4-local-tools.py"))], input=json.dumps({"operation": reply["localOperation"], "arguments": arguments, "scenario": scenario["name"]}), text=True, capture_output=True, timeout=15, check=True)
            local_result = json.loads(local.stdout)
        if reply.get("error") == "disconnect":
            raise OSError("Test-only disconnected MCP response")
        result = {"isError": True, "content": [{"type": "text", "text": "Test tool error"}]} if reply.get("error") == "tool_error" else (local_result if local_result is not None else reply["result"])
        return {"jsonrpc": "2.0", "id": body["id"], "result": result}, {}
    payload = json.loads(next(m["content"] for m in body["input"] if m.get("role") == "user"))
    # Reserve a reply occurrence atomically; independent Agents can share a marker.
    # Simulated latency below stays outside the lock so their execution overlaps.
    with lock:
        previous = entries(".model-calls.jsonl")
        reply = next((r for r in scenario.get("modelReplies", []) if r["match"] in json.dumps(payload, ensure_ascii=False, separators=(",", ":")) and (not r.get("occurrence") or r["occurrence"] == sum(c["match"] == r["match"] for c in previous) + 1)), None)
        assert reply is not None, "Unexpected model step: " + payload["instruction"]
        mapped = json.dumps(payload["input"], ensure_ascii=False, separators=(",", ":"))
        for required in reply.get("inputContains", []):
            assert required in mapped, "Missing model input: " + required
        for excluded in reply.get("inputExcludes", []):
            assert excluded not in mapped, "Disallowed model input: " + excluded
        observations = json.dumps([m for m in body["input"] if m.get("type") == "function_call_output"], ensure_ascii=False)
        for required in reply.get("observationContains", []):
            assert required in observations, "Missing actual tool observation: " + required
        assert sorted(t["name"] for t in body.get("tools", [])) == sorted(reply.get("allowedTools", [])), "Unexpected allowed model tools"
        occurrence = sum(c["match"] == reply["match"] for c in previous) + 1
        log(".model-calls.jsonl", {"match": reply["match"], "occurrence": occurrence})
        log(".model-timing.jsonl", {"match": reply["match"], "occurrence": occurrence, "phase": "start", "at": time.time() * 1000})
    if reply.get("delayMs"):
        time.sleep(reply["delayMs"] / 1000)
    with lock:
        log(".model-timing.jsonl", {"match": reply["match"], "occurrence": occurrence, "phase": "end", "at": time.time() * 1000})
    call = reply.get("toolCall")
    output = [{"type": "function_call", "name": call["name"], "arguments": json.dumps(call["args"], ensure_ascii=False), "call_id": call.get("callId", f"{reply['match']}-{occurrence}")}] if call else [{"type":"message","content":[{"type":"output_text","text":reply["text"]}]}]
    return {"status":"completed","usage":{"total_tokens":3},"output":output}, {}

def checked_post(*args, **kwargs):
    try:
        return test_post(*args, **kwargs)
    except AssertionError as error:
        with lock:
            log(".boundary-errors.jsonl", {"message": str(error)})
        raise

runner.Http.post = checked_post
raise SystemExit(runner.main(sys.argv[1:]))
