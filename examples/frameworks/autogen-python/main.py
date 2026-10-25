"""AutoGen AgentChat의 분석자-검토자 대화. 도구는 로컬 읽기 전용이다."""
import argparse
import asyncio
import json
import os
from pathlib import Path

from autogen_agentchat.agents import AssistantAgent
from autogen_agentchat.teams import RoundRobinGroupChat
from autogen_agentchat.conditions import TextMentionTermination


def incident_lookup(incident_id: str) -> str:
    """등록된 장애 ID의 측정값과 조치 상태를 조회한다. 변경하지 않는다."""
    records = json.loads(Path(__file__).with_name("fixtures.json").read_text(encoding="utf-8"))["incidents"]
    if incident_id not in records:
        raise ValueError("등록되지 않은 장애 ID입니다.")
    return json.dumps(records[incident_id], ensure_ascii=False)


def build_team(analyst_model, reviewer_model):
    analyst = AssistantAgent("analyst", model_client=analyst_model, tools=[incident_lookup],
        reflect_on_tool_use=True, max_tool_iterations=2,
        system_message="장애 ID를 incident_lookup으로 조회한 뒤 측정된 사실과 제안 조치를 분리해 한국어 조치안을 작성하세요. 시스템을 변경하지 않습니다.")
    reviewer = AssistantAgent("reviewer", model_client=reviewer_model,
        system_message="분석자의 근거를 검토하세요. 검증되지 않은 복구를 완료라고 하지 마세요. 확인할 측정 항목을 제시하고 REVIEW_COMPLETE로 마무리하세요.")
    return RoundRobinGroupChat([analyst, reviewer], termination_condition=TextMentionTermination("REVIEW_COMPLETE", sources=["reviewer"]), max_turns=4)


async def run_live(question, key, model):
    from autogen_ext.models.openai import OpenAIChatCompletionClient
    client = OpenAIChatCompletionClient(model=model, api_key=key, timeout=30, max_retries=0, max_tokens=800,
        model_info={"vision": False, "function_calling": True, "json_output": True, "family": "unknown", "structured_output": True})
    try:
        result = await asyncio.wait_for(build_team(client, client).run(task=question), timeout=120)
        return {"answer": str(result.messages[-1].content), "stop_reason": result.stop_reason,
                "messages": [{"source": message.source, "type": message.type} for message in result.messages]}
    finally:
        await client.close()


def main():
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).with_name(".env"), override=False)
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="PAY-17 결제 지연의 현재 조치와 검증 항목")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    ready = bool(os.getenv("OPENAI_API_KEY") and os.getenv("FLOWLY_MODEL"))
    if args.check:
        print(json.dumps({"state": "configured_not_connected" if ready else "unconfigured", "provider_called": False}))
        return
    if not ready:
        raise SystemExit("미설정: .env에 OPENAI_API_KEY와 FLOWLY_MODEL을 직접 등록하세요.")
    print(json.dumps(asyncio.run(run_live(args.input, os.environ["OPENAI_API_KEY"], os.environ["FLOWLY_MODEL"])), ensure_ascii=False))

if __name__ == "__main__":
    main()
