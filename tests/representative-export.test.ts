import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import type { Identity, Resource, Workflow } from "../app/lib/model";
import type { ExampleProject } from "../domain/example-types";
import { buildExportManifest, ExportPackageError } from "../server/export-package";
import { exampleConnections } from "../server/example-connections";
import { instantiateExample } from "../server/example-catalog";
import { parseExportManifest } from "../export-runtime/manifest";
import { checkPackage } from "../export-runtime/diagnostics";
import { runCommand } from "../export-runtime/runner";
import type { PublicRun, RuntimeDependencies } from "../runtime/types";

const alice: Identity = { userId: "template-alice", email: "alice@example.test", displayName: "Alice" };
const bob: Identity = { userId: "template-bob", email: "bob@example.test", displayName: "Bob" };
const carol: Identity = { userId: "template-carol", email: "carol@example.test", displayName: "Carol" };
const date = "2026-10-23T00:00:00.000Z";
const token = "synthetic-template-export-token-only";
function source(kind: "knowledge" | "publishing" = "knowledge") {
  const id = `showcase-${kind}`, write = kind === "publishing", toolName = write ? "create_record" : "lookup_reference";
  const resource: Resource = { id: `contract-${kind}`, ownerId: alice.userId, name: "공유 MCP 계약", type: "mcp", description: "자격 증명 없는 공개 도구 계약", url: "", visibility: "selected", allowedEmails: [bob.email], createdAt: date, updatedAt: date,
    content: JSON.stringify({ flowlyConnectionTemplate: id, endpoint: "https://attacker.example/ignored", token: "never-uses-this-token", effect: write ? "read" : "write", inputSchema: { type: "object", additionalProperties: true } }) };
  const workflow: Workflow = { id: "template-export", name: "도구 계약 내보내기", description: "", updatedAt: date, definition: { schemaVersion: 5, nodes: [
    { id: "input", type: "input", title: "요청", x: 0, y: 0 },
    { id: "tool", type: "tool", title: "등록" , x: 0, y: 180, allowedTools: [{ resourceId: resource.id, connectionId: id, toolName }], tool: write ? { arguments: { title: "확인한 제목" }, bindings: { body: "text" } } : { arguments: {}, bindings: { query: "text" } } },
    { id: "output", type: "output", title: "결과", x: 0, y: 360 },
  ], edges: [{ id: "a", source: "input", target: "tool" }, { id: "b", source: "tool", target: "output" }] } };
  return { workflow, resources: [resource] };
}
function project(value: ReturnType<typeof source>): ExampleProject {
  return { ...value, id: "template-source", title: "도구 계약", description: "", category: "대표", frameworks: ["Flowly"], tags: [], nodeTypes: ["input", "tool", "output"], status: "setup_required", uniqueBehavior: "", verification: { schema: true, node: false, python: false, live: false }, inputExample: "입력", expectedOutput: "응답", requirements: [], variants: [], acceptance: [], failureCases: [], sourceLicense: "직접 작성" };
}
const exportSource = (value = source(), user = bob, language: "node" | "python" = "node") => buildExportManifest({ user, ...value, connections: [], language, resolveResources: async () => value.resources, exportedAt: date });

test("direct and private copied MCP templates export fixed contracts and remain unconfigured without local values", async () => {
  const original = source();
  const copied = instantiateExample(project(original), bob);
  assert.notEqual(copied.resources[0].id, original.resources[0].id);
  for (const value of [original, copied]) {
    const manifest = await exportSource(value);
    const parsed = parseExportManifest(manifest), connection = parsed.connections[0];
    assert.equal(connection.ownerId, bob.userId);
    assert.equal(connection.resourceId, value.resources[0].id);
    assert.equal(connection.tools[0].resourceId, value.resources[0].id);
    assert.equal(connection.tools[0].effect, "read");
    assert.deepEqual(connection.tools[0].inputSchema.required, ["query"]);
    assert.equal(connection.tools[0].inputSchema.additionalProperties, false);
    assert.equal(connection.endpointEnv, "FLOWLY_MCP_ENDPOINT_KNOWLEDGE");
    assert.equal(connection.tokenEnv, "FLOWLY_MCP_TOKEN_KNOWLEDGE");
    assert.ok(!connection.endpoint.includes("attacker"));
    assert.equal(Object.hasOwn(manifest.resources[0], "allowedEmails"), false);
    assert.equal(checkPackage(manifest, {}).status, "unconfigured");
    assert.deepEqual(checkPackage(manifest, {}).missingEnv, ["FLOWLY_MCP_ENDPOINT_KNOWLEDGE", "FLOWLY_MCP_TOKEN_KNOWLEDGE"]);
    assert.equal(checkPackage(manifest, { FLOWLY_MCP_ENDPOINT_KNOWLEDGE: "https://tools.example.com/mcp", FLOWLY_MCP_TOKEN_KNOWLEDGE: token }).status, "ready");
  }
});

test("shared template never grants another user access or accepts resource-authored effect/schema overrides", async () => {
  const value = source("publishing");
  const template = exampleConnections(bob, value.resources)[0];
  assert.equal(template.tools[0].effect, "write");
  assert.deepEqual(template.tools[0].inputSchema.required, ["title", "body"]);
  assert.equal(template.tools[0].supportsIdempotency, false);
  assert.equal(template.ownerId, bob.userId);
  await exportSource(value, alice);
  await exportSource(value, bob);
  await assert.rejects(exportSource(value, carol), error => error instanceof ExportPackageError && error.status === 403);
  await assert.rejects(exportSource({ ...value, resources: value.resources.map(resource => ({ ...resource, visibility: "private" })) }, bob), error => error instanceof ExportPackageError && error.status === 403);
  const missing = structuredClone(value); missing.workflow.definition.nodes[1].allowedTools![0].toolName = "delete_everything";
  await assert.rejects(exportSource(missing), error => error instanceof ExportPackageError && error.status === 403);
  assert.deepEqual(exampleConnections(bob, [{ ...value.resources[0], content: '{"flowlyConnectionTemplate":"unknown-contract"}' }]), []);
});

test("local endpoint configuration allows internal HTTP/HTTPS and ports while rejecting invalid or credential-bearing URLs", async () => {
  const manifest = await exportSource();
  for (const endpoint of ["ftp://tools.internal/mcp", "https://user:password@tools.example.com/mcp", "https://tools.example.com/mcp?token=secret", "https://tools.example.com/mcp#fragment", "http://host:65536/mcp", "http://host:0/mcp", "http:///", "http://[invalid]/mcp"]) {
    const checked = checkPackage(manifest, { FLOWLY_MCP_ENDPOINT_KNOWLEDGE: endpoint, FLOWLY_MCP_TOKEN_KNOWLEDGE: token });
    assert.equal(checked.status, "invalid", endpoint);
    assert.ok(checked.errors.some(error => error.includes("FLOWLY_MCP_ENDPOINT_KNOWLEDGE")));
    assert.ok(!JSON.stringify(checked).includes(token));
  }
  for (const endpoint of ["http://tools/mcp", "http://127.0.0.1:8080/mcp", "https://[::1]:8443/mcp", "https://service.internal:9443/mcp", "http://10.20.30.40/mcp"]) assert.equal(checkPackage(manifest, { FLOWLY_MCP_ENDPOINT_KNOWLEDGE: endpoint, FLOWLY_MCP_TOKEN_KNOWLEDGE: token }).status, "ready", endpoint);
  const bad = structuredClone(manifest); bad.connections[0].endpointEnv = "OPENAI_API_KEY";
  assert.throws(() => parseExportManifest(bad), /주소 설정 이름/);
});

test("combining two private copies of one connection contract fails clearly instead of exporting mismatched resource IDs", async () => {
  const first = instantiateExample(project(source()), bob), second = instantiateExample(project(source()), bob);
  const workflow = structuredClone(first.workflow);
  const tool = structuredClone(second.workflow.definition.nodes.find(node => node.id === "tool")!);
  tool.id = "second_tool"; tool.inputBindings = { text: { nodeId: "tool", path: "text" } };
  workflow.definition.nodes.splice(2, 0, tool);
  workflow.definition.edges = [{ id: "first", source: "input", target: "tool" }, { id: "second", source: "tool", target: "second_tool" }, { id: "last", source: "second_tool", target: "output" }];
  workflow.definition.nodes.find(node => node.id === "output")!.inputBindings = { text: { nodeId: "second_tool", path: "text" } };
  await assert.rejects(exportSource({ workflow, resources: [...first.resources, ...second.resources] }), /같은 서비스 정의.*중복 연결/);
});

test("missing template endpoint cannot fall back to placeholder or create a successful run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowly-template-noenv-"));
  try {
    const packagePath = join(directory, "workflow.json"), stateDirectory = join(directory, "state");
    await writeFile(packagePath, JSON.stringify(await exportSource()));
    await assert.rejects(runCommand({ action: "run", input: "조회" }, { packagePath, stateDirectory, env: { FLOWLY_MCP_TOKEN_KNOWLEDGE: token } }), /서비스 연결 미설정/);
    assert.deepEqual(await readdir(stateDirectory), []);
  } finally { const path = relative(resolve(tmpdir()), resolve(directory)); assert.ok(path && !path.startsWith("..") && !isAbsolute(path)); await rm(directory, { recursive: true, force: true }); }
});

test("write approval remains pinned to the original endpoint through a process restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowly-template-approval-"));
  try {
    const packagePath = join(directory, "workflow.json"), stateDirectory = join(directory, "state");
    const manifest = await exportSource(source("publishing")), originalPackage = JSON.stringify(manifest);
    await writeFile(packagePath, originalPackage);
    let calls = 0;
    const adapters: Pick<RuntimeDependencies, "model" | "callTool"> = { model: { next: async () => { throw new Error("No model is required"); } }, callTool: async (_tool, args) => { calls++; assert.deepEqual(args, { title: "확인한 제목", body: "승인할 본문" }); return { text: "외부 호출 없는 도구 어댑터 결과" }; } };
    const env = { FLOWLY_MCP_ENDPOINT_PUBLISHING: "https://publish.example.com/mcp", FLOWLY_MCP_TOKEN_PUBLISHING: token };
    const options = { packagePath, stateDirectory, env, adapters };
    const waiting = await runCommand({ action: "run", input: "승인할 본문" }, options) as PublicRun;
    assert.equal(waiting.status, "waiting_approval"); assert.equal(calls, 0);
    await runCommand({ action: "approve", runId: waiting.id, approvalId: waiting.approvals[0].id }, { packagePath, stateDirectory });
    const altered = structuredClone(manifest); altered.connections[0].tools[0].effect = "read";
    await writeFile(packagePath, JSON.stringify(altered));
    await assert.rejects(runCommand({ action: "resume", runId: waiting.id }, options), /실행 기록과 내보내기 파일/);
    assert.equal(calls, 0);
    await writeFile(packagePath, originalPackage);
    await assert.rejects(runCommand({ action: "resume", runId: waiting.id }, { ...options, env: { ...env, FLOWLY_MCP_ENDPOINT_PUBLISHING: "https://changed.example.com/mcp" } }), /서비스 주소.*현재 설정/);
    assert.equal(calls, 0);
    const done = await runCommand({ action: "resume", runId: waiting.id }, options) as PublicRun;
    assert.equal(done.status, "succeeded"); assert.equal(calls, 1);
    await runCommand({ action: "resume", runId: waiting.id }, options); assert.equal(calls, 1);
  } finally { const path = relative(resolve(tmpdir()), resolve(directory)); assert.ok(path && !path.startsWith("..") && !isAbsolute(path)); await rm(directory, { recursive: true, force: true }); }
});

test("Python validates direct/copied contract configuration and pins endpoint before dispatch without network", async () => {
  const original = source(), copy = instantiateExample(project(original), bob);
  const manifests = await Promise.all([exportSource(original, bob, "python"), exportSource(copy, bob, "python")]);
  const script = String.raw`
import copy, importlib.util, json, pathlib, socket, sys, tempfile
spec=importlib.util.spec_from_file_location("template_runner", pathlib.Path("export-runtime/runner.py").resolve())
r=importlib.util.module_from_spec(spec); spec.loader.exec_module(r)
def forbidden(*args, **kwargs): raise AssertionError("External network is forbidden")
socket.create_connection=forbidden
for manifest in json.load(sys.stdin):
    r.validate_package(manifest)
    with tempfile.TemporaryDirectory(prefix="flowly-python-template-") as directory:
        root=pathlib.Path(directory); package=root/"workflow.json"; envfile=root/".env"
        package.write_text(json.dumps(manifest,ensure_ascii=False),encoding="utf-8")
        envfile.write_text("",encoding="utf-8")
        checked=r.check_project(str(package),str(envfile))
        assert checked["status"]=="unconfigured", checked
        assert set(checked["missingEnv"])=={"FLOWLY_MCP_ENDPOINT_KNOWLEDGE","FLOWLY_MCP_TOKEN_KNOWLEDGE"},checked
        for target in ["ftp://tools.internal/mcp","https://user:secret@tools.example.com/mcp","https://tools.example.com/mcp?token=secret","http://host:65536/mcp","https://host/mcp#fragment"]:
            envfile.write_text("FLOWLY_MCP_ENDPOINT_KNOWLEDGE="+target+"\nFLOWLY_MCP_TOKEN_KNOWLEDGE=synthetic-token\n",encoding="utf-8")
            assert r.check_project(str(package),str(envfile))["status"]=="invalid"
        for target in ["http://tools/mcp","http://127.0.0.1:8080/mcp","https://[::1]:8443/mcp","https://service.internal:9443/mcp"]:
            envfile.write_text("FLOWLY_MCP_ENDPOINT_KNOWLEDGE="+target+"\nFLOWLY_MCP_TOKEN_KNOWLEDGE=synthetic-token\n",encoding="utf-8")
            assert r.check_project(str(package),str(envfile))["status"]=="ready"
        env={"FLOWLY_MCP_ENDPOINT_KNOWLEDGE":"https://tools.example.com/mcp","FLOWLY_MCP_TOKEN_KNOWLEDGE":"synthetic-token"}
        envfile.write_text("\n".join(key+"="+value for key,value in env.items())+"\n",encoding="utf-8")
        assert r.check_project(str(package),str(envfile))["status"]=="ready"
        try: r.Providers({},manifest["connections"],require_model=False)
        except r.Fault: pass
        else: raise AssertionError("Missing endpoint must not use placeholder")
        provider=r.Providers(env,manifest["connections"],require_model=False)
        run=r.new_run(manifest,"조회"); run["connectionTargets"]={c["id"]:c["endpoint"] for c in provider.connections}
        provider.connections[0]["endpoint"]="https://changed.example.com/mcp"
        store=r.Store(str(root/"state"))
        engine=r.Engine(manifest,"fixture-package-hash",store,provider,run)
        try: engine.guard()
        except r.ProtectedFault as error: assert "서비스 주소" in str(error)
        else: raise AssertionError("Endpoint mutation must fail before dispatch")
print(json.dumps({"projects":2,"externalCalls":0}))
`;
  const result = spawnSync("python", ["-X", "utf8", "-c", script], { cwd: process.cwd(), input: JSON.stringify(manifests), encoding: "utf8", timeout: 30000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, NODE_ENV: "test", PYTHONUTF8: "1", PYTHONNOUSERSITE: "1" } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { projects: 2, externalCalls: 0 });
});
