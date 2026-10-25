"""기준일에 유효한 규정 버전만 검색하는 LlamaIndex temporal RAG."""
import argparse
from datetime import date
import json
import os
import re
from pathlib import Path
import nltk

for required_data in ("corpora/stopwords", "tokenizers/punkt", "tokenizers/punkt_tab"):
    try:
        nltk.data.find(required_data)
    except LookupError:
        raise SystemExit("미설정: python setup_data.py로 LlamaIndex의 NLTK 언어 자료를 먼저 설치하세요.") from None

from llama_index.core.retrievers import BaseRetriever
from llama_index.core.schema import NodeWithScore, TextNode
from llama_index.core.query_engine import RetrieverQueryEngine
from llama_index.core import set_global_tokenizer

# UTF-8 바이트 수는 이 예제에서 컨텍스트 분할을 보수적으로 제한한다.
# 모델 토큰 과금 수를 계산하는 토크나이저로 사용하지 않는다.
set_global_tokenizer(lambda text: list(text.encode("utf-8")))


def parse_request(question: str):
    if question.lstrip().startswith("{"):
        try:
            request = json.loads(question)
            as_of = request.get("as_of")
            query = request.get("question")
            if not isinstance(as_of, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", as_of) or not isinstance(query, str) or not query.strip():
                return None, ""
            return date.fromisoformat(as_of), query.strip()
        except (ValueError, AttributeError, TypeError):
            return None, ""
    dates = re.findall(r"(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)", question)
    if len(dates) != 1:
        return None, question
    try:
        return date.fromisoformat(dates[0]), question
    except ValueError:
        return None, question


class PolicyRetriever(BaseRetriever):
    def __init__(self, effective_on: date):
        super().__init__()
        if not isinstance(effective_on, date):
            raise ValueError("유효한 기준일이 필요합니다.")
        documents = json.loads(Path(__file__).with_name("fixtures.json").read_text(encoding="utf-8"))["documents"]
        # 검색 점수를 계산하기 전에 날짜 범위 밖의 버전을 제외한다.
        self.documents = [document for document in documents
            if date.fromisoformat(document["effectiveFrom"]) <= effective_on
            and (document["effectiveUntil"] is None or effective_on <= date.fromisoformat(document["effectiveUntil"]))]

    def _retrieve(self, query_bundle):
        query = query_bundle.query_str.lower()
        matched = []
        for document in self.documents:
            hits = sum(keyword in query for keyword in document["keywords"])
            if hits:
                node = TextNode(text=document["text"], id_=document["id"], metadata={
                    "source_id": document["id"], "title": document["title"],
                    "effectiveFrom": document["effectiveFrom"],
                    "effectiveUntil": document["effectiveUntil"] or "종료일 미지정"})
                matched.append(NodeWithScore(node=node, score=hits / len(document["keywords"])))
        return sorted(matched, key=lambda item: item.score, reverse=True)[:2]


def answer_question(question, llm):
    effective_on, query = parse_request(question)
    if effective_on is None:
        return {"state": "clarification_required", "answer": "어느 날짜 기준의 규정이 필요한가요? as_of에 YYYY-MM-DD 기준일과 question에 질문을 입력해 주세요. 날짜가 하나 포함된 일반 문장도 가능합니다.", "citations": [], "model_called": False}
    retriever = PolicyRetriever(effective_on)
    if not retriever.retrieve(query):
        return {"state": "no_evidence", "effectiveOn": effective_on.isoformat(), "answer": "해당 기준일에 유효한 관련 규정 근거가 없습니다. 담당자 확인이 필요합니다.", "citations": [], "model_called": False}
    if llm is None:
        raise ValueError("미설정: 답변 생성을 위한 모델이 필요합니다.")
    query_engine = RetrieverQueryEngine.from_args(retriever, llm=llm, response_mode="compact")
    response = query_engine.query(f"{effective_on.isoformat()} 기준: {query}" + " 제공된 유효 버전만 근거로 한국어로 답변하고 source_id와 effectiveFrom/effectiveUntil 적용 기간을 인용하세요. 다른 시점 규정은 혼합하지 마세요.")
    citations = [{"id": source.node.metadata["source_id"], "effectiveFrom": source.node.metadata["effectiveFrom"],
        "effectiveUntil": source.node.metadata["effectiveUntil"], "text": source.node.text, "score": source.score} for source in response.source_nodes]
    return {"state": "answered", "effectiveOn": effective_on.isoformat(), "answer": str(response), "citations": citations, "model_called": True}


def main():
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).with_name(".env"), override=False)
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default='{"as_of":"2026-10-22","question":"반차 신청 마감은 언제인가요?"}')
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    ready = bool(os.getenv("OPENAI_API_KEY") and os.getenv("FLOWLY_MODEL"))
    if args.check:
        print(json.dumps({"state": "configured_not_connected" if ready else "unconfigured", "provider_called": False}))
        return
    effective_on, query = parse_request(args.input)
    if effective_on is None or not PolicyRetriever(effective_on).retrieve(query):
        print(json.dumps(answer_question(args.input, None), ensure_ascii=False))
        return
    if not ready:
        raise SystemExit("미설정: .env에 OPENAI_API_KEY와 FLOWLY_MODEL을 직접 등록하세요.")
    from llama_index.llms.openai import OpenAI
    llm = OpenAI(model=os.environ["FLOWLY_MODEL"], api_key=os.environ["OPENAI_API_KEY"], timeout=30, max_retries=0, max_tokens=800)
    print(json.dumps(answer_question(args.input, llm), ensure_ascii=False))

if __name__ == "__main__":
    main()
