import os
import socket
import unittest
os.environ["OTEL_SDK_DISABLED"] = "true"
os.environ["CREWAI_TELEMETRY_DISABLED"] = "true"
os.environ["CREWAI_TRACING_ENABLED"] = "false"
original_connect = socket.socket.connect
def only_loopback(self, address):
    if isinstance(address, tuple) and address[0] in ("127.0.0.1", "::1"):
        return original_connect(self, address)
    raise AssertionError("외부 네트워크 금지")
socket.socket.connect = only_loopback
from crewai import BaseLLM
from main import build_crew, procurement_lookup


class FixtureLLM(BaseLLM):
    def __init__(self, responses):
        super().__init__(model="offline-fixture", temperature=0)
        self.responses = list(responses)
        self.seen = []

    def call(self, messages, tools=None, callbacks=None, available_functions=None, **kwargs):
        self.seen.append(str(messages))
        if not self.responses:
            raise AssertionError("예상한 모델 호출 횟수를 초과했습니다.")
        return self.responses.pop(0)

    def supports_function_calling(self):
        return False

    def get_context_window_size(self):
        return 8192


class CrewTests(unittest.TestCase):
    def test_native_delegation_and_read_only_tool(self):
        coordinator = FixtureLLM([
            'Thought: 근거를 담당자에게 요청합니다.\nAction: Delegate work to coworker\nAction Input: {"task":"PO-104 납기를 조회하고 지연 일수를 알려주세요", "context":"PO-104 구매 검토", "coworker":"납기 조사자"}',
            "Thought: 위임 결과를 확인했습니다.\nFinal Answer: PO-104는 계약보다 3일 늦습니다. 대체 발주 전 계약 변경과 공급사 확약을 확인하세요. 발주하지 않았습니다.",
        ])
        researcher = FixtureLLM([
            'Thought: 등록 자료를 조회합니다.\nAction: procurement_lookup\nAction Input: {"order_id":"PO-104"}',
            "Thought: 조회를 확인했습니다.\nFinal Answer: PO-104 계약 납기 2026-11-05, 예상 납기 2026-11-08, 지연 3일입니다.",
        ])
        result = build_crew(coordinator, researcher).kickoff(inputs={"question": "PO-104 납기 확인"})
        self.assertIn("3일", result.raw)
        self.assertEqual(len(coordinator.seen), 2)
        self.assertEqual(len(researcher.seen), 2)
        self.assertIn("2026-11-08", researcher.seen[-1])

    def test_unknown_order_fails(self):
        with self.assertRaises(ValueError):
            procurement_lookup.run(order_id="unknown")

if __name__ == "__main__":
    unittest.main()
