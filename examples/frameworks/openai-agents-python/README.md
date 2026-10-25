# 도구로 근거를 확인하는 배송 안내 · OpenAI Agents SDK

프로젝트 `shipment-lookup`의 Python SDK 변형입니다. TypeScript와 같은 업무이므로 프로젝트 수에 중복 가산하지 않습니다. 실제 SDK Agent/Runner가 읽기 전용 함수 도구를 선택하고 결과를 받아 답변합니다. MCP 서버는 필요하지 않습니다.

```powershell
# Python 3.11 이상, 검증 환경 Python 3.13
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.lock.txt
.venv/Scripts/python.exe -X utf8 -m unittest -v test_offline.py
Copy-Item .env.example .env
.venv/Scripts/python.exe -X utf8 main.py check
.venv/Scripts/python.exe -X utf8 main.py run "주문 ORD-2026-001의 배송 상태와 예상일을 알려주세요"
```

`.env`에 본인 `OPENAI_API_KEY`, 사용 가능한 `FLOWLY_MODEL`을 로컬 편집기로 입력하세요. 함수 호출 모델이 필요합니다. 키를 웹·채팅·Git·워크플로 JSON에 넣지 마세요. `check`는 설정 존재만 확인합니다. `run`은 실제 OpenAI API를 호출하며 비용이 발생할 수 있습니다. 미설정이면 중단합니다. 추적 업로드를 껐습니다.

배송 파일은 직접 작성한 CC0-1.0 합성 자료입니다. 주문 ORD-2026-001은 운송 중, 예정일 2026-10-24, 근거 SHIP-001입니다. 파일 스냅샷을 실서비스 최신 상태로 주장하지 않습니다. 주문 번호 형식을 검사하고 없는 번호는 not_found입니다. 외부 변경은 없습니다.

한도는 4,000자 입력·4턴·도구 3회·전체 60초·출력 800토큰/턴입니다. SDK Model을 명시적으로 주입한 오프라인 테스트 2개에서 도구 실행과 다음 턴 결과 전달, 미존재/형식 오류를 검증했습니다. 실제 모델 호출은 0회이며 실제 AI 품질은 미검증입니다. 사용자 키·모델명 설정과 실계정 검증이 남았습니다.

공식 문서: https://openai.github.io/openai-agents-python/models/
