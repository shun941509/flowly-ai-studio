# 문의 접수 분류와 전달 초안 · Dify

프로젝트 `ticket-intake`. Dify에 가져올 앱 DSL과 Node.js/Python API 클라이언트입니다. 두 언어 클라이언트는 별도 프로젝트로 집계하지 않습니다. 이 패키지 자체는 Dify 플랫폼을 대체하는 독립 SDK가 아닙니다.

1. `workflow.yml`을 Dify에서 가져옵니다. JSON 문법은 YAML 1.2의 부분집합입니다. DSL 0.7.0 형식을 사용합니다.
2. 본인 Dify에서 OpenAI 제공자 플러그인을 설치하고 모델 키를 비밀 설정에 등록합니다. 모델 노드의 gpt-4.1-mini는 선택 예시이며 사용 가능한 모델로 변경하세요. 플러그인 바이너리·자격 증명은 패키지에 없습니다.
3. Dify에서 워크플로를 검사하고 발행한 뒤 앱 API 키를 발급합니다.
4. `.env.example`을 `.env`로 복사해 로컬 편집기로 DIFY_API_BASE(`/v1` 포함), DIFY_API_KEY, DIFY_USER를 입력합니다. DIFY_USER는 운영 사용자를 구별할 안정적인 식별자입니다.

```powershell
# Node.js 22.13 이상, Python 3.11 이상, 추가 패키지 없음
node --test offline.test.mjs
node client.mjs check
node client.mjs run "로그인 후 결제 영수증 다운로드가 실패합니다"
python -X utf8 client.py check
python -X utf8 client.py run "로그인 후 결제 영수증 다운로드가 실패합니다"
```

`check`는 로컬 설정 존재만 확인합니다. `run`은 실제 Dify API를 호출하며 발행한 Dify가 모델을 호출합니다. Flowly 웹에서는 호출하지 않습니다. 키를 웹·채팅·Git·워크플로 JSON에 넣지 마세요. Dify에서 모델 비용이 발생할 수 있습니다. HTTP 리디렉션·자동 재시도를 거절합니다.

반환 계약은 category(billing/account/technical/other), urgency(normal/high), summary(한국어 한 문장)입니다. 예제는 billing/normal입니다. 전체 서비스 장애나 명시적 계정 탈취는 high이며 분류·요약 초안까지만 만듭니다. 외부 티켓 생성이나 답장 전송은 없습니다. `fixtures.json`은 직접 작성한 CC0-1.0 합성 자료입니다. 입력 4,000자, 클라이언트 90초, 모델 600토큰, 순환 없는 3노드입니다.

정적 DSL 연결과 두 클라이언트의 실제 로컬 HTTP 요청·응답, 실패/출력 오류 거절 테스트 2개를 통과했습니다. **실제 Dify 인스턴스 가져오기·제공자 플러그인 호환·모델 호출은 미검증**입니다. 실제 OpenAI/Dify/MCP 호출 0회. 플랫폼 설치·모델 설정·발행·API 키와 실제 가져오기 검증이 남았습니다.

공식 API: https://docs.dify.ai/en/api-reference/workflow-runs/run-workflow

DSL 구조 참고: https://github.com/langgenius/dify/blob/main/api/tests/fixtures/workflow/basic_llm_chat_workflow.yml
