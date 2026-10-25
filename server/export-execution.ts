import { allNodes } from "../domain/advanced-config";
import type { ExportManifest } from "./export-package";

export type ExportExecutionTarget = "runtime" | "agent";

/** Presentation only: execution definitions and current resource checks stay in the manifest. */
export function exportExecution(manifest: Pick<ExportManifest, "language">, target: ExportExecutionTarget = "runtime") {
  const entrypoint = `${target === "agent" ? "agent" : "runner"}.${manifest.language === "python" ? "py" : "mjs"}`;
  return { entrypoint, command: `${manifest.language === "python" ? "python" : "node"} ${entrypoint}` };
}

/** A copied prompt names the download the user can prepare; it never assumes files exist. */
export function promptExecutionTarget(manifest: ExportManifest): ExportExecutionTarget {
  return allNodes(manifest.workflow.definition).some(node => node.type === "agent") ? "agent" : "runtime";
}
