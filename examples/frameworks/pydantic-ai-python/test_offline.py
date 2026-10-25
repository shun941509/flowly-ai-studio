import socket
import unittest
original_connect = socket.socket.connect
def only_loopback(self, address):
    if isinstance(address, tuple) and address[0] in ("127.0.0.1", "::1"):
        return original_connect(self, address)
    raise AssertionError("외부 네트워크 금지")
socket.socket.connect = only_loopback
from pydantic import ValidationError
from pydantic_ai import models
from pydantic_ai.messages import ModelResponse, ToolCallPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.usage import UsageLimits
from main import build_agent, ExpenseDecision, ExpenseInput, parse_expense
models.ALLOW_MODEL_REQUESTS = False


class ExpenseTests(unittest.TestCase):
    def test_tool_then_validated_structured_result(self):
        calls = []
        def respond(messages, info):
            calls.append(messages)
            if len(calls) == 1:
                return ModelResponse(parts=[ToolCallPart("policy_lookup", {"category": "meal"})])
            return ModelResponse(parts=[ToolCallPart(info.output_tools[0].name, {"category":"meal", "amount":45000, "limit":30000, "over_limit":True, "needs_review":True, "policy_id":"EXP-01"})])
        result = build_agent(FunctionModel(respond)).run_sync("식비 45000원, 영수증 있음", deps=ExpenseInput(amount=45000, receipt=True), usage_limits=UsageLimits(request_limit=5))
        self.assertTrue(result.output.needs_review)
        self.assertIn("EXP-01", str(calls[-1]))
        self.assertEqual(len(calls), 2)

    def test_negative_amount_fails_schema(self):
        with self.assertRaises(ValidationError):
            ExpenseDecision(category="meal", amount=-1, limit=30000, over_limit=False, needs_review=False, policy_id="EXP-01")

    def test_wrong_limit_is_rejected(self):
        def wrong(_messages, info):
            return ModelResponse(parts=[ToolCallPart(info.output_tools[0].name, {"category":"meal", "amount":45000, "limit":99999, "over_limit":False, "needs_review":False, "policy_id":"EXP-01"})])
        with self.assertRaises(Exception):
            build_agent(FunctionModel(wrong)).run_sync("식비 45000원", deps=ExpenseInput(amount=45000, receipt=True), usage_limits=UsageLimits(request_limit=3))

    def test_explicit_input_contract(self):
        self.assertFalse(parse_expense("식비 20000원, 영수증 없음").receipt)
        with self.assertRaises(ValueError):
            parse_expense("금액은 알아서 처리")

if __name__ == "__main__":
    unittest.main()
