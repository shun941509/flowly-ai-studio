// Node에서 고정 Python 도구/업무 프로그램을 호출하는 프로세스 경계. 도우미 소스와 계약의 fingerprint를 실행 재개에 사용한다.
import { spawn } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonicalJson, redactText, RuntimeFault } from "../runtime/policy";
import type { Json, RuntimeDependencies } from "../runtime/types";

const assetNames = ["flowly_tools.py", "toolpacks_scientific.py", "toolpacks_media.py", "tool-contracts.json", "tool-catalog.json"];
// A Windows Job Object owns descendants even if the helper exits before them.
// Its only inheritable lifetime is this process; termination closes the handle.
const workerBootstrap = `import ctypes, os, runpy, sys
if os.name == 'nt':
 from ctypes import wintypes as w
 class Basic(ctypes.Structure):
  _fields_ = [('process_time',ctypes.c_int64),('job_time',ctypes.c_int64),('flags',w.DWORD),('minimum',ctypes.c_size_t),('maximum',ctypes.c_size_t),('active',w.DWORD),('affinity',ctypes.c_size_t),('priority',w.DWORD),('scheduling',w.DWORD)]
 class IO(ctypes.Structure):
  _fields_ = [(name,ctypes.c_uint64) for name in ['read_operations','write_operations','other_operations','read_bytes','write_bytes','other_bytes']]
 class Extended(ctypes.Structure):
  _fields_ = [('basic',Basic),('io',IO),('process_memory',ctypes.c_size_t),('job_memory',ctypes.c_size_t),('peak_process',ctypes.c_size_t),('peak_job',ctypes.c_size_t)]
 kernel = ctypes.WinDLL('kernel32',use_last_error=True)
 kernel.CreateJobObjectW.argtypes = [w.LPVOID,w.LPCWSTR]; kernel.CreateJobObjectW.restype = w.HANDLE
 kernel.SetInformationJobObject.argtypes = [w.HANDLE,ctypes.c_int,w.LPVOID,w.DWORD]; kernel.SetInformationJobObject.restype = w.BOOL
 kernel.GetCurrentProcess.argtypes = []; kernel.GetCurrentProcess.restype = w.HANDLE
 kernel.AssignProcessToJobObject.argtypes = [w.HANDLE,w.HANDLE]; kernel.AssignProcessToJobObject.restype = w.BOOL
 _job = kernel.CreateJobObjectW(None,None); limits = Extended(); limits.basic.flags = 0x2000
 if not _job or not kernel.SetInformationJobObject(_job,9,ctypes.byref(limits),ctypes.sizeof(limits)) or not kernel.AssignProcessToJobObject(_job,kernel.GetCurrentProcess()):
  raise OSError('Python worker process ownership could not be initialized')
sys.argv = [sys.argv[1]]
sys.path.insert(0,os.path.dirname(os.path.abspath(sys.argv[0])))
runpy.run_path(sys.argv[0],run_name='__main__')
`;
// 파일 원문 바이트와 선택한 로컬 도구 설정의 해시다. 주석 변경도 값이 달라지므로 기존 실행을 새 코드로 재개하지 못하게 한다.
export async function pythonToolsFingerprint(packagePath: string, configuration: Record<string, string | undefined> = {}, completion = false): Promise<string> {
  const root = dirname(resolve(packagePath));
  const files: Record<string, string> = {};
  for (const name of [...assetNames, ...(completion ? ["flowly_completions.py", "completion_research.py", "completion_programs.py", "completion_operations.py", "completion-manifest.json"] : [])]) {
    let data: Buffer;
    try { data = await readFile(join(root, name)); } catch { throw new RuntimeFault("failed", "Python 도구 미설정: 내보낸 도우미·도구 계약 파일을 확인해 주세요."); }
    if (data.length > 2_000_000) throw new RuntimeFault("failed", "Python 도구 파일의 크기 한도를 넘었어요.");
    files[name] = createHash("sha256").update(data).digest("hex");
  }
  const localConfig = Object.fromEntries(["FLOWLY_TOOL_MODELS", "FLOWLY_WATERMARK_KEY", "FLOWLY_CONTENT_CREDENTIALS_KEY"].map(name => [name, configuration[name] ?? ""]));
  return createHash("sha256").update(canonicalJson({ files, localConfig })).digest("hex");
}

/** Fixed packaged worker only. No shell, uploaded source, credentials or network fallback. */
// 고정 도우미만 격리 모드로 실행한다. Windows Job Object 또는 POSIX 프로세스 그룹으로 자손까지 종료해 취소 후 작업이 남지 않게 한다.
export function pythonToolWorker(packagePath: string, executable?: string, configuration?: Record<string, string | undefined>, helper: "flowly_tools.py" | "flowly_completions.py" | "flowly_skills.py" = "flowly_tools.py") {
  const root = dirname(resolve(packagePath));
  return (payload: Record<string, Json>, signal: AbortSignal): Promise<Json> => new Promise((resolveResult, reject) => {
    if (signal.aborted) { reject(new RuntimeFault("cancelled", "Python 도구 실행을 취소했어요.")); return; }
    const encoded = canonicalJson(payload);
    if (Buffer.byteLength(encoded) > 2_000_000) { reject(new RuntimeFault("failed", "Python 도구 입력이 2MB 한도를 넘었어요.")); return; }
    const environment: NodeJS.ProcessEnv = { NODE_ENV: "production", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1", OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1", MKL_NUM_THREADS: "1", ...Object.fromEntries(["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])) };
    for (const key of helper === "flowly_skills.py" ? [] : ["FLOWLY_TOOL_MODELS", "FLOWLY_WATERMARK_KEY", "FLOWLY_CONTENT_CREDENTIALS_KEY"]) if (configuration?.[key]) environment[key] = configuration[key];
    const child = spawn(executable?.trim() || (process.platform === "win32" ? "python" : "python3"), ["-X", "utf8", "-I", "-c", workerBootstrap, join(root, helper)], { cwd: root, env: environment, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    let output = "", size = 0, settled = false;
    const decoder = new StringDecoder("utf8");
    const terminateTree = () => {
      if (!child.pid) return;
      if (process.platform === "win32") { if (child.exitCode === null) child.kill("SIGKILL"); }
      else { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already reaped. */ } }
    };
    // 실패 시 프로세스 트리를 종료하고 close를 기다린 뒤 거절한다. 정리 대기가 끝나지 않는 경우에도 최대 2초 후 반환한다.
    const finish = (error?: Error, result?: Json) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (!error) { resolveResult(result!); return; }
      const cleanupLimit = setTimeout(() => reject(error), 2000);
      child.once("close", () => { clearTimeout(cleanupLimit); reject(error); });
      terminateTree(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (child.exitCode !== null || !child.pid) { clearTimeout(cleanupLimit); reject(error); }
    };
    const abort = () => finish(new RuntimeFault("cancelled", "Python 도구 실행을 취소했어요."));
    const timer = setTimeout(() => finish(new RuntimeFault("budget_exceeded", "Python 도구 실행 시간 한도에 도달했어요.")), 120000);
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", () => finish(new RuntimeFault("failed", "Python 도구 미설정: Python 3.11 이상과 flowly_tools.py를 확인해 주세요.")));
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 2_000_000) finish(new RuntimeFault("failed", "Python 도구 결과가 2MB 한도를 넘었어요.")); else output += decoder.write(chunk); });
    child.stderr.resume();
    child.stdin.on("error", () => finish(new RuntimeFault("failed", "Python 도우미에 입력을 전달하지 못했어요.")));
    child.on("exit", terminateTree);
    child.on("close", code => {
      try {
        const data = JSON.parse(output + decoder.end());
        if (code !== 0 || data?.ok !== true) {
          const kind = data?.error?.code;
          const message = typeof data?.error?.message === "string" ? redactText(data.error.message).slice(0, 500) : "등록된 Python 도구의 입력과 설정을 확인해 주세요.";
          finish(new RuntimeFault("failed", `${["missing_dependency", "missing_model", "missing_configuration"].includes(kind) ? "Python 도구 미설정: " : "Python 도구 실행 실패: "}${message}`)); return;
        }
        canonicalJson(data.result); finish(undefined, data.result);
      } catch { finish(new RuntimeFault("failed", "Python 도우미의 JSON 응답을 읽지 못했어요.")); }
    });
    child.stdin.end(encoded);
  });
}
export function pythonToolBridge(packagePath: string, executable?: string, configuration?: Record<string, string | undefined>): NonNullable<RuntimeDependencies["pythonTool"]> {
  const worker = pythonToolWorker(packagePath, executable, configuration);
  return request => worker({ toolId: request.toolId, arguments: request.arguments }, request.signal);
}
