/** 빌드로 준비된 서버 소유 실행기/도우미를 내보내기 생성기에 공급한다. 일반 워크플로와 예제 다운로드가 같은 자산을 사용한다. */
import { buildExportPackage } from "./export-package";
import {
  exportRunnerSource, exportPythonSource, exportFileHelperSource, exportTriggerSource,
  exportFileRequirements, exportOperationsSource, exportLocalSource, exportOperationsGuide, exportProgramsSource, exportDynamicSource, exportKnowledgeSource, exportSearchSource,
  exportPythonToolsSource, exportScientificToolsSource, exportMediaToolsSource, exportToolRequirements, exportCompletionsSource, exportCompletionResearchSource, exportCompletionProgramsSource, exportCompletionOperationsSource,
  exportSkillsSource,
} from "./generated/export-runner";

type ExecutableExportOptions = Omit<Parameters<typeof buildExportPackage>[0], "runnerSource" | "helpers" | "operations">;

/** Both public download paths use the same complete, server-owned runtime assets. */
/** 호출자가 실행기 소스를 주입하지 못하게 옵션 타입에서 제외한다. 생성 파일 수정은 원본 실행기와 생성 절차를 통해 반영한다. */
export function buildExecutableExportPackage(options: ExecutableExportOptions): Promise<Uint8Array> {
  return buildExportPackage({
    ...options,
    runnerSource: options.language === "python" ? exportPythonSource : exportRunnerSource,
    helpers: { files: exportFileHelperSource, triggers: exportTriggerSource, requirements: exportFileRequirements, programs: exportProgramsSource, dynamic: exportDynamicSource, knowledge: exportKnowledgeSource, search: exportSearchSource, pythonTools: exportPythonToolsSource, scientificTools: exportScientificToolsSource, mediaTools: exportMediaToolsSource, toolRequirements: exportToolRequirements, completions: exportCompletionsSource, completionResearch: exportCompletionResearchSource, completionPrograms: exportCompletionProgramsSource, completionOperations: exportCompletionOperationsSource, skills: exportSkillsSource },
    operations: { ops: exportOperationsSource, local: exportLocalSource, guide: exportOperationsGuide },
  });
}
