// 내보낸 Node 프로젝트의 명령 서비스. manifest·환경·파일 잠금을 검증한 뒤 공통 runtime/engine.ts를 호출한다.
import { isDeepStrictEqual } from "node:util";
import { createRun, decideApproval, decideReview, submitInput, executeRun, publicRun } from "../runtime/engine";
import { OpenAIModelAdapter } from "../runtime/adapters/openai";
import { createMcpToolCaller } from "../runtime/adapters/mcp";
import { redactSecret, redactText, RuntimeFault } from "../runtime/policy";
import type { Json, RuntimeDependencies, RuntimeRun } from "../runtime/types";
import { parseExportManifest, type ExportManifest } from "./manifest";
import { digest, FileRunStore, readLimited } from "./store";
import { checkPackage, modelRequired, selectedConnections, writeRunReport, type CheckResult } from "./diagnostics";
import { fileBridge } from "./files";
import { allNodes } from "../runtime/advanced";
import { missingEnvironment } from "./diagnostics";
import { nodeRequiresResponseModel, nodeUsesEmbeddings } from "../domain/extended-config";
import { safeEndpoint } from "../runtime/adapters/http";
import { selectedPythonToolIds } from "../runtime/python-tools";
import { selectedCompletionOperations } from "../runtime/completion-programs";
import { pythonToolBridge, pythonToolWorker, pythonToolsFingerprint } from "./python-tools";
import { assertResourceFiles, skillRuntimeFingerprint } from "./resource-files";
import { skillExecutionMaterial } from "../runtime/resource-materials";

export type RunnerCommand = { action: "run"; input: string } | { action: "resume" | "status"; runId: string } | { action: "approve" | "deny"; runId: string; approvalId: string } | { action: "accept" | "reject"; runId: string; reviewId: string; editedInput?: Record<string, Json> } | { action: "submit"; runId: string; requestId: string; values: Record<string, Json> } | { action: "report"; runId: string; output: string } | { action: "unlock" } | { action: "check" };
export type RunnerOptions = { packagePath: string; stateDirectory: string; env?: Record<string, string | undefined>; environmentError?: boolean; signal?: AbortSignal; onDelta?: RuntimeDependencies["onDelta"]; adapters?: Pick<RuntimeDependencies, "model" | "callTool"> & Partial<Pick<RuntimeDependencies, "files" | "pythonTool" | "completion">> };

function providerSettings(manifest: ExportManifest, options: RunnerOptions): NonNullable<RuntimeRun["provider"]> {
  const nodes = allNodes(manifest.workflow.definition), env = options.env ?? {}, result: NonNullable<RuntimeRun["provider"]> = {};
  const secrets = Object.entries(env).filter(([name, value]) => value && (name === "OPENAI_API_KEY" || name === "FLOWLY_TRIGGER_SECRET" || name === "FLOWLY_WATERMARK_KEY" || name === "FLOWLY_CONTENT_CREDENTIALS_KEY" || /^FLOWLY_MCP_TOKEN_[A-Z0-9_]+$/.test(name))).map(([, value]) => value!);
  const safe = (value: string) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value) || redactText(value) !== value || secrets.some(secret => value.includes(secret))) throw new Error("모델 이름에는 비밀 값이나 잘못된 문자를 사용할 수 없어요. 설정을 확인해 주세요.");
    return value;
  };
  if (nodes.some(nodeRequiresResponseModel) && env.FLOWLY_MODEL?.trim()) result.model = safe(env.FLOWLY_MODEL.trim());
  if (nodes.some(nodeUsesEmbeddings)) result.embeddingModel = safe(options.adapters?.model.embeddingModel ?? (env.FLOWLY_EMBEDDING_MODEL?.trim() || "text-embedding-3-small"));
  return result;
}

function connectionTargets(manifest: ExportManifest, env: Record<string, string | undefined>) {
  return Object.fromEntries(selectedConnections(manifest).filter(c => c.endpointEnv).map(c => {
    if (!env[c.endpointEnv!]?.trim()) throw new Error(`서비스 연결 미설정: ${c.endpointEnv}`);
    return [c.id, safeEndpoint(env[c.endpointEnv!]!.trim())];
  }));
}

// 필요한 연결만 만들며 키/주소/토큰이 없으면 미설정으로 중단한다. 실제 실행 실패를 테스트 답변으로 바꾸지 않는다.
function liveAdapters(manifest: ExportManifest, env: Record<string, string | undefined>): Pick<RuntimeDependencies, "model" | "callTool"> {
  const requiresModel = modelRequired(manifest);
  if (requiresModel && missingEnvironment(manifest, env).some(name => name === "OPENAI_API_KEY" || name === "FLOWLY_MODEL")) throw new Error("모델 연결 미설정: .env에 본인의 OPENAI_API_KEY와 필요한 FLOWLY_MODEL을 등록해 주세요. 가짜 답변으로 대체하지 않아요.");
  const connections = selectedConnections(manifest).map(c => {
    if (c.endpointEnv && !env[c.endpointEnv]?.trim()) throw new Error(`서비스 연결 미설정: .env의 ${c.endpointEnv} 주소를 등록해 주세요.`);
    if (c.tokenEnv && !env[c.tokenEnv]?.trim()) throw new Error(`서비스 연결 미설정: .env의 ${c.tokenEnv} 값을 등록해 주세요.`);
    return { id: c.id, endpoint: c.endpointEnv ? env[c.endpointEnv]!.trim() : c.endpoint, ...(c.tokenEnv ? { token: env[c.tokenEnv] } : {}) };
  });
  const secrets = Object.entries(env).filter(([name, value]) => value && (name === "OPENAI_API_KEY" || name === "FLOWLY_TRIGGER_SECRET" || name === "FLOWLY_WATERMARK_KEY" || name === "FLOWLY_CONTENT_CREDENTIALS_KEY" || /^FLOWLY_MCP_TOKEN_[A-Z0-9_]+$/.test(name))).map(([, value]) => value!);
  return { model: requiresModel ? new OpenAIModelAdapter({ apiKey: env.OPENAI_API_KEY!, model: env.FLOWLY_MODEL?.trim() || "gpt-5.4-mini", embeddingModel: env.FLOWLY_EMBEDDING_MODEL, reasoningEffort: "none", secrets }) : { async next() { throw new Error("이 흐름에는 모델 실행이 설정되지 않았어요."); } }, callTool: createMcpToolCaller(connections) };
}

/** Adapter injection is for offline tests only; the shipped CLI always creates live adapters. */
// check/status/report와 실행 변경 명령을 나눈다. adapters 주입은 오프라인 테스트용이며 배포 CLI는 로컬 설정으로 실제 어댑터를 만든다.
export async function runCommand(command: RunnerCommand, options: RunnerOptions) {
  const store = new FileRunStore(options.stateDirectory);
  if (command.action === "unlock") { await store.unlock(); return { message: "종료된 실행기의 잠금을 해제했어요. resume 명령으로 저장된 상태를 확인해 주세요." }; }
  if (command.action === "check") {
    try {
      const raw = JSON.parse(await readLimited(options.packagePath, 8000000));
      const checked = checkPackage(raw, options.env, options.environmentError ? "unreadable" : undefined);
      if (checked.status !== "invalid") {
        const materialManifest = parseExportManifest(raw);
        try { await assertResourceFiles(options.packagePath, materialManifest.resources); }
        catch (error) { checked.status = "unconfigured"; checked.errors.push(error instanceof Error ? error.message : "자료 원본 파일을 확인해 주세요."); }
        for (const node of allNodes(materialManifest.workflow.definition).filter(node => node.type === "skill" && node.skillExecution)) try {
          const resource = materialManifest.resources.find(resource => resource.id === node.resourceId)!;
          const result = await pythonToolWorker(options.packagePath, options.env?.FLOWLY_PYTHON, undefined, "flowly_skills.py")({ operation: "check", resource: skillExecutionMaterial(resource, node.skillExecution!.entryId), entryId: node.skillExecution!.entryId }, options.signal ?? new AbortController().signal) as { status: string; missing: string[] };
          if (result.status !== "ready") { checked.status = "unconfigured"; checked.errors.push(`Skill 미설정: ${result.missing.join(", ")}`); }
        } catch (error) { checked.status = "unconfigured"; checked.errors.push(error instanceof Error ? error.message : "Skill 파일·의존성을 확인해 주세요."); }
        const manifest = parseExportManifest(raw), nodes = allNodes(manifest.workflow.definition).filter(node => ["file_input", "document_extract", "file_output"].includes(node.type));
        if (nodes.length) try { const result = await fileBridge(options.packagePath, options.stateDirectory, options.env?.FLOWLY_PYTHON)({ operation: "check", runId: "check", nodeId: "check", config: { nodes: nodes.map(node => ({ type: node.type, config: (node.fileInput ?? node.documentExtract ?? node.fileOutput)! as unknown as Json })) }, input: {}, signal: options.signal ?? new AbortController().signal }); if (result.status !== "ready") { checked.status = "unconfigured"; checked.errors.push(`파일 처리 의존성 미설정: ${Array.isArray(result.missing) ? result.missing.join(", ") : "도우미 설정 확인"}`); } }
        catch (error) { checked.status = "unconfigured"; checked.errors.push(error instanceof Error ? error.message : "파일 처리 도우미가 미설정이에요."); }
        const toolIds = selectedPythonToolIds(manifest.workflow.definition);
        if (toolIds.length) try {
          const result = await pythonToolWorker(options.packagePath, options.env?.FLOWLY_PYTHON, options.env)({ operation: "check", toolIds }, options.signal ?? new AbortController().signal) as { status?: string; missing?: Json[] };
          if (result?.status !== "ready") { checked.status = "unconfigured"; checked.errors.push(`Python 도구 미설정: ${(result?.missing ?? []).map(value => typeof value === "string" ? value : JSON.stringify(value)).join(", ")}`); }
        } catch (error) { checked.status = "unconfigured"; checked.errors.push(error instanceof Error ? error.message : "Python 도구 의존성을 확인해 주세요."); }
        const operations = selectedCompletionOperations(manifest.workflow.definition);
        if (operations.length) try {
          const result = await pythonToolWorker(options.packagePath, options.env?.FLOWLY_PYTHON, options.env, "flowly_completions.py")({ operation: "check", operations }, options.signal ?? new AbortController().signal) as { status?: string; missing?: Json[] };
          if (result?.status !== "ready") { checked.status = "unconfigured"; checked.errors.push(`업무 프로그램 미설정: ${JSON.stringify(result?.missing ?? [])}`); }
        } catch (error) { checked.status = "unconfigured"; checked.errors.push(error instanceof Error ? error.message : "업무 프로그램 파일을 확인해 주세요."); }
      }
      return checked;
    }
    catch { return { status: "invalid", language: "node", counts: { nodes: 0, resources: 0, tools: 0 }, requiresModel: false, missingEnv: [], errors: ["워크플로 패키지 파일의 존재·크기·JSON 형식을 확인해 주세요."] } satisfies CheckResult; }
  }
  const raw = await readLimited(options.packagePath, 8000000);
  const packageHash = digest(raw), manifest = parseExportManifest(JSON.parse(raw));
  if (manifest.language !== "node") throw new Error("Node.js용으로 내보낸 workflow.json을 사용해 주세요.");
  if (command.action === "status" || command.action === "report") {
    const saved = await store.load(command.runId);
    if (saved.packageHash !== packageHash) throw new Error("내보내기 파일이 변경됐어요. 이 실행을 시작했던 원본 workflow.json으로 확인해 주세요.");
    if (command.action === "report") {
      if (saved.run.mode !== "live" || saved.run.owner.userId !== manifest.owner.userId || !isDeepStrictEqual(saved.run.workflow, manifest.workflow)) throw new Error("실행 기록과 내보내기 파일이 맞지 않아요. 원본 파일을 사용해 주세요.");
      const output = await writeRunReport(saved.run, command.output);
      return { status: "report_written", runId: saved.run.id, output };
    }
    return publicRun(saved.run);
  }
  await store.acquire();
  try {
    const secrets = Object.entries(options.env ?? {}).filter(([key]) => key === "OPENAI_API_KEY" || key === "FLOWLY_TRIGGER_SECRET" || key === "FLOWLY_WATERMARK_KEY" || key === "FLOWLY_CONTENT_CREDENTIALS_KEY" || /^FLOWLY_MCP_TOKEN_[A-Z0-9_]+$/.test(key)).map(([, value]) => value).filter((v): v is string => Boolean(v));
    const clean = (value: Json) => secrets.reduce((result, secret) => redactSecret(result, secret), value);
    if (secrets.some(secret => raw.includes(secret))) throw new Error("내보내기 파일에 비밀 값이 포함되어 있어요. 자료에서 비밀 값을 제거하고 다시 내보내 주세요.");
    const usesPythonTools = selectedPythonToolIds(manifest.workflow.definition).length > 0 && !options.adapters?.pythonTool;
    const usesCompletions = selectedCompletionOperations(manifest.workflow.definition).length > 0 && !options.adapters?.completion;
    const selectedSkills = allNodes(manifest.workflow.definition).filter(node => node.type === "skill" && node.skillExecution);
    const skillWorker = pythonToolWorker(options.packagePath, options.env?.FLOWLY_PYTHON, undefined, "flowly_skills.py");
    const requirePythonReady = async () => {
      await assertResourceFiles(options.packagePath, manifest.resources);
      for (const node of selectedSkills) {
        const resource = manifest.resources.find(resource => resource.id === node.resourceId)!;
        const checked = await skillWorker({ operation: "check", resource: skillExecutionMaterial(resource, node.skillExecution!.entryId), entryId: node.skillExecution!.entryId }, options.signal ?? new AbortController().signal) as { status: string; missing: string[] };
        if (checked.status !== "ready") throw new RuntimeFault("failed", `Skill 미설정: ${checked.missing.join(", ")}. 실행 전에 중단했어요.`);
      }
      if (usesCompletions) {
        const checked = await pythonToolWorker(options.packagePath, options.env?.FLOWLY_PYTHON, options.env, "flowly_completions.py")({ operation: "check", operations: selectedCompletionOperations(manifest.workflow.definition) }, options.signal ?? new AbortController().signal) as { status?: string; missing?: Json[] };
        if (checked?.status !== "ready") throw new RuntimeFault("failed", `업무 프로그램 미설정: ${JSON.stringify(checked?.missing ?? [])}. 모델 호출 전에 중단했어요.`);
      }
      if (!usesPythonTools) return;
      const checked = await pythonToolWorker(options.packagePath, options.env?.FLOWLY_PYTHON, options.env)({ operation: "check", toolIds: selectedPythonToolIds(manifest.workflow.definition) }, options.signal ?? new AbortController().signal) as { status?: string; missing?: Json[] };
      if (checked?.status !== "ready") throw new RuntimeFault("failed", `Python 도구 미설정: ${JSON.stringify(checked?.missing ?? [])}. 모델 호출 전에 중단했어요.`);
    };
    // 재개와 저장 시 실행 시작 당시 Python 코드·계약·로컬 설정을 비교한다. 파일이 달라지면 새 실행이 필요하다.
    const assertPythonAssets = async (current: RuntimeRun) => { if ((usesPythonTools || usesCompletions) && current.pythonToolsFingerprint !== await pythonToolsFingerprint(options.packagePath, options.env, usesCompletions)) throw new RuntimeFault("failed", "실행을 시작한 Python 도구 코드·계약·로컬 설정이 변경됐어요. 원래 파일과 설정으로 복구하거나 새 실행을 시작해 주세요."); };
    const assertPackage = async () => { await store.assertLock(); if (digest(await readLimited(options.packagePath, 8000000)) !== packageHash) throw new Error("내보내기 파일이 실행 중 변경됐어요. 새 실행을 시작해 주세요."); await assertPythonAssets(run); await assertResourceFiles(options.packagePath, manifest.resources); if (selectedSkills.length && run.skillRuntimeFingerprint !== await skillRuntimeFingerprint(options.packagePath)) throw new RuntimeFault("failed", "Skill 감독 코드가 변경됐어요. 원래 파일로 복구하거나 새 실행을 시작해 주세요."); };
    let run: RuntimeRun;
    if (command.action === "run") {
      // Validate credentials before creating a record. A missing key is not a failed AI answer.
      if (!options.adapters) liveAdapters(manifest, options.env ?? {});
      await requirePythonReady();
      run = createRun({ owner: manifest.owner, mode: "live", workflow: manifest.workflow, resources: manifest.resources.map(r => ({ ...r, allowedEmails: [] })), input: clean(command.input) as string, limits: manifest.limits });
      run.provider = providerSettings(manifest, options);
      if (usesPythonTools || usesCompletions) run.pythonToolsFingerprint = await pythonToolsFingerprint(options.packagePath, options.env, usesCompletions);
      if (selectedSkills.length) run.skillRuntimeFingerprint = await skillRuntimeFingerprint(options.packagePath);
      if (selectedConnections(manifest).some(c => c.endpointEnv)) run.connectionTargets = connectionTargets(manifest, options.env ?? {});
      await store.save(run, packageHash, true);
    } else {
      const saved = await store.load(command.runId);
      if (saved.packageHash !== packageHash || saved.run.mode !== "live" || saved.run.owner.userId !== manifest.owner.userId || !isDeepStrictEqual(saved.run.workflow, manifest.workflow)) throw new Error("실행 기록과 내보내기 파일이 맞지 않아요. 원본 파일을 사용해 주세요.");
      run = saved.run;
      await assertPythonAssets(run);
    }
    if (run.restoredReadOnly) throw new Error("복원한 외부 변경 실행은 조회만 가능해요. 서비스의 실제 결과를 확인한 뒤 새 실행을 시작해 주세요.");
    // 결정 저장은 여기서 종료한다. 승인·검토·보완 입력 뒤에는 별도 resume 명령이 있어야 다음 노드가 실행된다.
    if (command.action === "approve" || command.action === "deny") {
      await assertPackage(); await decideApproval(run, command.approvalId, manifest.owner.userId, command.action === "approve" ? "approved" : "denied"); await store.save(run, packageHash); return publicRun(run);
    }
    if (command.action === "accept" || command.action === "reject") {
      await assertPackage(); await decideReview(run, command.reviewId, manifest.owner.userId, command.action === "accept" ? "accepted" : "rejected", command.editedInput); await store.save(run, packageHash); return publicRun(run);
    }
    if (command.action === "submit") {
      await assertPackage(); await submitInput(run, command.requestId, manifest.owner.userId, command.values); await store.save(run, packageHash); return publicRun(run);
    }
    if (run.provider && !isDeepStrictEqual(run.provider, providerSettings(manifest, options))) throw new Error("실행을 시작한 모델 설정과 현재 설정이 달라요. 원래 모델 설정으로 재개하거나 새 실행을 시작해 주세요.");
    if (run.connectionTargets && !isDeepStrictEqual(run.connectionTargets, connectionTargets(manifest, options.env ?? {}))) throw new Error("실행을 시작한 서비스 주소와 현재 설정이 달라요. 원래 주소로 복구하거나 새 실행에서 승인받아 주세요.");
    const adapters = options.adapters ?? liveAdapters(manifest, options.env ?? {});
    if (command.action === "resume") await requirePythonReady();
    await executeRun(run, {
      ...adapters,
      tools: manifest.connections.flatMap(c => c.tools),
      save: async current => { await assertPackage(); await store.save(JSON.parse(JSON.stringify(clean(current as unknown as Json))) as RuntimeRun, packageHash); },
      memory: async operation => { await assertPackage(); return store.memory(clean(operation as unknown as Json) as unknown as Parameters<typeof store.memory>[0]); },
      vectorCache: async (key, value) => { await assertPackage(); return store.vectorCache(key, value); },
      files: options.adapters?.files ?? fileBridge(options.packagePath, options.stateDirectory, options.env?.FLOWLY_PYTHON),
      pythonTool: options.adapters?.pythonTool ?? pythonToolBridge(options.packagePath, options.env?.FLOWLY_PYTHON, options.env),
      skill: request => skillWorker({ operation: "execute", resource: skillExecutionMaterial(manifest.resources.find(resource => resource.id === request.resourceId)!, request.entryId), entryId: request.entryId, arguments: request.arguments }, request.signal),
      completion: options.adapters?.completion ?? (request => pythonToolWorker(options.packagePath, options.env?.FLOWLY_PYTHON, options.env, "flowly_completions.py")({ operation: request.operation, arguments: request.arguments }, request.signal)),
      onDelta: async event => options.onDelta?.({ ...event, text: clean(event.text) as string }),
      isCancelled: async () => Boolean(options.signal?.aborted),
      cancellationSignal: options.signal,
      assertAccess: async (ids, tool) => {
        await assertPackage();
        if (ids.some(id => !manifest.resources.some(r => r.id === id))) throw new RuntimeFault("failed", "내보낸 자료 사용 범위를 벗어났어요.");
        if (tool && !manifest.connections.some(c => c.id === tool.connectionId && c.resourceId === tool.resourceId && c.tools.some(t => JSON.stringify(t) === JSON.stringify(tool)))) throw new RuntimeFault("failed", "내보낸 도구 사용 범위를 벗어났어요.");
      },
    });
    return clean(publicRun(run) as unknown as Json);
  } finally { await store.release(); }
}
