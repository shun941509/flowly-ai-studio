import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { runCommand, type RunnerCommand } from "./runner";
import { readLimited } from "./store";
import type { Json } from "../runtime/types";
import { monitorCancellationFile } from "./cancellation";

const usage = `Flowly 독립 실행기 · Node.js 22.13 이상
  node runner.mjs check
  node runner.mjs run --input "질문"
  node runner.mjs run --input-file input.txt
  node runner.mjs status <실행ID>
  node runner.mjs approve <실행ID> <승인ID>
  node runner.mjs deny <실행ID> <승인ID>
  node runner.mjs accept <실행ID> <검토ID> [--edited-input-file edited.json]
  node runner.mjs reject <실행ID> <검토ID>
  node runner.mjs submit <실행ID> <입력요청ID> --values-file values.json
  node runner.mjs resume <실행ID>
  node runner.mjs report <실행ID> --output report.html
  node runner.mjs unlock
옵션: --package workflow.json --state .flowly-runs --env .env
run/resume 취소 신호: --cancel-file .flowly-ops/cancel/job.cancel
check는 패키지와 로컬 설정만 검사하며 외부 연결 성공을 확인하지 않습니다.
report는 저장 기록으로 HTML을 만들며 기존 파일을 덮어쓰지 않습니다.
승인과 거절은 결정만 저장합니다. resume로 이어서 실행하세요.
종료된 프로세스의 잠금만 unlock으로 해제할 수 있습니다.`;

export async function main(args: string[]) {
  if (!args.length || args.includes("--help") || args.includes("-h")) { console.log(usage); return; }
  const positional: string[] = [], flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) { positional.push(args[i]); continue; }
    const key = args[i].slice(2);
    if (!["package", "state", "env", "input", "input-file", "edited-input-file", "values-file", "output", "cancel-file"].includes(key) || flags[key] !== undefined || args[i + 1] === undefined) throw new Error("명령 옵션을 확인해 주세요. --help로 사용법을 볼 수 있어요.");
    flags[key] = args[++i];
  }
  const action = positional[0];
  if ((action !== "run" && (flags.input !== undefined || flags["input-file"] !== undefined)) || (action !== "report" && flags.output !== undefined)) throw new Error("이 명령에서 사용할 수 없는 옵션이에요. --help로 사용법을 확인해 주세요.");
  if (action !== "accept" && flags["edited-input-file"] !== undefined) throw new Error("수정 입력은 accept 검토 승인에서만 사용할 수 있어요.");
  if (action !== "run" && action !== "resume" && flags["cancel-file"] !== undefined) throw new Error("취소 신호 파일은 run 또는 resume에서만 사용할 수 있어요.");
  if (action !== "submit" && flags["values-file"] !== undefined) throw new Error("보완 입력 파일은 submit에서만 사용할 수 있어요.");
  let command: RunnerCommand;
  if (action === "run") {
    if (positional.length !== 1 || (flags.input !== undefined) === (flags["input-file"] !== undefined)) throw new Error("run에는 --input 또는 --input-file 중 하나를 지정해 주세요.");
    const input = flags.input ?? await readLimited(resolve(flags["input-file"]), 80000);
    command = { action, input };
  } else if ((action === "status" || action === "resume") && positional.length === 2) command = { action, runId: positional[1] };
  else if (action === "report" && positional.length === 2 && flags.output) command = { action, runId: positional[1], output: resolve(flags.output) };
  else if ((action === "approve" || action === "deny") && positional.length === 3) command = { action, runId: positional[1], approvalId: positional[2] };
  else if (action === "submit" && positional.length === 3 && flags["values-file"]) {
    let values: unknown;
    try { values = JSON.parse(await readLimited(resolve(flags["values-file"]), 80000)); } catch { throw new Error("보완 입력 파일은 80KB 이하의 JSON 객체로 작성해 주세요."); }
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("보완 입력은 JSON 객체여야 해요.");
    command = { action, runId: positional[1], requestId: positional[2], values: values as Record<string, Json> };
  }
  else if ((action === "accept" || action === "reject") && positional.length === 3) {
    let editedInput: Record<string, Json> | undefined;
    if (flags["edited-input-file"]) {
      let parsed: unknown; try { parsed = JSON.parse(await readLimited(resolve(flags["edited-input-file"]), 200000)); } catch { throw new Error("수정 입력 파일은 200KB 이하의 JSON 객체로 작성해 주세요."); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("수정 입력은 JSON 객체여야 해요.");
      editedInput = parsed as Record<string, Json>;
    }
    command = { action, runId: positional[1], reviewId: positional[2], ...(editedInput === undefined ? {} : { editedInput }) };
  }
  else if ((action === "unlock" || action === "check") && positional.length === 1) command = { action };
  else throw new Error("명령을 확인해 주세요. --help로 사용법을 볼 수 있어요.");
  let env: Record<string, string | undefined> = {};
  let environmentError = false;
  if (action === "run" || action === "resume" || action === "check") {
    try { env = parseEnv(await readLimited(resolve(flags.env ?? ".env"), 64000)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (action === "check") environmentError = true;
        else throw new Error("환경 파일을 읽지 못했어요. 파일 크기·접근 권한·형식을 확인해 주세요.");
      }
    }
  }
  const controller = new AbortController();
  const packagePath = resolve(flags.package ?? "workflow.json");
  const stopMonitoring = flags["cancel-file"] === undefined ? undefined : await monitorCancellationFile(packagePath, flags["cancel-file"], controller);
  const stop = () => controller.abort(); process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    const result = await runCommand(command, { packagePath, stateDirectory: resolve(flags.state ?? ".flowly-runs"), env, environmentError, signal: controller.signal, onDelta: event => { process.stderr.write(JSON.stringify({ type: "model_delta", partial: true, ...event }) + "\n"); } });
    console.log(JSON.stringify(result, null, 2));
    if (result && typeof result === "object" && "status" in result && ["failed", "cancelled", "expired", "budget_exceeded", "unknown_outcome", "unconfigured", "invalid"].includes(String(result.status))) process.exitCode = 1;
  } finally { stopMonitoring?.(); process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}

main(process.argv.slice(2)).catch(error => {
  // Never print provider bodies, environment values, or arbitrary upstream stacks.
  const message = error instanceof Error && /[가-힣]/.test(error.message) ? error.message : "실행 파일이나 저장 경로를 확인해 주세요. 외부 작업은 재시도하지 않았어요.";
  console.error(message); process.exitCode = 1;
});
