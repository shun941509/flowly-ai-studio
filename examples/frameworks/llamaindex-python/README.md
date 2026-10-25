# 적용일에 맞는 규정 버전 확인 · LlamaIndex Python

같은 반차 규정에 이전 버전과 개정 버전이 있을 때 **사용자가 지정한 기준일**에 유효한 문서만 검색합니다. 일반 문서 질의응답과 달리 검색 점수 계산과 모델 호출 전에 적용 기간을 검사하여 오래된 규정의 혼입을 막습니다.

이 프로젝트는 LlamaIndex의 실제 `BaseRetriever`, `TextNode`, `RetrieverQueryEngine`을 사용합니다. Flowly 웹에서는 모델을 호출하거나 키를 받지 않습니다.

## 입력과 결과

기본 입력은 Flowly 예제와 같은 JSON 계약입니다.

```json
{"as_of":"2026-10-22","question":"반차 신청 마감은 언제인가요?"}
```

`2026-10-22 기준 반차 신청 마감은 언제인가요?`처럼 날짜를 한 개 포함한 문장도 가능합니다. JSON의 기준일이 빠졌거나 날짜가 잘못되었으면 추가 질문으로 끝납니다. 일반 문장에 날짜가 여러 개 있으면 임의로 선택하지 않습니다.

| 기준일 | 검색 대상 | 반차 신청 마감 |
| --- | --- | --- |
| 2026-01-01~2026-09-30 | HR-02 | 2영업일 전 18시 |
| 2026-10-01 이후 | HR-02-new | 전 영업일 18시 |

결과는 `effectiveOn`, 답변, 실제 검색된 문서 ID·적용 시작/종료일·원문을 담은 `citations`를 포함합니다. 다른 기간 문서는 모델 문맥에 전달하지 않습니다. 해당 기간에 관련 근거가 없으면 `no_evidence`, 기준일 확인이 필요하면 `clarification_required`이며 두 경우 모두 모델 호출이 없습니다.

## 준비와 실행

Python 3.11 이상에서 별도 가상 환경을 만듭니다. Windows에서는 `.venv/Scripts/python`, macOS/Linux에서는 `.venv/bin/python`을 사용하세요.

```powershell
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python setup_data.py
Copy-Item .env.example .env
# 로컬 편집기로 .env의 OPENAI_API_KEY와 FLOWLY_MODEL을 직접 지정
.venv/Scripts/python main.py --check
.venv/Scripts/python main.py
.venv/Scripts/python main.py --input '2026-09-30 기준 반차 신청 마감은 언제인가요?'
```

키와 모델이 없으면 답변 생성을 `미설정`으로 중단합니다. `--check`는 설정 존재 확인이며 연결 성공을 뜻하지 않습니다. 기준일 누락이나 근거 없음은 모델이 필요하지 않아 키 없이도 안내합니다. NLTK 언어 자료는 `setup_data.py`를 명시적으로 실행할 때만 공식 배포처에서 설치합니다.

자료는 직접 작성한 CC0 합성 규정이며 실제 회사 정책이 아닙니다. 외부 MCP나 실계정 자료를 연결한 것으로 표시하지 않습니다. 날짜 범위의 양 끝은 포함하고 종료일이 없으면 이후에도 유효한 것으로 처리합니다. 이 예제는 반차 마감 규정을 조회하며 주말·공휴일을 반영한 실제 신청 마감 날짜를 계산하지 않습니다.

## 실행 범위와 검증

로컬 키워드 검색 top2와 compact 답변 합성을 사용합니다. 벡터 검색이나 GraphRAG 구현으로 표시하지 않습니다. UTF-8 바이트 수를 컨텍스트 분할의 보수적인 기준으로 사용하며 과금 토큰 수를 추정하지 않습니다.

Flowly 변형도 같은 기준일·질문 계약을 사용합니다. 이 Python native 변형에서는 날짜 필터를 검색기 생성 시 결정적으로 적용합니다. Flowly 그래프 변형의 모델 기반 규정 선택과 구현 방법이 다릅니다.

```powershell
.venv/Scripts/python -X utf8 test_offline.py
```

테스트는 실제 설치한 SDK에 결정적인 응답을 주입하고 외부 socket 연결을 차단합니다(Windows asyncio 내부 loopback만 허용). 이전/새 규정 선택, 경계 날짜, 날짜 누락·오류·중복, 관련 근거 없음과 기간 밖 조회를 검사합니다. 테스트 응답은 `test_offline.py`에만 있으며 `main.py`의 실제 실행으로 대체하지 않습니다.

실제 모델 품질과 제공자 연결은 미검증입니다. SDK 버전은 `requirements.txt`, 검증 기록은 `verification.json`에 있습니다. 내보낸 자료는 복사본이므로 웹 원본의 이후 공유 철회가 소급 적용되지 않습니다.

## 공식 문서

- [LlamaIndex 사용자 정의 LLM](https://developers.llamaindex.ai/python/framework/module_guides/models/llms/usage_custom/)
- [LlamaIndex 검색기](https://developers.llamaindex.ai/python/framework/module_guides/querying/retriever/)
