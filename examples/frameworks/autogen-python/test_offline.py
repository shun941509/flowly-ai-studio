import asyncio
import json
import socket
import unittest
original_connect = socket.socket.connect
def only_loopback(self, address):
    if isinstance(address, tuple) and address[0] in ("127.0.0.1", "::1"):
        return original_connect(self, address)
    raise AssertionError("외부 네트워크 금지")
socket.socket.connect = only_loopback
from autogen_core import FunctionCall
from autogen_core.models import CreateResult, RequestUsage
from autogen_ext.models.replay import ReplayChatCompletionClient
from main import build_team, incident_lookup

class ChatTests(unittest.TestCase):
    def test_tool_result_reaches_reviewer(self):
        analyst = ReplayChatCompletionClient([
            CreateResult(finish_reason="function_calls", content=[FunctionCall(id="lookup1", name="incident_lookup", arguments='{"incident_id":"PAY-17"}')], usage=RequestUsage(prompt_tokens=1, completion_tokens=1), cached=False),
            "PAY-17의 p95가 2200ms입니다. 재시도 큐 확인을 제안하며 복구는 미확인입니다.",
        ], model_info={"vision": False, "function_calling": True, "json_output": False, "family": "unknown", "structured_output": False})
        reviewer = ReplayChatCompletionClient(["복구는 미확인입니다. p95와 큐 길이를 다시 측정하세요. REVIEW_COMPLETE"])
        result = asyncio.run(build_team(analyst, reviewer).run(task="PAY-17 점검"))
        self.assertEqual(result.messages[-1].source, "reviewer")
        self.assertIn("미확인", result.messages[-1].content)
        events = [m for m in result.messages if m.type == "ToolCallExecutionEvent"]
        self.assertEqual(len(events), 1)
        self.assertIn("2200", events[0].content[0].content)

    def test_unknown_incident_fails(self):
        with self.assertRaises(ValueError):
            incident_lookup("../secret")

if __name__ == "__main__":
    unittest.main()
