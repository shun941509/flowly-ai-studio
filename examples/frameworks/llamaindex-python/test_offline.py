import socket
import unittest
original_connect = socket.socket.connect
def only_loopback(self, address):
    if isinstance(address, tuple) and address[0] in ("127.0.0.1", "::1"):
        return original_connect(self, address)
    raise AssertionError("외부 네트워크 금지")
socket.socket.connect = only_loopback
from main import PolicyRetriever, answer_question
from llama_index.core.llms import CustomLLM, CompletionResponse, LLMMetadata
from llama_index.core.llms.callbacks import llm_completion_callback


class FixtureLLM(CustomLLM):
    expected_id: str
    expected_deadline: str
    excluded_text: str
    @property
    def metadata(self):
        return LLMMetadata(context_window=4096, num_output=200, model_name="offline-fixture")

    @llm_completion_callback()
    def complete(self, prompt, **kwargs):
        if self.expected_id not in prompt or self.expected_deadline not in prompt:
            raise AssertionError("해당 기준일의 검색 근거가 모델에 전달되지 않았습니다.")
        if self.excluded_text in prompt:
            raise AssertionError("다른 적용 기간의 규정이 모델에 전달되었습니다.")
        return CompletionResponse(text=f"[{self.expected_id}] {self.expected_deadline}. 검색된 문서의 적용 기간을 확인하세요.")

    @llm_completion_callback()
    def stream_complete(self, prompt, **kwargs):
        yield self.complete(prompt, **kwargs)


class RagTests(unittest.TestCase):
    def test_new_version_selected_before_search(self):
        result = answer_question('{"as_of":"2026-10-22","question":"반차 신청 마감은 언제인가요?"}', FixtureLLM(expected_id="HR-02-new", expected_deadline="전 영업일 18시", excluded_text="2영업일 전 18시"))
        self.assertTrue(result["model_called"])
        self.assertEqual([item["id"] for item in result["citations"]], ["HR-02-new"])
        self.assertEqual(result["citations"][0]["effectiveFrom"], "2026-10-01")
        self.assertEqual(result["citations"][0]["effectiveUntil"], "종료일 미지정")
        self.assertIn("전 영업일 18시", result["answer"])

    def test_previous_version_inclusive_end_date(self):
        result = answer_question("2026-09-30 기준 반차 신청 마감은 언제인가요?", FixtureLLM(expected_id="HR-02", expected_deadline="2영업일 전 18시", excluded_text="HR-02-new"))
        self.assertEqual([item["id"] for item in result["citations"]], ["HR-02"])
        self.assertEqual(result["citations"][0]["effectiveUntil"], "2026-09-30")
        self.assertIn("2영업일 전 18시", result["answer"])

    def test_missing_invalid_or_ambiguous_date_asks_clarification(self):
        for question in ["반차 신청 마감은 언제인가요?", "2026-02-30 기준 반차 마감", "2026-09-30과 2026-10-22 반차", '{"question":"반차"}', '{"as_of":"2026-02-30","question":"반차"}', '{"as_of":"2026-10-22","question":""}']:
            with self.subTest(question=question):
                result = answer_question(question, None)
                self.assertEqual(result["state"], "clarification_required")
                self.assertFalse(result["model_called"])

    def test_no_evidence_does_not_call_model(self):
        for question in ["2026-10-22 기준 암호화폐 시세", "2025-12-01 기준 반차 마감"]:
            with self.subTest(question=question):
                result = answer_question(question, None)
                self.assertEqual(result["state"], "no_evidence")
                self.assertFalse(result["model_called"])
                self.assertEqual(result["citations"], [])

if __name__ == "__main__":
    unittest.main()
