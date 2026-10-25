import { buildExportPackage } from "./export-package";
import {
  exportRunnerSource, exportPythonSource, exportFileHelperSource, exportTriggerSource,
  exportFileRequirements, exportOperationsSource, exportLocalSource, exportOperationsGuide, exportProgramsSource, exportDynamicSource, exportKnowledgeSource, exportSearchSource,
  exportPythonToolsSource, exportScientificToolsSource, exportMediaToolsSource, exportToolRequirements, exportCompletionsSource, exportCompletionResearchSource, exportCompletionProgramsSource, exportCompletionOperationsSource,
} from "./generated/export-runner";

type ExecutableExportOptions = Omit<Parameters<typeof buildExportPackage>[0], "runnerSource" | "helpers" | "operations">;

/** Both public download paths use the same complete, server-owned runtime assets. */
export function buildExecutableExportPackage(options: ExecutableExportOptions): Promise<Uint8Array> {
  return buildExportPackage({
    ...options,
    runnerSource: options.language === "python" ? exportPythonSource : exportRunnerSource,
    helpers: { files: exportFileHelperSource, triggers: exportTriggerSource, requirements: exportFileRequirements, programs: exportProgramsSource, dynamic: exportDynamicSource, knowledge: exportKnowledgeSource, search: exportSearchSource, pythonTools: exportPythonToolsSource, scientificTools: exportScientificToolsSource, mediaTools: exportMediaToolsSource, toolRequirements: exportToolRequirements, completions: exportCompletionsSource, completionResearch: exportCompletionResearchSource, completionPrograms: exportCompletionProgramsSource, completionOperations: exportCompletionOperationsSource },
    operations: { ops: exportOperationsSource, local: exportLocalSource, guide: exportOperationsGuide },
  });
}
