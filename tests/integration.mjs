/** Actual local HTTP + D1 integration. Requires `pnpm setup:local`, migrations and dev server.
 * Uses only fixed local test accounts and mode=test. Never connects to an SSO/model/MCP provider.
 * Synthetic runtime/preview audit records are retained; created workflows/resources are removed.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";

const origin = process.env.FLOWLY_TEST_ORIGIN || "http://127.0.0.1:5173";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname)) throw new Error("Integration tests must target a loopback development server.");
const prefix = `integration-${randomUUID().slice(0, 8)}`;
const cookies = {};
const cleanup = [];
let passed = 0;
let skipped = 0;
async function check(name, work) { await work(); passed++; console.log(`PASS ${name}`); }
async function request(path, user, body, extraHeaders = {}) {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST", redirect: "manual",
    headers: { ...(user ? { cookie: cookies[user] } : {}), ...(body !== undefined ? { origin, "content-type": "application/json" } : {}), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
  });
  const content = await response.text();
  let data;
  try { data = JSON.parse(content); } catch { data = { nonJson: true }; }
  return { status: response.status, data, headers: response.headers, content };
}
async function good(path, user, body, status = 200) {
  const result = await request(path, user, body);
  assert.equal(result.status, status, `${path} expected ${status}, got ${result.status}: ${result.data.error || "non-JSON response"}`);
  return result.data;
}
async function exportRequest(user, flow, language, kind, extra = {}) {
  return fetch(`${origin}/api/export`, { method: "POST", headers: { ...(user ? { cookie: cookies[user] } : {}), origin, "content-type": "application/json", ...extra }, body: JSON.stringify({ workflow: flow, language, kind }), signal: AbortSignal.timeout(30000) });
}
async function deniedCrossOrigin(path, action) {
  const result = await request(path, "alice", { action }, { origin: "https://attacker.example" });
  assert.equal(result.status, 403, "Cross-origin rejection must not break the following request's transport.");
}
const studio = user => good("/api/studio", user);
const write = async (user, action, data, id) => {
  const current = action === "resource.update" ? (await studio(user)).resources.find(resource => resource.id === id)
    : action === "workflow.save" ? (await studio(user)).workflows.find(workflow => workflow.id === data?.id) : undefined;
  return good("/api/studio", user, { action, data, id, ...(current ? { baseUpdatedAt: current.updatedAt } : {}) }, action === "resource.create" ? 201 : 200);
};
const findResource = async (user, id) => (await studio(user)).resources.find(resource => resource.id === id);
const node = (id, type, extra = {}) => ({ id, type, title: id, x: 120, y: 120, ...extra });
const edge = (source, target, branch) => ({ id: `${source}-${target}`, source, target, ...(branch ? { branch } : {}) });
const readTool = { resourceId: "sample-search", connectionId: "test-read", toolName: "lookup" };
const writeTool = { resourceId: "sample-search", connectionId: "test-write", toolName: "draft_note" };
function workflow({ tool = readTool, resourceId, name = `${prefix} 실행` } = {}) {
  const nodes = [node("input", "input")];
  const edges = [];
  if (resourceId) { nodes.push(node("context", "resource", { resourceId })); edges.push(edge("input", "context")); }
  nodes.push(node("agent", "agent", { prompt: "허용된 도구 하나로 입력을 확인하고 결과에 근거해 답하세요.", allowedTools: tool ? [tool] : [] }), node("output", "output"));
  edges.push(edge(resourceId ? "context" : "input", "agent"), edge("agent", "output"));
  return { id: `${prefix}-${randomUUID().slice(0, 8)}`, name, description: "로컬 HTTP 통합 검사에서 생성한 가상 데이터", definition: { schemaVersion: 2, nodes, edges } };
}
async function start(user, flow, input = `${prefix} 입력`, key = randomUUID(), mode = "test") {
  return good("/api/runtime", user, { action: "run.start", mode, workflow: flow, input, idempotencyKey: key }, 202);
}
async function poll(user, id, expected) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const { run } = await good(`/api/runtime?id=${encodeURIComponent(id)}`, user);
    if (expected.includes(run.status)) return run;
    if (["failed", "expired", "budget_exceeded", "unknown_outcome", "cancelled"].includes(run.status)) throw new Error(`Unexpected status ${run.status}: ${run.error || ""}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${expected.join("/")}`);
}
const decide = async (user, run, decision) => {
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await request("/api/runtime", user, { action: "approval.decide", id: run.id, approvalId: run.approvals[0].id, decision });
    if ([200, 202].includes(response.status)) return response.data;
    if ([400, 409].includes(response.status) && /다른 실행 작업/.test(response.data.error || "")) {
      await new Promise(resolve => setTimeout(resolve, 150));
      continue;
    }
    assert.fail(`Approval decision returned ${response.status}: ${response.data.error || ""}`);
  }
  assert.fail("Approval remained busy; no accepted decision was reported.");
};

try {
  await check("anonymous and spoofed authentication headers are rejected", async () => {
    assert.equal((await request("/api/studio")).status, 401);
    assert.equal((await request("/api/runtime")).status, 401);
    assert.equal((await request("/api/studio", undefined, undefined, { "oai-authenticated-user-id": "test:alice", "oai-authenticated-user-email": "alice@flowly.test" })).status, 401);
  });
  await check("three fixed test accounts receive independent server-signed sessions", async () => {
    for (const user of ["alice", "bob", "carol"]) {
      const response = await fetch(`${origin}/api/auth/test`, { method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ identity: user, return_to: "/studio" }), signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, 303, "Enable FLOWLY_AUTH_MODE=test and FLOWLY_ENV=development/test at the configured loopback origin.");
      const header = response.headers.get("set-cookie");
      assert.ok(header?.includes("HttpOnly"));
      cookies[user] = header.split(";")[0];
      await studio(user);
    }
    assert.equal(new Set(Object.values(cookies)).size, 3);
  });
  await check("tampered session and cross-origin mutations are rejected", async () => {
    const previous = cookies.alice;
    cookies.alice = `${previous}x`;
    assert.equal((await request("/api/studio", "alice")).status, 401);
    cookies.alice = previous;
    await deniedCrossOrigin("/api/studio", "resource.create");
    await deniedCrossOrigin("/api/runtime", "run.start");
  });
  let resource;
  const documentData = { name: `${prefix} 자료`, type: "document", description: "가상 자료", content: `${prefix} 고정된 원본 내용`, url: "", visibility: "private", allowedEmails: [] };
  await check("resource ownership is derived from the session; private data is isolated", async () => {
    ({ resource } = await write("alice", "resource.create", { ...documentData, ownerId: "test:bob" }));
    cleanup.push(() => write("alice", "resource.delete", undefined, resource.id));
    assert.equal(resource.ownerId, "test:alice");
    assert.ok(await findResource("alice", resource.id));
    assert.equal(await findResource("bob", resource.id), undefined);
    assert.equal(await findResource("carol", resource.id), undefined);
  });
  await check("non-owners cannot edit or delete by guessing a resource ID", async () => {
    for (const user of ["bob", "carol"]) {
      assert.equal((await request("/api/studio", user, { action: "resource.update", id: resource.id, data: documentData })).status, 404);
      assert.equal((await request("/api/studio", user, { action: "resource.delete", id: resource.id })).status, 404);
    }
  });
  await check("selected sharing allows Bob but excludes Carol and hides recipient lists", async () => {
    await write("alice", "resource.update", { ...documentData, visibility: "selected", allowedEmails: ["BOB@flowly.test"] }, resource.id);
    const shared = await findResource("bob", resource.id);
    assert.ok(shared);
    assert.deepEqual(shared.allowedEmails, []);
    assert.equal(await findResource("carol", resource.id), undefined);
  });
  await check("public sharing permits both users but preserves owner-only editing", async () => {
    await write("alice", "resource.update", { ...documentData, visibility: "public" }, resource.id);
    assert.ok(await findResource("bob", resource.id));
    assert.ok(await findResource("carol", resource.id));
    assert.equal((await request("/api/studio", "bob", { action: "resource.update", id: resource.id, data: documentData })).status, 404);
    await write("alice", "resource.update", { ...documentData, visibility: "selected", allowedEmails: ["bob@flowly.test"] }, resource.id);
  });
  await check("Python preset permissions protect both real ZIP exports and are rechecked after sharing revocation", async () => {
    const settings = { ...documentData, name: `${prefix} Python 설정`, content: JSON.stringify({ flowlyPython: { version: 1, toolId: "jsonl", arguments: { text: '{"count":2}' } } }) };
    const { resource: preset } = await write("alice", "resource.create", settings);
    cleanup.push(() => write("alice", "resource.delete", undefined, preset.id));
    const flow = { id: `${prefix}-preset`, name: "설정 공유 검사", description: "가상 입력만 사용", definition: { schemaVersion: 5, nodes: [node("input", "input"), node("program", "program", { resourceId: preset.id, program: { name: "python_tool", arguments: { toolId: "jsonl", arguments: { text: '{"count":2}' } }, bindings: {} } }), node("output", "output")], edges: [edge("input", "program"), edge("program", "output")] } };
    const download = async (user, language) => fetch(`${origin}/api/export`, { method: "POST", headers: { cookie: cookies[user], origin, "content-type": "application/json" }, body: JSON.stringify({ workflow: flow, language }), signal: AbortSignal.timeout(30000) });
    const denied = await download("bob", "node"); assert.equal(denied.status, 403); await denied.arrayBuffer();
    await write("alice", "resource.update", { ...settings, visibility: "selected", allowedEmails: ["bob@flowly.test"] }, preset.id);
    for (const language of ["node", "python"]) {
      const response = await download("bob", language); assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /application\/zip/);
      const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
      for (const file of ["AI_PROMPT.md", "AGENTS.md", "skills/flowly-workflow/SKILL.md", "tool-manifest.json", "flowly_tools.py"]) assert.ok(files[file], file);
      assert.equal(files[".env"], undefined);
      assert.deepEqual(JSON.parse(strFromU8(files["tool-manifest.json"])).tools.map(tool => tool.id), ["jsonl"]);
      const manifest = JSON.parse(strFromU8(files["workflow.json"])); assert.ok(manifest.resources.some(item => item.id === preset.id));
      assert.equal(manifest.workflow.definition.nodes.find(item => item.id === "program").resourceId, preset.id);
    }
    const carol = await download("carol", "python"); assert.equal(carol.status, 403); await carol.arrayBuffer();
    assert.equal((await request("/api/studio", "bob", { action: "resource.delete", id: preset.id })).status, 404);
    await write("alice", "resource.update", settings, preset.id);
    for (const language of ["node", "python"]) { const response = await download("bob", language); assert.equal(response.status, 403); await response.arrayBuffer(); }
  });
  await check("copy-only prompts and Agent ZIPs share current resource permissions in both languages", async () => {
    const flow = workflow({ tool: null, resourceId: resource.id });
    for (const language of ["node", "python"]) {
      const prompt = await exportRequest("bob", flow, language, "prompt");
      assert.equal(prompt.status, 200); assert.match(prompt.headers.get("content-type"), /application\/json/);
      assert.equal(prompt.headers.get("content-disposition"), null);
      const copied = await prompt.json(); assert.equal(copied.kind, "prompt"); assert.equal(copied.language, language);
      assert.ok(copied.text.includes(documentData.content)); assert.ok(copied.text.includes(flow.name));
      assert.match(copied.text, /입력|노드|연결/); assert.match(copied.text, /\.env/);
      const agent = await exportRequest("bob", flow, language, "agent");
      assert.equal(agent.status, 200); assert.match(agent.headers.get("content-disposition"), /agent/);
      const files = unzipSync(new Uint8Array(await agent.arrayBuffer()));
      for (const path of ["Agent.md", "AGENTS.md", "START_HERE.md", "agent-manifest.json", "mcp.json", "skills/flowly-workflow/SKILL.md", language === "node" ? "agent.mjs" : "agent.py"]) assert.ok(files[path], path);
      assert.equal(files[".env"], undefined);
      for (const kind of ["prompt", "agent"]) {
        const forbidden = await exportRequest("carol", flow, language, kind); assert.equal(forbidden.status, 403); await forbidden.arrayBuffer();
      }
    }
    for (const kind of ["prompt", "agent"]) {
      const anonymous = await exportRequest(undefined, flow, "node", kind); assert.equal(anonymous.status, 401); await anonymous.arrayBuffer();
      const forged = await exportRequest(undefined, flow, "node", kind, { "oai-authenticated-user-id": "test:bob" }); assert.equal(forged.status, 401); await forged.arrayBuffer();
      const cross = await exportRequest("bob", flow, "node", kind, { origin: "https://attacker.example" }); assert.equal(cross.status, 403); await cross.arrayBuffer();
    }
  });
  await check("Agent download is rejected for model-only flows and enabled for explicit nested Agent blocks", async () => {
    const modelOnly = workflow({ tool: null }); modelOnly.definition.nodes[1].type = "ai"; delete modelOnly.definition.nodes[1].allowedTools;
    for (const language of ["node", "python"]) {
      const denied = await exportRequest("alice", modelOnly, language, "agent"); assert.equal(denied.status, 409); await denied.arrayBuffer();
      const prompt = await exportRequest("alice", modelOnly, language, "prompt"); assert.equal(prompt.status, 200); await prompt.arrayBuffer();
      const nested = workflow({ tool: null });
      nested.definition.nodes[1] = node("agent", "subworkflow", { subworkflow: { definition: workflow({ tool: null }).definition } });
      const response = await exportRequest("alice", nested, language, "agent"); assert.equal(response.status, 200);
      const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
      const manifest = JSON.parse(strFromU8(files["agent-manifest.json"])); assert.equal(manifest.agents.length, 1); assert.match(manifest.agents[0].scope, /child/);
    }
  });
  let saved;
  await check("saved workflows are isolated; foreign IDs cannot overwrite or delete", async () => {
    ({ workflow: saved } = await write("bob", "workflow.save", workflow({ resourceId: resource.id })));
    cleanup.push(() => write("bob", "workflow.delete", undefined, saved.id));
    assert.ok((await studio("bob")).workflows.some(flow => flow.id === saved.id));
    assert.equal((await studio("alice")).workflows.some(flow => flow.id === saved.id), false);
    assert.equal((await request("/api/studio", "alice", { action: "workflow.save", data: saved })).status, 403);
    assert.equal((await request("/api/studio", "alice", { action: "workflow.delete", id: saved.id })).status, 404);
  });
  await check("preview results remain labeled and isolated from actual runtime records", async () => {
    const { run } = await good("/api/studio", "bob", { action: "preview.run", workflow: saved, input: `${prefix} 미리보기` });
    assert.match(run.result, /미리보기/);
    assert.match(run.result, /AI가 생성한 답변이 아닙니다/);
    assert.ok((await studio("bob")).runs.some(item => item.id === run.id));
    assert.equal((await studio("alice")).runs.some(item => item.id === run.id), false);
    assert.equal((await good("/api/runtime", "bob")).runs.some(item => item.id === run.id), false);
  });
  const { capabilities } = await good("/api/runtime", "bob");
  assert.equal(capabilities.testEnabled, true, "Set FLOWLY_TEST_RUNTIME=true for integration tests.");
  if (!capabilities.liveEnabled) {
    await check("web live execution is disabled without fake results", async () => {
      const result = await request("/api/runtime", "bob", { action: "run.start", workflow: saved, input: "실제 연결 없음", idempotencyKey: randomUUID(), mode: "live" });
      assert.equal(result.status, 409);
      assert.match(result.data.error, /연결|설정/);
      assert.equal(result.data.run, undefined);
    });
  } else { skipped++; console.log("SKIP live request: real provider configured; integration tests never dispatch external API calls."); }
  let reading;
  await check("test Agent sends actual input through one read tool into the final answer", async () => {
    const { run } = await start("bob", saved, `${prefix} 입력 전달`);
    reading = await poll("bob", run.id, ["succeeded"]);
    assert.equal(reading.mode, "test");
    assert.match(reading.result, /테스트/);
    assert.ok(reading.result.includes(`${prefix} 입력 전달`));
    assert.ok(reading.result.includes(documentData.content));
    assert.equal(reading.usage.toolCalls, 1);
    assert.equal(reading.events.filter(event => event.type === "tool_completed").length, 1);
    assert.equal("checkpoint" in reading, false);
    assert.equal("resources" in reading, false);
  });
  await check("foreign run IDs cannot disclose, resume, cancel or approve", async () => {
    assert.equal((await request(`/api/runtime?id=${reading.id}`, "carol")).status, 404);
    for (const action of ["run.resume", "run.cancel", "approval.decide"]) assert.equal((await request("/api/runtime", "carol", { action, id: reading.id, approvalId: "unknown", decision: "approve" })).status, 404);
    assert.equal((await good("/api/runtime", "alice")).runs.some(run => run.id === reading.id), false);
  });
  await check("duplicate run requests are idempotent and changed requests cannot reuse a key", async () => {
    const flow = workflow();
    const idempotencyKey = randomUUID();
    const [first, second] = await Promise.all([start("alice", flow, "같은 입력", idempotencyKey), start("alice", flow, "같은 입력", idempotencyKey)]);
    assert.equal(first.run.id, second.run.id);
    const completed = await poll("alice", first.run.id, ["succeeded"]);
    assert.equal(completed.usage.toolCalls, 1);
    assert.equal((await request("/api/runtime", "alice", { action: "run.start", mode: "test", workflow: flow, input: "다른 입력", idempotencyKey })).status, 400);
  });
  await check("an unauthorized tool selection is refused before creating a run", async () => {
    const flow = workflow({ tool: { ...readTool, connectionId: "another-users-connection" } });
    const result = await request("/api/runtime", "alice", { action: "run.start", mode: "test", workflow: flow, input: "권한 없는 도구", idempotencyKey: randomUUID() });
    assert.equal(result.status, 403);
  });
  await check("writes wait for approval; duplicate approvals produce one tool dispatch", async () => {
    const { run } = await start("bob", workflow({ tool: writeTool }), "승인할 가상 변경");
    const waiting = await poll("bob", run.id, ["waiting_approval"]);
    assert.equal(waiting.usage.toolCalls, 0);
    assert.equal(waiting.events.some(event => event.type === "tool_started"), false);
    assert.equal(waiting.approvals.length, 1);
    assert.equal(waiting.approvals[0].args.query, "승인할 가상 변경");
    assert.equal((await request("/api/runtime", "alice", { action: "approval.decide", id: waiting.id, approvalId: waiting.approvals[0].id, decision: "approve" })).status, 404);
    await Promise.all([decide("bob", waiting, "approve"), decide("bob", waiting, "approve")]);
    const done = await poll("bob", run.id, ["succeeded"]);
    assert.equal(done.usage.toolCalls, 1);
    assert.equal(done.events.filter(event => event.type === "tool_started").length, 1);
    assert.equal(done.approvals[0].status, "approved");
    await good("/api/runtime", "bob", { action: "run.resume", id: run.id }, 202);
    assert.equal((await poll("bob", run.id, ["succeeded"])).usage.toolCalls, 1);
  });
  await check("denied writes remain undispatched and the Agent receives the rejection", async () => {
    const { run } = await start("bob", workflow({ tool: writeTool }), "거절할 가상 변경");
    const waiting = await poll("bob", run.id, ["waiting_approval"]);
    await decide("bob", waiting, "deny");
    const done = await poll("bob", run.id, ["succeeded"]);
    assert.equal(done.usage.toolCalls, 0);
    assert.equal(done.approvals[0].status, "denied");
    assert.match(done.result, /거절/);
  });
  await check("cancelling a waiting approval prevents the pending external change", async () => {
    const { run } = await start("bob", workflow({ tool: writeTool }), "취소할 가상 변경");
    await poll("bob", run.id, ["waiting_approval"]);
    await good("/api/runtime", "bob", { action: "run.cancel", id: run.id }, 202);
    const done = await poll("bob", run.id, ["cancelled"]);
    assert.equal(done.usage.toolCalls, 0);
  });
  await check("resource edits do not change the pinned content of a waiting run", async () => {
    const { run } = await start("bob", workflow({ tool: writeTool, resourceId: resource.id }), "고정 버전 확인");
    const waiting = await poll("bob", run.id, ["waiting_approval"]);
    const changed = `${prefix} 수정된 새 내용`;
    await write("alice", "resource.update", { ...documentData, content: changed, visibility: "selected", allowedEmails: ["bob@flowly.test"] }, resource.id);
    await decide("bob", waiting, "approve");
    const done = await poll("bob", run.id, ["succeeded"]);
    assert.ok(done.result.includes(documentData.content));
    assert.equal(done.result.includes(changed), false);
  });
  await check("revoked sharing blocks approval resume and new preview or execution", async () => {
    const { run } = await start("bob", workflow({ tool: writeTool, resourceId: resource.id }), "공유 철회 확인");
    const waiting = await poll("bob", run.id, ["waiting_approval"]);
    await write("alice", "resource.update", { ...documentData, visibility: "private" }, resource.id);
    await decide("bob", waiting, "approve");
    const done = await poll("bob", run.id, ["failed"]);
    assert.equal(done.usage.toolCalls, 0);
    assert.match(done.error, /공유|권한/);
    assert.equal(await findResource("bob", resource.id), undefined);
    assert.equal((await request("/api/studio", "bob", { action: "workflow.save", data: saved, baseUpdatedAt: saved.updatedAt })).status, 403);
    assert.equal((await request("/api/studio", "bob", { action: "preview.run", workflow: saved, input: "철회 후 미리보기" })).status, 400);
    assert.equal((await request("/api/runtime", "bob", { action: "run.start", mode: "test", workflow: saved, input: "철회 후 실행", idempotencyKey: randomUUID() })).status, 400);
    const exportFlow = workflow({ tool: null, resourceId: resource.id });
    for (const language of ["node", "python"]) for (const kind of ["prompt", "agent"]) {
      const response = await exportRequest("bob", exportFlow, language, kind); assert.equal(response.status, 403); await response.arrayBuffer();
    }
  });
  console.log(`HTTP integration: ${passed} scenarios passed, ${skipped} skipped. External SSO/model/MCP API calls: 0.`);
} catch (error) {
  console.error(`FAIL after ${passed} successful scenarios: ${error instanceof Error ? error.message : "unknown failure"}`);
  process.exitCode = 1;
} finally {
  for (const remove of cleanup.reverse()) {
    try { await remove(); } catch { console.error("Cleanup could not remove one synthetic fixture; inspect integration-* entries in the local test database."); }
  }
}
