"""사용자가 내보낸 환경에서만 실행하는 OpenAI Agents SDK 배송 조회."""
import asyncio
import json
import os
from pathlib import Path
import re
import sys
from agents import Agent, ModelSettings, RunConfig, Runner, function_tool, set_tracing_disabled

set_tracing_disabled(True)
RECORDS = json.loads((Path(__file__).parent / 'fixtures/shipments.json').read_text(encoding='utf-8'))

def configuration():
    env_file = Path('.env')
    if env_file.exists():
        for line in env_file.read_text(encoding='utf-8-sig').splitlines():
            key, sep, value = line.partition('=')
            if sep and key.strip() in ('OPENAI_API_KEY', 'FLOWLY_MODEL'):
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    missing = [key for key in ('OPENAI_API_KEY', 'FLOWLY_MODEL') if not os.environ.get(key, '').strip()]
    return {'ready': not missing, 'missing': missing, 'providerVerified': False}

def lookup_shipment(order_id: str):
    if not re.fullmatch(r'ORD-\d{4}-\d{3}', order_id):
        raise ValueError('주문 번호 형식 오류')
    return RECORDS.get(order_id, {'order_id': order_id, 'status': 'not_found', 'source_id': None})

async def run_shipment(question: str, model, on_lookup=None):
    if not question.strip() or len(question) > 4000:
        raise ValueError('입력은 1~4000자여야 합니다.')
    calls = []

    @function_tool
    def shipment_lookup(order_id: str) -> str:
        """읽기 전용 배송 스냅샷에서 주문 번호를 조회합니다."""
        if len(calls) >= 3:
            raise ValueError('조회 한도 초과')
        calls.append(order_id)
        if on_lookup:
            on_lookup(order_id)
        return json.dumps(lookup_shipment(order_id), ensure_ascii=False)

    agent = Agent(name='배송 상태 안내', model=model,
        instructions='질문의 주문 번호를 shipment_lookup으로 조회하고 상태, 예정일, source_id를 한국어로 답하세요. not_found는 조회 자료 없음으로 답하세요. 배송 상태 변경을 하지 않습니다.',
        tools=[shipment_lookup], model_settings=ModelSettings(max_tokens=800, parallel_tool_calls=False))
    result = await asyncio.wait_for(Runner.run(agent, question, max_turns=4, run_config=RunConfig(tracing_disabled=True)), timeout=60)
    if not calls:
        raise RuntimeError('필수 배송 조회 도구가 호출되지 않았습니다.')
    return {'answer': result.final_output, 'toolCalls': len(calls), 'source': 'local_snapshot'}

def main():
    config = configuration()
    if len(sys.argv) > 1 and sys.argv[1] == 'check':
        print(json.dumps(config, ensure_ascii=False))
        return
    if not config['ready']:
        print('미설정: ' + ', '.join(config['missing']) + '를 내보낸 폴더의 .env에 등록하세요.', file=sys.stderr)
        raise SystemExit(2)
    if len(sys.argv) < 2 or sys.argv[1] != 'run':
        raise SystemExit('사용법: python main.py check 또는 python main.py run 질문')
    question = ' '.join(sys.argv[2:]) or '주문 ORD-2026-001의 배송 상태와 예상일을 알려주세요'
    try:
        result = asyncio.run(run_shipment(question, os.environ['FLOWLY_MODEL']))
        print(json.dumps(result, ensure_ascii=False))
    except Exception:
        print('실행 실패: 설정, 모델 사용 권한 또는 입력을 확인하세요. 비밀 보호를 위해 제공자 원문은 표시하지 않습니다.', file=sys.stderr)
        raise SystemExit(1)

if __name__ == '__main__':
    main()
