import { spawn } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { RuntimeFault } from "../runtime/policy";
import type { RuntimeDependencies } from "../runtime/types";

/** Files are handled by the packaged helper, never by a shell or ambient model credentials. */
export function fileBridge(packagePath: string, stateDirectory: string, executable?: string): NonNullable<RuntimeDependencies["files"]> {
  const root = dirname(resolve(packagePath));
  return request => new Promise((resolveResult, reject) => {
    if (request.signal.aborted) { reject(new RuntimeFault("cancelled", "파일 처리를 취소했어요.")); return; }
    const environment: NodeJS.ProcessEnv = { NODE_ENV: "production", ...Object.fromEntries(["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])) };
    const child = spawn(executable?.trim() || (process.platform === "win32" ? "python" : "python3"), [join(root, "flowly_files.py")], { cwd: root, env: environment, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", bytes = 0, settled = false;
    const decoder = new StringDecoder("utf8");
    const finish = (error?: Error, result?: Record<string, import("../runtime/types").Json>) => { if (settled) return; settled = true; clearTimeout(timer); request.signal.removeEventListener("abort", abort); if (error) { child.kill(); reject(error); } else resolveResult(result!); };
    const abort = () => finish(new RuntimeFault("cancelled", "파일 처리를 취소했어요."));
    const timer = setTimeout(() => finish(new RuntimeFault("budget_exceeded", "파일 처리 시간 한도에 도달했어요.")), 120000);
    request.signal.addEventListener("abort", abort, { once: true });
    child.on("error", () => finish(new RuntimeFault("failed", "파일 처리 미설정: Python 3.11 이상과 flowly_files.py를 확인해 주세요.")));
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2000000) finish(new RuntimeFault("failed", "파일 처리 결과가 2MB 한도를 넘었어요.")); else output += decoder.write(chunk); });
    child.stderr.resume(); // Dependency errors may contain local paths; never echo them.
    child.stdin.on("error", () => finish(new RuntimeFault("failed", "파일 처리 도우미에 요청을 전달하지 못했어요.")));
    child.on("close", code => {
      output += decoder.end();
      let data; try { data = JSON.parse(output); } catch { finish(new RuntimeFault("failed", "파일 처리 도우미 응답을 읽지 못했어요.")); return; }
      if (code !== 0 || data.error) { const message = typeof data.error === "string" && /[가-힣]/.test(data.error) ? data.error.slice(0, 500) : "파일 처리 설정 또는 파일 형식을 확인해 주세요."; finish(new RuntimeFault("failed", `${data.kind === "unconfigured" ? "파일 처리 미설정: " : ""}${message}`)); return; }
      if (!data || typeof data !== "object" || Array.isArray(data)) { finish(new RuntimeFault("failed", "파일 처리 결과 형식을 확인해 주세요.")); return; }
      finish(undefined, data);
    });
    const payload = { operation: request.operation, runId: request.runId, nodeId: request.nodeId, config: request.config, input: request.input };
    child.stdin.end(JSON.stringify({ ...payload, root, stateDirectory: resolve(stateDirectory) }));
  });
}
