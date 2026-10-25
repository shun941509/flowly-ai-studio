import socket
import unittest
original_connect = socket.socket.connect
def only_loopback(self, address):
    if isinstance(address, tuple) and address[0] in ("127.0.0.1", "::1"):
        return original_connect(self, address)
    raise AssertionError("외부 네트워크 금지")
socket.socket.connect = only_loopback
from smolagents import Model
from smolagents.models import ChatMessage, ChatMessageToolCall, ChatMessageToolCallFunction
from main import build_agent, stock_gap


class FixtureModel(Model):
    def __init__(self):
        super().__init__()
        self.calls = 0
        self.saw_result = False

    def generate(self, messages, **kwargs):
        self.calls += 1
        if self.calls == 1:
            tool_name, arguments = "stock_gap", {"sku": "SKU-8"}
        else:
            self.saw_result = "shortage" in str(messages) and "10" in str(messages)
            tool_name, arguments = "final_answer", {"answer": "SKU-8은 10개 부족합니다. 발주하지 않았습니다."}
        return ChatMessage(role="assistant", content=None, tool_calls=[ChatMessageToolCall(id=str(self.calls), type="function", function=ChatMessageToolCallFunction(name=tool_name, arguments=arguments))])


class InventoryTests(unittest.TestCase):
    def test_native_tool_loop(self):
        model = FixtureModel()
        result = build_agent(model).run("SKU-8 부족분")
        self.assertIn("10개", str(result))
        self.assertTrue(model.saw_result)
        self.assertEqual(model.calls, 2)

    def test_no_order_and_unknown_sku(self):
        self.assertFalse(stock_gap("SKU-8")["order_placed"])
        with self.assertRaises(ValueError):
            stock_gap("unknown")

if __name__ == "__main__":
    unittest.main()
