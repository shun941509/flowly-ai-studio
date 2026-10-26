/** 공통 예제를 일반 내보내기 생성기에 연결한다. 기대 결과/합성 입력은 안내 자료이며 실제 모델 실행 결과가 아니다. */
import { strToU8, unzipSync, zipSync } from "fflate";
import type { Identity } from "../app/lib/model";
import type { ExampleProject } from "../domain/example-types";
import { buildExecutableExportPackage } from "./export-assets";
import { buildExportManifest } from "./export-package";
import { buildCopyPrompt } from "./export-ai-documents";
import { exportExecution } from "./export-execution";

/** 서버가 선택한 예제 자료로 같은 manifest를 만든 뒤 복사용 AI 지시문을 생성한다. */
export async function buildExamplePrompt(project: ExampleProject, user: Identity, language: "node" | "python") {
  const manifest = await buildExportManifest({ user, workflow: project.workflow, connections: [], resolveResources: async () => project.resources, language, kind: "prompt" });
  return buildCopyPrompt(manifest);
}

/** Server-selected, public synthetic fixtures only. No user graph, key or token. */
/** 표준 실행 ZIP에 예제 입력과 평가 기준을 추가한다. 서비스 연결이나 테스트 응답 생성은 이 단계에서 수행하지 않는다. */
export async function buildExampleExport(project: ExampleProject, user: Identity, language: "node" | "python", kind: "runtime" | "agent" = "runtime") {
  const bytes = await buildExecutableExportPackage({ user, workflow: project.workflow, connections: [], resolveResources: async () => project.resources, language, kind });
  const files = unzipSync(bytes);
  const contract = { format: "flowly-example-contract", version: 1, id: project.id, title: project.title, kind: project.kind,
    problem: project.description, input: project.inputExample, expectedOutput: project.expectedOutput,
    acceptance: project.acceptance, failureCases: project.failureCases,
    note: "기대 결과는 작성된 평가 기준이며 실제 모델의 실행 결과가 아닙니다.", liveVerified: false };
  files["example-contract.json"] = strToU8(JSON.stringify(contract, null, 2));
  files["input.txt"] = strToU8(project.inputExample);
  const { command } = exportExecution({ language }, kind);
  files["EXAMPLE.md"] = strToU8(`# ${project.title}\n\n${project.description}\n\n${project.kind === "case" ? "공통 기본 흐름을 재사용하는 업무 사례입니다. 개별 실행 구조 재설계와 현재 실행 검증은 남아 있습니다." : "개별 설계한 흐름과 직접 작성한 합성 자료를 사용하는 실행 프로젝트입니다."} README.md를 읽고, 모델을 사용하는 흐름은 본인의 모델 키와 모델명을 로컬 .env에 설정하세요. 데이터 처리만 하는 흐름은 모델 키 없이 실행할 수 있습니다. 웹에는 키를 입력하지 않습니다. 미설정 시 check가 미설정 상태를 반환하며 가짜 답변으로 대체하지 않습니다.\n\n## 실행\n\n    ${command} check\n    ${command} run --input-file input.txt\n\n보완 입력이 필요한 예제는 waiting_input 상태와 요청 ID를 확인하세요. 요청된 필드를 values.json에 작성한 뒤 아래 명령을 실행합니다. submit은 입력을 저장하며 resume이 같은 실행을 이어갑니다.\n\n    ${command} submit RUN_ID REQUEST_ID --values-file values.json\n    ${command} resume RUN_ID\n\n사람 검토가 있는 예제는 출력된 실행 ID와 검토 ID를 확인한 뒤 README의 accept/reject 및 resume 명령을 사용하세요. 이 결정은 보완 입력이나 외부 쓰기 승인과 구분됩니다.\n\n## 기대 결과 (실행 결과 아님)\n\n${project.expectedOutput}\n\n## 확인할 기준\n\n${project.acceptance.map(item => `- ${item}`).join("\n")}\n\n## 실패·경계 사례\n\n${project.failureCases.map(item => `- ${item}`).join("\n")}\n\n실제 모델의 업무 정답률과 외부 연결은 아직 검증하지 않았습니다. 테스트 어댑터는 이 ZIP에 포함하지 않습니다.\n`);
  return zipSync(files, { level: 6 });
}
