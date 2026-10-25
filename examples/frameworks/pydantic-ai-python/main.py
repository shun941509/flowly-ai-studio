"""Pydantic AI: 실제 도구 결과와 타입 검증을 결합한 출장비 판정."""
import argparse
import json
import os
import re
from pathlib import Path
from typing import Literal
from pydantic import BaseModel, Field
from pydantic_ai import Agent, ModelRetry, RunContext
from pydantic_ai.usage import UsageLimits


class ExpenseDecision(BaseModel):
    category: Literal["meal"]
    amount: int = Field(ge=0)
    limit: int = Field(gt=0)
    over_limit: bool
    needs_review: bool
    policy_id: Literal["EXP-01"]


class ExpenseInput(BaseModel):
    amount: int = Field(ge=0, le=999999999)
    receipt: bool


def parse_expense(question: str) -> ExpenseInput:
    match = re.fullmatch(r"식비\s*(\d{1,9})원,\s*영수증\s*(있음|없음)", question.strip())
    if not match:
        raise ValueError("입력 형식: 식비 45000원, 영수증 있음 (또는 없음)")
    return ExpenseInput(amount=int(match[1]), receipt=match[2] == "있음")


def policy_lookup(category: str) -> dict:
    """출장비 분류에 대한 읽기 전용 규정을 반환한다."""
    policies = json.loads(Path(__file__).with_name("fixtures.json").read_text(encoding="utf-8"))["policies"]
    if category not in policies:
        raise ValueError("지원하지 않는 경비 분류입니다.")
    return policies[category]


def build_agent(model):
    agent = Agent(model=model, deps_type=ExpenseInput, output_type=ExpenseDecision, retries=1,
        instructions="식비 금액과 영수증 여부를 읽고 policy_lookup을 호출하세요. 규정 금액 초과 또는 영수증 없음이면 needs_review=true입니다. 결제나 승인을 실행하지 마세요.")
    agent.tool_plain(policy_lookup)

    @agent.output_validator
    def validate(ctx: RunContext[ExpenseInput], output: ExpenseDecision) -> ExpenseDecision:
        policy = policy_lookup(output.category)
        if output.amount != ctx.deps.amount:
            raise ModelRetry("판정 금액은 사용자가 입력한 금액과 같아야 합니다.")
        if output.limit != policy["limit"] or output.over_limit != (output.amount > policy["limit"]):
            raise ModelRetry("금액과 실제 규정의 한도/초과 여부가 일치하지 않습니다.")
        if output.needs_review != (output.over_limit or not ctx.deps.receipt):
            raise ModelRetry("한도 초과 또는 영수증이 없는 경비는 검토가 필요합니다.")
        return output

    return agent


def main():
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).with_name(".env"), override=False)
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="식비 45000원, 영수증 있음")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    ready = bool(os.getenv("OPENAI_API_KEY") and os.getenv("FLOWLY_MODEL"))
    if args.check:
        print(json.dumps({"state": "configured_not_connected" if ready else "unconfigured", "provider_called": False}))
        return
    if not ready:
        raise SystemExit("미설정: .env에 OPENAI_API_KEY와 FLOWLY_MODEL을 직접 등록하세요.")
    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider
    from openai import AsyncOpenAI
    client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"], timeout=30, max_retries=0)
    model = OpenAIChatModel(os.environ["FLOWLY_MODEL"], provider=OpenAIProvider(openai_client=client))
    expense = parse_expense(args.input)
    result = build_agent(model).run_sync(args.input, deps=expense, model_settings={"max_tokens": 800}, usage_limits=UsageLimits(request_limit=5, tool_calls_limit=3, total_tokens_limit=4000))
    print(result.output.model_dump_json())

if __name__ == "__main__":
    main()
