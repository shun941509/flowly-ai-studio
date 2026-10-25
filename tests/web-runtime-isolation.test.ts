import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Execute the production HTTP handler and queue handler. Only authentication and
// persistence are replaced; a provider dispatch or any network request must fail.
test("web HTTP and persisted live queue reject execution before provider dispatch", async () => {
  const folder = await mkdtemp(join(tmpdir(), "flowly-web-isolation-"));
  const root = resolve(".");
  const stateSource = `
    export const state = { dispatches: 0, writes: 0, releases: 0, run: {
      id: "persisted-live", mode: "live", status: "queued", events: [],
      workflow: { definition: {} }, checkpoint: { calls: [] }
    }};
    export const user = { userId: "test-owner", email: "owner@example.test", displayName: "Test" };
    export function unexpected() { state.dispatches++; throw new Error("Unexpected execution dispatch"); }
    export const env = {
      FLOWLY_ENV: "development", FLOWLY_AUTH_MODE: "test", FLOWLY_TEST_RUNTIME: "true",
      OPENAI_API_KEY: "not-a-real-key", FLOWLY_MODEL: "not-a-real-model",
      DB: { prepare() { return { bind() { return { async first() { return user; } }; } }; } }
    };
  `;
  const stub = (body: string) => `import {state,user,env,unexpected} from "test-state"; ${body}`;
  const substitutions: Record<string, string> = {
    "cloudflare:workers": stub("export {env};"),
    "app/chatgpt-auth.ts": stub("export async function getChatGPTUser() { return user; }"),
    "domain/workflow.ts": stub("export const compileDefinition=unexpected; export const referencedResourceIds=()=>[];"),
    "domain/advanced-config.ts": "export const allNodes=()=>[];",
    "runtime/engine.ts": stub("export const executeRun=unexpected,createRun=unexpected,publicRun=unexpected,decideApproval=unexpected,decideReview=unexpected,submitInput=unexpected;"),
    "runtime/advanced.ts": "export const runTree=run=>[run];",
    "runtime/adapters.ts": stub("export class TestModelAdapter { constructor() {unexpected();} } export const createTestToolCaller=unexpected;"),
    "server/repositories/runtime.ts": stub(`export class RuntimeRepository {
      async claim() { return { run: state.run, save: async()=>{state.writes++;}, release: async()=>{state.releases++;}, isCancelled: async()=>false }; }
    }`),
    "server/repositories/resources.ts": "export const requireResources=async()=>[]; export const accessibleResources=async()=>[];",
    "server/execution-context.ts": stub("export const schedule=unexpected;"),
    "server/example-connections.ts": "export const registeredConnections=()=>[];",
    "server/request-hash.ts": stub("export const hashRequest=unexpected;"),
    "db/index.ts": stub("export const getDb=unexpected;"),
    "db/schema.ts": "export const users={};",
  };
  try {
    const result = await build({
      absWorkingDir: root, bundle: true, platform: "node", format: "esm", write: false,
      stdin: { contents: 'export {POST} from "./app/api/runtime/route.ts"; export {processRun} from "./server/runtime-service.ts"; export {state} from "test-state";', resolveDir: root },
      plugins: [{ name: "isolated-web-dependencies", setup(build) {
        build.onResolve({ filter: /.*/ }, args => {
          if (args.path === "test-state") return { path: args.path, namespace: "isolation" };
          if (args.path === "cloudflare:workers") return { path: args.path, namespace: "isolation" };
          if (!args.path.startsWith(".")) return;
          const path = resolve(args.resolveDir, args.path).slice(root.length + 1).replaceAll("\\", "/");
          const key = [path, `${path}.ts`, `${path}/index.ts`].find(key => Object.hasOwn(substitutions, key));
          if (key) return { path: key, namespace: "isolation" };
        });
        build.onLoad({ filter: /.*/, namespace: "isolation" }, args => ({ contents: args.path === "test-state" ? stateSource : substitutions[args.path], loader: "js" }));
      } }],
    });
    const entry = join(folder, "web-boundary.mjs");
    await writeFile(entry, result.outputFiles[0].text);
    const { POST, processRun, state } = await import(pathToFileURL(entry).href);
    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = async () => { networkCalls++; throw new Error("Network forbidden in web isolation test"); };
    try {
      const response = await POST(new Request("http://127.0.0.1/api/runtime", {
        method: "POST", headers: { origin: "http://127.0.0.1", "content-type": "application/json" },
        body: JSON.stringify({ action: "run.start", mode: "live", input: "Do not execute", workflow: {} }),
      }));
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /내보낸 뒤 본인의 API 키/);
      assert.equal(state.writes, 0, "Rejected HTTP requests must not create runs");
      await processRun("test-owner", "persisted-live");
      assert.equal(state.run.status, "failed");
      assert.match(state.run.error, /웹에서는 OpenAI를 호출하지/);
      assert.equal(state.writes, 1, "The blocked queued run must be durably marked failed");
      assert.equal(state.releases, 1);
      assert.equal(state.dispatches, 0);
      assert.equal(networkCalls, 0);
    } finally { globalThis.fetch = originalFetch; }
  } finally { await rm(folder, { recursive: true, force: true }); }
});
