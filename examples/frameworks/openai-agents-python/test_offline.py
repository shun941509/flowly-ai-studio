"""OFFLINE: 실제 SDK Runner + 명시적으로 주입한 모델. 실제 AI 결과 검사가 아님."""
import json
import socket
import unittest
from unittest.mock import patch
from agents import Model, ModelResponse, Usage
from openai.types.responses import ResponseFunctionToolCall, ResponseOutputMessage, ResponseOutputText
from main import run_shipment, lookup_shipment

class OfflineModel(Model):
    def __init__(self):
        self.inputs = []

    async def get_response(self, system_instructions, input, *args, **kwargs):
        self.inputs.append(input)
        if len(self.inputs) == 1:
            output = [ResponseFunctionToolCall(type='function_call', id='fc_1', call_id='call_1', name='shipment_lookup', arguments='{"order_id":"ORD-2026-001"}', status='completed')]
        else:
            output = [ResponseOutputMessage(type='message', id='msg_1', role='assistant', status='completed', content=[ResponseOutputText(type='output_text', text='운송 중, 예정일 2026-10-24, 근거 SHIP-001', annotations=[])])]
        return ModelResponse(output=output, usage=Usage(requests=1, input_tokens=10, output_tokens=10, total_tokens=20), response_id=None)

    async def stream_response(self, *args, **kwargs):
        raise RuntimeError('오프라인 검사에서 스트리밍을 사용하지 않습니다.')
        yield  # make this an async iterator, as the SDK contract requires

class OfflineTests(unittest.IsolatedAsyncioTestCase):
    async def test_tool_feedback(self):
        model = OfflineModel()
        called = []
        with patch.object(socket.socket, 'connect', side_effect=AssertionError('검사 중 네트워크 금지')):
            result = await run_shipment('ORD-2026-001 조회', model, called.append)
        self.assertEqual(called, ['ORD-2026-001'])
        self.assertEqual(result['toolCalls'], 1)
        self.assertIn('SHIP-001', result['answer'])
        self.assertIn('2026-10-24', json.dumps(model.inputs[1], ensure_ascii=False))

    def test_missing_and_invalid(self):
        self.assertEqual(lookup_shipment('ORD-2026-999')['status'], 'not_found')
        with self.assertRaises(ValueError):
            lookup_shipment('../secret')

if __name__ == '__main__':
    unittest.main()
