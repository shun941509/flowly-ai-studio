"""CrewAI 역할 위임. 합성 구매 자료 조회만 허용하고 발주는 실행하지 않는다."""
import argparse
import json
import os
from pathlib import Path

os.environ["OTEL_SDK_DISABLED"] = "true"
os.environ["CREWAI_TELEMETRY_DISABLED"] = "true"
os.environ["CREWAI_TRACING_ENABLED"] = "false"

from crewai import Agent, Crew, Process, Task
from crewai.tools import tool


@tool("procurement_lookup")
def procurement_lookup(order_id: str) -> str:
    """구매 요청 ID의 계약 납기와 예상 납기를 읽기 전용으로 조회한다."""
    orders = json.loads(Path(__file__).with_name("fixtures.json").read_text(encoding="utf-8"))["orders"]
    if order_id not in orders:
        raise ValueError("등록되지 않은 구매 요청입니다.")
    return json.dumps(orders[order_id], ensure_ascii=False)


def build_crew(coordinator_llm, researcher_llm):
    researcher = Agent(role="납기 조사자", goal="구매 자료에서 납기 위험의 근거를 찾는다", backstory="등록된 구매 자료만 조회하는 담당자",
        llm=researcher_llm, tools=[procurement_lookup], allow_delegation=False, max_iter=4, max_retry_limit=0,
        max_execution_time=45, verbose=False, allow_code_execution=False)
    coordinator = Agent(role="구매 조정자", goal="조사자에게 근거 조사를 위임하고 구매 담당자 확인 목록을 만든다", backstory="직접 발주하지 않는 구매 검토 담당자",
        llm=coordinator_llm, allow_delegation=True, max_iter=4, max_retry_limit=0, max_execution_time=60,
        verbose=False, allow_code_execution=False)
    task = Task(description="{question}. 반드시 납기 조사자에게 근거 조회를 위임하세요. 조달 변경을 실행하지 말고 지연 일수와 담당자가 확인할 사항을 구분하세요.",
        expected_output="구매 요청 ID, 근거 납기와 지연 일수, 대체 발주 전 확인 목록을 담은 한국어 검토 결과", agent=coordinator)
    return Crew(agents=[researcher, coordinator], tasks=[task], process=Process.sequential,
        memory=False, cache=False, verbose=False, tracing=False)


def main():
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).with_name(".env"), override=False)
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="PO-104의 납기 위험과 구매 담당자 확인 목록")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    ready = bool(os.getenv("OPENAI_API_KEY") and os.getenv("FLOWLY_MODEL"))
    if args.check:
        print(json.dumps({"state": "configured_not_connected" if ready else "unconfigured", "provider_called": False}))
        return
    if not ready:
        raise SystemExit("미설정: .env에 OPENAI_API_KEY와 FLOWLY_MODEL을 직접 등록하세요.")
    from crewai import LLM
    llm = LLM(model="openai/" + os.environ["FLOWLY_MODEL"], api_key=os.environ["OPENAI_API_KEY"], timeout=30, max_tokens=800)
    result = build_crew(llm, llm).kickoff(inputs={"question": args.input})
    print(json.dumps({"answer": result.raw}, ensure_ascii=False))

if __name__ == "__main__":
    main()
