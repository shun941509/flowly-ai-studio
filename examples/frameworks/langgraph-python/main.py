"""실제 LangGraph 조건 분기. CLI 실행만 제공자를 호출한다."""
import argparse
import json
import os
from pathlib import Path
from typing import TypedDict

os.environ["LANGCHAIN_TRACING_V2"] = "false"
os.environ["LANGSMITH_TRACING"] = "false"

from langgraph.graph import END, START, StateGraph
from langchain_core.messages import HumanMessage, SystemMessage


class State(TypedDict, total=False):
    question: str
    category: str
    evidence: dict
    answer: str


def build_graph(model):
    policies = json.loads(Path(__file__).with_name("fixtures.json").read_text(encoding="utf-8"))["policies"]

    def classify(state):
        response = model.invoke([
            SystemMessage(content="문의가 계정/파일 접근 문제면 access, 그 외면 other 한 단어만 출력하세요."),
            HumanMessage(content=state["question"]),
        ])
        category = str(response.content).strip().lower()
        if category not in ("access", "other"):
            raise ValueError("분류 결과 형식이 잘못되었습니다.")
        return {"category": category}

    def lookup(_state):
        return {"evidence": policies["access"]}

    def answer(state):
        response = model.invoke([
            SystemMessage(content="제공된 근거만 사용해 한국어로 안내하세요. 정책 ID를 인용하세요. 권한 변경을 실행하지 않습니다."),
            HumanMessage(content=json.dumps({"question": state["question"], "evidence": state["evidence"]}, ensure_ascii=False)),
        ])
        return {"answer": str(response.content)}

    graph = StateGraph(State)
    graph.add_node("classify", classify)
    graph.add_node("lookup", lookup)
    graph.add_node("answer", answer)
    graph.add_node("escalate", lambda _state: {"answer": "근거가 없습니다. 담당자에게 문의를 전달해 주세요."})
    graph.add_edge(START, "classify")
    graph.add_conditional_edges("classify", lambda state: state["category"], {"access": "lookup", "other": "escalate"})
    graph.add_edge("lookup", "answer")
    graph.add_edge("answer", END)
    graph.add_edge("escalate", END)
    return graph.compile()


def main():
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).with_name(".env"), override=False)
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="급여 파일 접근 권한이 없어요")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    ready = bool(os.getenv("OPENAI_API_KEY") and os.getenv("FLOWLY_MODEL"))
    if args.check:
        print(json.dumps({"state": "configured_not_connected" if ready else "unconfigured", "provider_called": False}))
        return
    if not ready:
        raise SystemExit("미설정: 내보낸 폴더의 .env에 OPENAI_API_KEY와 FLOWLY_MODEL을 직접 등록하세요.")
    from langchain_openai import ChatOpenAI
    model = ChatOpenAI(model=os.environ["FLOWLY_MODEL"], api_key=os.environ["OPENAI_API_KEY"], timeout=30, max_retries=0, max_tokens=800)
    result = build_graph(model).invoke({"question": args.input}, {"recursion_limit": 8})
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
