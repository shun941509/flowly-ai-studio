import test from "node:test";
import assert from "node:assert/strict";
import { replaceStateFile } from "../export-runtime/atomic-replace";

const error = (code: string) => Object.assign(new Error(code), { code });
test("Windows sharing contention retries only the same checkpoint replacement and rechecks ownership", async () => {
  let calls = 0, locks = 0; const waits: number[] = [];
  await replaceStateFile("unchanged.tmp", "run.json", async () => { locks++; }, { platform: "win32", rename: async (from, to) => { assert.equal(from, "unchanged.tmp"); assert.equal(to, "run.json"); if (++calls < 3) throw error("EPERM"); }, delay: async ms => { waits.push(ms); } });
  assert.equal(calls, 3); assert.equal(locks, 3); assert.deepEqual(waits, [20, 40]);
});
test("permanent Windows denial fails after a bounded 620ms retry budget", async () => {
  let calls = 0, total = 0;
  await assert.rejects(replaceStateFile("a", "b", async () => {}, { platform: "win32", rename: async () => { calls++; throw error("EBUSY"); }, delay: async ms => { total += ms; } }), { code: "EBUSY" });
  assert.equal(calls, 6); assert.equal(total, 620);
});
test("lost ownership during contention prevents the next replacement", async () => {
  let locks = 0, calls = 0;
  await assert.rejects(replaceStateFile("a", "b", async () => { if (++locks > 1) throw new Error("lost lock"); }, { platform: "win32", rename: async () => { calls++; throw error("EPERM"); }, delay: async () => {} }), /lost lock/);
  assert.equal(calls, 1);
});
test("missing source, storage exhaustion and permission errors are not replayed", async () => {
  for (const code of ["ENOENT", "ENOSPC", "EACCES", "EIO"]) {
    let calls = 0;
    await assert.rejects(replaceStateFile("a", "b", async () => {}, { platform: "win32", rename: async () => { calls++; throw error(code); }, delay: async () => { assert.fail("must not wait"); } }), { code });
    assert.equal(calls, 1);
  }
});
test("POSIX replacement failures retain immediate failure semantics", async () => {
  await assert.rejects(replaceStateFile("a", "b", async () => {}, { platform: "linux", rename: async () => { throw error("EPERM"); }, delay: async () => { assert.fail("must not wait"); } }), { code: "EPERM" });
});
