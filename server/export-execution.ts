/** 문서에 표시할 Node.js/Python 진입점과 실행 명령을 한곳에서 결정한다. 실행 의미와 권한 검사는 manifest/실행기의 책임이다. */
import type { ExportManifest } from "./export-package";

export type ExportExecutionTarget = "runtime" | "agent";

/** Presentation only: execution definitions and current resource checks stay in the manifest. */
export function exportExecution(manifest: Pick<ExportManifest, "language">, target: ExportExecutionTarget = "runtime") {
  const entrypoint = `${target === "agent" ? "agent" : "runner"}.${manifest.language === "python" ? "py" : "mjs"}`;
  return { entrypoint, command: `${manifest.language === "python" ? "python" : "node"} ${entrypoint}` };
}

/** A copied prompt names the download the user can prepare; it never assumes files exist. */
export function promptExecutionTarget(): ExportExecutionTarget {
  return "agent";
}
