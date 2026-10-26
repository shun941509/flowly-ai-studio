/** 다운로드 파일의 비교 기준과 재가져오기 안내를 생성한다. SHA-256 일치는 서명 검증·코드 안전성 검토·실제 서비스 검증을 대신하지 않는다. */
import { resourceFileHash } from "../domain/resource-export";
/** Offline comparison only. Never loads configuration, runs imported code or contacts a service. */
export const projectCheckPython = `"""Compare downloaded files with the export snapshot (not a signature or code review)."""
import hashlib, json, sys
from pathlib import Path
root = Path(__file__).resolve().parent
try:
    baseline = json.loads((root / 'PROJECT_FILES.json').read_text(encoding='utf-8'))
    changed = []
    for name, expected in baseline['files'].items():
        path = (root / name).resolve()
        if not path.is_relative_to(root) or path.is_symlink() or not path.is_file():
            changed.append({'file': name, 'change': 'missing_or_unsafe'})
        elif hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            changed.append({'file': name, 'change': 'modified'})
    print(json.dumps({'status': 'changed' if changed else 'matched', 'changes': changed, 'externalCalls': 0,
        'next': 'Read ROUNDTRIP.md; import workflow.json into Flowly, rebind resources, validate and re-export. Runtime code changes remain separate.' if changed else 'Files match the export snapshot. This does not verify external services or business correctness.'}, ensure_ascii=False))
    sys.exit(1 if changed else 0)
except (OSError, ValueError, KeyError, TypeError) as error:
    print(json.dumps({'status':'failed', 'error':'Project file inventory is missing or invalid.'}))
    sys.exit(1)
`;

export const roundtripGuide = `# Cowork·Codex에서 수정하고 다시 가져오기

1. 수정 전 'python project-check.py'로 내보낸 파일의 기준과 일치하는지 확인합니다. 파일 해시는 비교 기준이며 서명이나 코드 안전성 보증이 아닙니다. .env·실행 기록·사용자 입력·결과는 비교하거나 웹에 전송하지 않습니다.
2. AI_START.md는 짧은 시작 지시, AI_PROMPT.md는 상세 지시입니다. Cowork·Codex에서 폴더를 열고 START_HERE.md·AGENTS.md·workflow.json·선택 Skill을 읽게 하세요. 자동 읽기 여부에 의존하지 마세요.
3. 사용자 요청 범위에서 workflow.json의 workflow.definition을 수정합니다. origin의 원본 식별 정보는 보존하고 CHANGELOG.md에 설계 변경과 실행기 코드 변경을 따로 기록합니다. 완료 조건·분기·입출력·허용 도구·승인·한도를 확인합니다.
4. 수정 후 project-check.py가 변경된 파일을 표시하는 것은 정상입니다. 원본 해시를 임의로 덮어써 검증 완료라고 표시하지 마세요. 웹의 ‘외부 AI 수정본 가져오기’에 workflow.json 또는 프로젝트 ZIP을 선택하고 원본·설계 비교 → 자료 본문·설정·첨부 변경 확인 → 자료 재연결 → 검증 후 새 사본/새 버전으로 저장하세요. 첨부가 바뀌었다면 ZIP을 선택하세요. 자료 content는 workflow.json의 resources에서 수정하며 생성 SKILL.md만 바꾸면 본문에 자동 반영되지 않습니다. 소유 자료는 기준 버전 충돌 확인 후 새 버전, 공유 자료는 내 사본을 선택합니다. 저장한 자료와 설계는 별개이며 자료를 자동 덮어쓰지 않습니다. ZIP 안 코드는 웹에서 실행하지 않습니다.
5. 웹에서 다시 Agent 다운로드 또는 실행 ZIP을 받으면 변경된 설계에서 WORKFLOW_GUIDE.md·AI_PROMPT.md·AGENTS.md·Skill·실행기·파일 비교 기준이 함께 갱신됩니다. 새 폴더에서 project-check.py와 실행기의 check를 수행합니다. 미설정은 설정 필요 상태이며 실제 서비스 성공이 아닙니다.
6. 임의로 고친 runner 또는 Python 도구 코드는 캔버스로 변환되지 않습니다. 웹 재내보내기는 제품의 표준 실행기를 사용하므로 코드 수정은 별도 개발 브랜치에서 검토·테스트하고 CHANGELOG.md에 남기세요. 웹으로 가져왔다는 이유로 그 코드를 검증했다고 주장하지 마세요.
7. 변경된 설계는 새 run으로 시작합니다. 이전 실행 ID·승인·체크포인트를 복사하거나 재사용하지 마세요. 기존 실행은 원래 폴더·설정에서만 이어갑니다. 결과 보고서에는 실행 ID·상태·산출물 위치·검사·외부 호출 여부·남은 설정을 포함하세요.
`;

/** 현재 entries의 바이트를 해시한다. PROJECT_FILES.json은 이 호출 뒤 추가되어 자기 자신의 해시를 포함하지 않는다. */
export async function projectFileInventory(entries: Record<string, Uint8Array>) {
  const files: Record<string, string> = {};
  for (const [path, bytes] of Object.entries(entries)) files[path] = await resourceFileHash(bytes);
  return JSON.stringify({ format: "flowly-project-files", version: 1, files }, null, 2);
}
