"""smolagents JSON 도구 호출 방식. 임의 Python 코드를 실행하지 않는다."""
import argparse
import json
import os
from pathlib import Path
from smolagents import ToolCallingAgent, tool


@tool
def stock_gap(sku: str) -> dict:
    """상품의 재주문 부족분을 로컬 재고에서 계산한다. 발주하지 않는다.

    Args:
        sku: 등록된 상품 코드.
    """
    stock = json.loads(Path(__file__).with_name("fixtures.json").read_text(encoding="utf-8"))["stock"]
    if sku not in stock:
        raise ValueError("등록되지 않은 상품 코드입니다.")
    item = stock[sku]
    return {"sku": sku, **item, "shortage": max(0, item["safety"] - item["on_hand"] - item["incoming"]), "order_placed": False}


def build_agent(model):
    return ToolCallingAgent(tools=[stock_gap], model=model, max_steps=4, max_tool_threads=1,
        add_base_tools=False, verbosity_level=0,
        instructions="반드시 stock_gap으로 재고를 조회하고 부족분을 한국어로 설명하세요. 발주는 실행하지 않습니다. 근거 없는 수량을 만들지 마세요.")


def main():
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).with_name(".env"), override=False)
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="SKU-8 재주문에 필요한 수량을 알려줘")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    ready = bool(os.getenv("OPENAI_API_KEY") and os.getenv("FLOWLY_MODEL"))
    if args.check:
        print(json.dumps({"state": "configured_not_connected" if ready else "unconfigured", "provider_called": False}))
        return
    if not ready:
        raise SystemExit("미설정: .env에 OPENAI_API_KEY와 FLOWLY_MODEL을 직접 등록하세요.")
    from smolagents import OpenAIServerModel
    model = OpenAIServerModel(model_id=os.environ["FLOWLY_MODEL"], api_key=os.environ["OPENAI_API_KEY"],
        client_kwargs={"timeout": 30, "max_retries": 0}, max_tokens=800)
    print(json.dumps({"answer": str(build_agent(model).run(args.input))}, ensure_ascii=False))

if __name__ == "__main__":
    main()
