/** Run with `pnpm exec tsx tests/scheduled-integration.ts` against `pnpm dev`.
 * Uses local D1 + signed test login and the actual scheduled handler. No provider calls.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRun } from "../runtime/engine";
import { sampleResources, templateWorkflow } from "../app/lib/model";
import { TEST_IDENTITIES } from "../server/auth/session";
import type { PublicRun, RuntimeCapabilities } from "../runtime/types";

const root = fileURLToPath(new URL("../", import.meta.url));
const origin = process.env.FLOWLY_TEST_ORIGIN || "http://127.0.0.1:5173";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(origin).hostname), "Scheduled integration is restricted to loopback.");
function query(sql: string): Record<string, unknown>[] {
  const result = spawnSync(process.execPath, ["--import", "./scripts/sites-env.mjs", "./node_modules/wrangler/bin/wrangler.js", "d1", "execute", "flowly-local", "--local", "--config", "wrangler.jsonc", "--persist-to", ".wrangler/state", "--command", sql, "--json"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, "Local D1 command failed. Check local migrations.");
  return JSON.parse(result.stdout)[0].results;
}
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const login = await fetch(`${origin}/api/auth/test`, { method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ identity: "alice", return_to: "/studio" }), signal: AbortSignal.timeout(15000) });
assert.equal(login.status, 303, "Local test login must be enabled.");
const cookie = login.headers.get("set-cookie")?.split(";")[0]; assert.ok(cookie);
const headers = { cookie };
assert.equal((await fetch(`${origin}/api/studio`, { headers })).status, 200);
const capabilitiesResponse = await fetch(`${origin}/api/runtime`, { headers }); assert.equal(capabilitiesResponse.status, 200);
const { capabilities } = await capabilitiesResponse.json() as { capabilities: RuntimeCapabilities };
assert.equal(capabilities.testEnabled, true);
assert.equal(capabilities.liveEnabled, false, "The web must never enable live model execution.");
const nonTest = query("SELECT COUNT(*) AS count FROM runtime_runs WHERE status IN ('queued','running','waiting_approval') AND json_extract(document,'$.mode')<>'test'");
assert.equal(nonTest[0].count, 0, "Refuse to process pre-existing live work.");
const owner = TEST_IDENTITIES.alice;
const fixtures = ["test", "live"].map(mode => createRun({ owner, mode: mode as "test" | "live", workflow: templateWorkflow("agent"), resources: sampleResources, input: "예약 처리 경로 검증용 가상 입력" }));
try {
  for (const [index, run] of fixtures.entries()) {
    run.createdAt = `2000-01-01T00:00:0${index}.000Z`;
    query(`INSERT INTO runtime_runs (id,owner_id,idempotency_key,request_hash,status,document,created_at,updated_at) VALUES (${quote(run.id)},${quote(owner.userId)},${quote(run.id)},'scheduled-fixture','queued',${quote(JSON.stringify(run))},${quote(run.createdAt)},${quote(run.updatedAt)})`);
  }
  const triggered = await fetch(`${origin}/__scheduled?cron=*+*+*+*+*`, { signal: AbortSignal.timeout(30000) });
  assert.equal(triggered.status, 200, `Scheduled handler returned ${triggered.status}. Start Wrangler with --test-scheduled.`);
  assert.match(await triggered.text(), /Ran scheduled event/);
  const result = query(`SELECT document FROM runtime_runs WHERE id IN (${fixtures.map(run => quote(run.id)).join(",")})`)
    .map(row => JSON.parse(String(row.document)));
  const testRun = result.find(run => run.mode === "test");
  const liveRun = result.find(run => run.mode === "live");
  assert.equal(testRun?.status, "succeeded"); assert.match(testRun.result, /실제 AI 답변 아님/);
  assert.equal(testRun.checkpoint.calls.filter((call: { status: string }) => call.status === "completed").length, 1);
  assert.equal(liveRun?.status, "failed"); assert.match(liveRun.error, /실행 설정 변경/); assert.equal(liveRun.checkpoint.calls.length, 0);
  const readBack = await fetch(`${origin}/api/runtime?id=${encodeURIComponent(testRun.id)}`, { headers });
  assert.equal(readBack.status, 200); assert.equal((await readBack.json() as { run: PublicRun }).run.status, "succeeded");
  console.log("PASS actual scheduled handler consumes durable test queue and persists one tool result");
  console.log("PASS web live queue is blocked before model or MCP dispatch");
  console.log("External model/MCP calls: 0");
} finally {
  query(`DELETE FROM runtime_runs WHERE owner_id=${quote(owner.userId)} AND id IN (${fixtures.map(run => quote(run.id)).join(",")})`);
}
