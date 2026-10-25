# 접근 권한 문의 라우팅 · LangGraph Python

조건 분기로 관련 정책을 조회하고 근거 없는 문의는 담당자에게 전달합니다.

이 프로젝트는 LangGraph의 실제 Python SDK를 사용합니다. Flowly 웹에서는 실행하거나 키를 받지 않습니다. Node.js에서 Python을 감싸는 구현을 해당 프레임워크의 Node native 구현으로 표시하지 않습니다.

## 준비와 실행

Python 3.11 이상에서 이 폴더만 별도의 가상 환경에 설치합니다. Windows에서는 `.venv/Scripts/python`, macOS/Linux에서는 `.venv/bin/python`을 사용하세요.

```powershell
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
Copy-Item .env.example .env
# 로컬 편집기로 .env의 두 빈 값을 직접 지정
.venv/Scripts/python main.py --check
.venv/Scripts/python main.py --input "급여 파일 접근 권한이 없어요"
```

키와 모델이 없으면 `미설정`으로 종료합니다. `--check`는 설정 존재만 확인하며 연결 성공을 뜻하지 않습니다. 모델은 본인 계정에서 사용 가능한 도구 호출 지원 모델명을 선택하세요. `--input` 실행 시만 실제 모델 API를 호출하며 비용이 발생할 수 있습니다. 제공된 fixtures.json은 직접 작성한 CC0 합성 업무 자료입니다. 실제 외부 서비스나 실계정 자료를 연결한 것으로 표시하지 않습니다.

## 결과와 경계

기대 계약: ACC-01 근거와 관리자 승인 요청 안내 또는 근거 없는 문의 전달.

최대 8 그래프 단계, 모델 2회, 요청당 30초/800 토큰. 도구 선택 대신 명시적 조건 분기를 보여 줍니다.

도구는 내보낸 로컬 fixtures.json만 읽습니다. MCP 서버 연결이나 외부 쓰기는 이 대표 예제에 포함되지 않습니다. 예제 출력은 모델에 따라 달라질 수 있으며 알려진 제한/오류를 성공처럼 숨기지 않습니다. 자료는 내보낸 복사본이어서 원래 웹 자료의 공유 철회가 소급 적용되지 않습니다.

## 검증

```powershell
.venv/Scripts/python -X utf8 test_offline.py
```

테스트는 **실제 설치한 SDK**의 흐름/도구/검증 기능에 결정적인 응답을 주입하며 외부 socket 연결을 금지합니다(Windows asyncio 내부 loopback만 허용). 가짜 응답은 test_offline.py에만 있고 main.py는 미설정일 때 테스트 답변으로 대체하지 않습니다. `manifest.json`의 static/offline/live는 서로 다른 검증 상태입니다. 실제 제공자 호출 검증은 하지 않았습니다.

SDK 버전은 requirements.txt에 고정합니다. 이 대표 예제는 전체 Flowly 런타임의 지속 승인·체크포인트·쓰기를 그대로 제공하는 범용 내보내기가 아닙니다. 별도 시스템으로 운영하기 전 필요한 정책과 저장소를 추가해야 합니다.

## 공식 문서

- https://docs.langchain.com/oss/python/langgraph/quickstart

2026-10-22 검증: Python 3.13.3에서 SDK 오프라인 테스트 3개, 키 없는 설정 확인/실행 중단 2개 통과. manifest 파일만 임시 폴더에 복사하여 검증했습니다. 실제 모델/MCP API 호출은 0회입니다. 근거는 verification.json입니다.
