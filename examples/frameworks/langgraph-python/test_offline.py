"""실제 SDK, 주입 응답. 네트워크 금지; 실제 AI 검증이 아님."""
import socket
import unittest
from unittest.mock import patch

def deny_network(*args, **kwargs):
    raise AssertionError("오프라인 테스트의 네트워크 접근 금지")

socket.socket.connect = deny_network
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from main import build_graph

class GraphTests(unittest.TestCase):
    def test_access_route_and_evidence(self):
        result = build_graph(FakeListChatModel(responses=["access", "[ACC-01] 관리자 승인을 요청하세요."])).invoke({"question": "급여 파일 권한"})
        self.assertEqual(result["category"], "access")
        self.assertEqual(result["evidence"]["id"], "ACC-01")
        self.assertIn("ACC-01", result["answer"])

    def test_unknown_route_has_no_evidence(self):
        result = build_graph(FakeListChatModel(responses=["other"])).invoke({"question": "점심 메뉴"})
        self.assertNotIn("evidence", result)
        self.assertIn("근거가 없습니다", result["answer"])

    def test_bad_classification_rejected(self):
        with self.assertRaises(ValueError):
            build_graph(FakeListChatModel(responses=["admin"])).invoke({"question": "권한"})

if __name__ == "__main__":
    unittest.main()
