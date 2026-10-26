// Node 실행 기록·메모리·벡터 캐시를 로컬 파일에 지속 저장한다. 프로세스 잠금과 임시 파일 교체를 함께 사용한다.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { replaceStateFile } from "./atomic-replace";
import { join, resolve } from "node:path";
import type { Json, RuntimeDependencies, RuntimeRun } from "../runtime/types";
import { canonicalJson } from "../runtime/policy";
import { validateJson } from "../domain/node-config";

export type StoredRun = { version: 1; packageHash: string; run: RuntimeRun };
type Lock = { pid: number; nonce: string };
const isCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException)?.code === code;
export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export async function readLimited(path: string, maximum: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    if ((await handle.stat()).size > maximum) throw new Error("파일 크기가 허용 한도를 넘었어요.");
    const text = await handle.readFile("utf8");
    if (Buffer.byteLength(text) > maximum) throw new Error("파일 크기가 허용 한도를 넘었어요.");
    return text;
  } finally { await handle.close(); }
}

/** Exclusive process lock + fsync/rename checkpoints. Locks never expire during an external operation. */
// 잠금은 시간 경과로 만료시키지 않는다. 외부 작업 중 잠금을 빼앗으면 중복 쓰기가 생길 수 있어 종료된 PID만 unlock으로 회수한다.
export class FileRunStore {
  readonly directory: string;
  private lock?: Lock;
  private memoryQueue: Promise<unknown> = Promise.resolve();
  constructor(directory: string) { this.directory = resolve(directory); }
  private path(id: string) {
    if (!/^run_[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("실행 ID 형식이 올바르지 않아요.");
    return join(this.directory, `${id}.json`);
  }
  private get lockPath() { return join(this.directory, ".runner.lock"); }
  private get unlockPath() { return join(this.directory, ".unlock.lock"); }
  async acquire(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { await stat(this.unlockPath); throw new Error("잠금 복구가 진행 중이에요. 잠시 후 다시 실행해 주세요."); } catch (error) { if (!isCode(error, "ENOENT")) throw error; }
    let handle;
    try { handle = await open(this.lockPath, "wx", 0o600); }
    catch (error) { if (isCode(error, "EEXIST")) throw new Error("다른 실행기가 사용 중이거나 중단된 잠금이 남아 있어요. 종료된 실행기라면 unlock 명령을 사용해 주세요."); throw error; }
    const lock = { pid: process.pid, nonce: randomUUID() };
    try { await handle.writeFile(JSON.stringify(lock)); await handle.sync(); this.lock = lock; }
    finally { await handle.close(); }
    try { await stat(this.unlockPath); await this.release(); throw new Error("잠금 복구와 겹쳤어요. 다시 실행해 주세요."); } catch (error) { if (!isCode(error, "ENOENT")) throw error; }
  }
  async assertLock() {
    let value: Lock;
    try { value = JSON.parse(await readFile(this.lockPath, "utf8")); } catch { throw new Error("실행 저장 잠금을 잃었어요. 외부 작업을 중단했어요."); }
    if (!this.lock || value.nonce !== this.lock.nonce || value.pid !== process.pid) throw new Error("실행 저장 잠금을 잃었어요. 외부 작업을 중단했어요.");
  }
  async release() {
    if (!this.lock) return;
    try { await this.assertLock(); await unlink(this.lockPath); } finally { this.lock = undefined; }
  }
  async unlock(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let gate;
    try { gate = await open(this.unlockPath, "wx", 0o600); }
    catch { throw new Error("다른 잠금 복구가 진행 중이에요. .unlock.lock이 남았다면 모든 실행기를 종료한 뒤 확인해 주세요."); }
    try {
      let lock: Lock;
      try { lock = JSON.parse(await readLimited(this.lockPath, 2000)); } catch (error) { if (isCode(error, "ENOENT")) return; throw new Error("잠금 파일을 확인할 수 없어요. 모든 실행기가 종료됐는지 확인하고 잠금 파일을 직접 점검해 주세요."); }
      if (!Number.isSafeInteger(lock.pid) || lock.pid < 1 || typeof lock.nonce !== "string") throw new Error("잠금 파일 형식이 올바르지 않아요.");
      try { process.kill(lock.pid, 0); throw new Error("실행 프로세스가 살아 있어 잠금을 해제하지 않았어요."); }
      catch (error) { if (!isCode(error, "ESRCH")) throw error; }
      await unlink(this.lockPath);
    } finally { await gate.close(); await unlink(this.unlockPath); }
  }
  async load(id: string): Promise<StoredRun> {
    const value = JSON.parse(await readLimited(this.path(id), 32000000)) as StoredRun;
    if (value.version !== 1 || value.run?.id !== id || typeof value.packageHash !== "string") throw new Error("실행 기록 형식이 올바르지 않아요.");
    return value;
  }
  // 동일 프로세스의 병렬 자식 메모리 작업을 큐로 직렬화하고 소유자/워크플로 범위를 해시로 나눈다.
  memory: NonNullable<RuntimeDependencies["memory"]> = operation => {
    const job = this.memoryQueue.then(async () => {
      await this.assertLock();
      if (!operation.ownerId || !operation.workflowId || !operation.operationId || !/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(operation.key) || ["__proto__", "constructor", "prototype"].includes(operation.key)) throw new Error("메모리 범위와 키를 확인해 주세요.");
      const scope = digest(JSON.stringify([operation.ownerId, operation.workflowId]));
      const target = join(this.directory, `.memory-${scope}.json`);
      type MemoryRecord = { version: 1; values: Record<string, Json>; versioned?: Record<string, boolean>; expires?: Record<string, string>; operations: Record<string, { fingerprint: string; data: Json; found: boolean; expiresAt?: string }> };
      let record: MemoryRecord;
      try { record = JSON.parse(await readLimited(target, 8000000)); }
      catch (error) { if (!isCode(error, "ENOENT")) throw error; record = { version: 1, values: {}, operations: {} }; }
      if (record.version !== 1 || !record.values || !record.operations) throw new Error("메모리 저장 형식을 확인해 주세요.");
      const fingerprint = digest(canonicalJson({ ...(operation.expectedRevision !== undefined ? {expectedRevision: operation.expectedRevision} : {}), action: operation.action, key: operation.key, value: operation.value ?? null, defaultValue: operation.defaultValue ?? null, ...(operation.ttlSeconds ? { ttlSeconds: operation.ttlSeconds } : {}) }));
      const operationKey = digest(operation.operationId);
      if (operation.trackOperation !== false && Object.hasOwn(record.operations, operationKey)) {
        const prior = record.operations[operationKey];
        if (prior.fingerprint !== fingerprint) throw new Error("이미 저장한 메모리 작업의 입력이 바뀌었어요.");
        if (operation.action === "read" && prior.expiresAt && Date.parse(prior.expiresAt) <= Date.now()) return { data: operation.defaultValue ?? null, found: false };
        return { data: structuredClone(prior.data), found: prior.found };
      }
      if (operation.trackOperation !== false && Object.keys(record.operations).length >= 10000) throw new Error("메모리 작업 기록 한도에 도달했어요. 상태 폴더 보관 정책을 확인해 주세요.");
      record.expires ??= {};
      record.versioned ??= {};
      if (typeof record.versioned !== "object" || Array.isArray(record.versioned) || Object.values(record.versioned).some(value => typeof value !== "boolean")) throw new Error("기억 버전 저장 형식을 확인해 주세요.");
      if (record.versioned[operation.key] && operation.action !== "read" && operation.expectedRevision === undefined) throw new Error("버전으로 관리되는 기억은 버전 검사 없이 변경하거나 삭제할 수 없어요.");
      if (record.expires[operation.key] && Date.parse(record.expires[operation.key]) <= Date.now()) { delete record.values[operation.key]; delete record.expires[operation.key]; }
      if (operation.expectedRevision !== undefined) {
        if (operation.action !== "write" || operation.ttlSeconds || !operation.value || typeof operation.value !== "object" || Array.isArray(operation.value) || operation.value.revision !== operation.expectedRevision + 1) throw new Error("버전 검사 쓰기에는 만료 시간 없이 다음 revision 객체가 필요해요.");
        const current = record.values[operation.key];
        const revision = current && typeof current === "object" && !Array.isArray(current) ? current.revision ?? 0 : 0;
        if (!Number.isSafeInteger(operation.expectedRevision) || !Number.isSafeInteger(operation.expectedRevision + 1) || operation.expectedRevision < 0 || revision !== operation.expectedRevision) throw new Error("기억 또는 지식 색인의 버전이 바뀌었어요. 최신 상태를 확인한 뒤 다시 실행해 주세요.");
        record.versioned[operation.key] = true;
      }
      const found = Object.hasOwn(record.values, operation.key);
      let result = { data: found ? record.values[operation.key] : operation.defaultValue ?? null, found };
      if (operation.action === "write") { if (operation.value === undefined) throw new Error("저장할 메모리 값이 없어요."); canonicalJson(operation.value); record.values[operation.key] = structuredClone(operation.value); if (operation.ttlSeconds) record.expires[operation.key] = new Date(Date.now() + operation.ttlSeconds * 1000).toISOString(); else delete record.expires[operation.key]; result = { data: operation.value, found: true }; }
      else if (operation.action === "delete") { delete record.values[operation.key]; delete record.expires[operation.key]; result = { data: null, found }; }
      else if (operation.action !== "read") throw new Error("메모리 작업 종류를 확인해 주세요.");
      if (operation.trackOperation !== false) record.operations[operationKey] = { fingerprint, ...structuredClone(result), ...(operation.action === "read" && record.expires[operation.key] ? { expiresAt: record.expires[operation.key] } : {}) };
      const serialized = JSON.stringify(record); if (Buffer.byteLength(serialized) > 8000000) throw new Error("메모리 저장 한도에 도달했어요.");
      const temp = join(this.directory, `.memory-${scope}.${randomUUID()}.tmp`);
      const handle = await open(temp, "wx", 0o600);
      try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
      try { await replaceStateFile(temp, target, () => this.assertLock()); if (process.platform !== "win32") { const directory = await open(this.directory, "r"); try { await directory.sync(); } finally { await directory.close(); } } }
      finally { await unlink(temp).catch(error => { if (!isCode(error, "ENOENT")) throw error; }); }
      return structuredClone(result);
    });
    this.memoryQueue = job.catch(() => {});
    return job;
  };
  vectorCache: NonNullable<RuntimeDependencies["vectorCache"]> = async (key, value) => {
    await this.assertLock();
    const target = join(this.directory, `.vector-${digest(key)}.json`);
    if (value === undefined) { try { return JSON.parse(await readLimited(target, 16000000)) as Json; } catch (error) { if (isCode(error, "ENOENT")) return undefined; throw error; } }
    validateJson(value); const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > 16000000) throw new Error("벡터 인덱스 저장 한도에 도달했어요.");
    const temp = join(this.directory, `.vector-${randomUUID()}.tmp`), handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
    try { await replaceStateFile(temp, target, () => this.assertLock()); } finally { await unlink(temp).catch(error => { if (!isCode(error, "ENOENT")) throw error; }); }
    return value;
  };
  // 실행 전체를 임시 파일에 기록하고 fsync 후 교체한다. 저장 실패는 엔진의 외부 호출 진행을 중단시키는 경계다.
  async save(run: RuntimeRun, packageHash: string, create = false) {
    await this.assertLock();
    const serialized = JSON.stringify({ version: 1, packageHash, run } satisfies StoredRun);
    if (Buffer.byteLength(serialized) > 32000000) throw new Error("실행 기록이 32MB 한도에 도달했어요. 자료와 입력을 줄여 새로 실행해 주세요.");
    const target = this.path(run.id);
    if (create) { try { await stat(target); throw new Error("같은 실행 ID가 이미 있어요."); } catch (error) { if (!isCode(error, "ENOENT")) throw error; } }
    const temp = join(this.directory, `.${run.id}.${randomUUID()}.tmp`);
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(serialized); await handle.sync();
    } finally { await handle.close(); }
    try {
      await replaceStateFile(temp, target, () => this.assertLock());
      // POSIX supports directory fsync. Windows rename is atomic but directory handles are unavailable.
      if (process.platform !== "win32") { const directory = await open(this.directory, "r"); try { await directory.sync(); } finally { await directory.close(); } }
    } finally { await unlink(temp).catch(error => { if (!isCode(error, "ENOENT")) throw error; }); }
  }
}
