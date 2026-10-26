// 로컬 RAG 색인의 준비·평가·발행·철회·복구를 버전별로 관리한다. 내보낸 자료 사본을 원격 공유 철회로 회수하는 기능은 아니다.
import type { Resource } from "../app/lib/model";
import { parseKnowledgeConfig, type KnowledgeConfig } from "../domain/knowledge-config";
import { dataAt, cosine } from "./data-nodes";
import { argsHash, canonicalJson } from "./policy";
import type { Json, RuntimeDependencies } from "./types";
import { resourceSearchText } from "../domain/resource-document";

type Chunk = { resourceId: string; version: string; name: string; url: string; chunkIndex: number; excerpt: string; vectorKey?: string };
type Generation = { id: string; chunks: Chunk[]; model: string; mode: "lexical" | "vector"; signature: string; evaluation?: { passed: boolean; checks: { query: string; resourceId: string; passed: boolean }[]; tombstoneRevision: number }; publishedOnce?: boolean };
type State = { version: 1; ownerId: string; workflowId: string; indexKey: string; revision: number; sequence: number; tombstoneRevision: number; published: string | null; generations: Record<string, Generation>; vectors: Record<string, number[]>; revoked: string[]; operations: Record<string, { hash: string; result: Record<string, Json> }> };
// 저장과 권한 확인은 호출 환경이 제공한다. 벡터 방식일 때만 embed가 필요하며 로컬 문자열 검색은 모델을 쓰지 않는다.
export type KnowledgeContext = {
  ownerId: string; workflowId: string; operationId: string; resources: Resource[];
  memory: NonNullable<RuntimeDependencies["memory"]>;
  assertAccess(resourceIds: string[]): Promise<void>;
  embeddingModel?: string;
  embed?(texts: string[]): Promise<{ vectors: number[][]; model: string }>;
};
function fail(message: string): never { throw new Error(message); }
const output = (data: Record<string, Json>): Record<string, Json> => ({ text: canonicalJson(data), ...data });
const scalar = (input: Record<string, Json>, path: string | undefined): Json | undefined => path ? dataAt(input, path) : undefined;
const sorted = (ids: string[]) => [...new Set(ids)].sort();
function validateVectors(vectors: number[][], expected: number) {
  if (!Array.isArray(vectors) || vectors.length !== expected || vectors.some(v => !Array.isArray(v) || !v.length || v.length > 4096 || v.length !== vectors[0].length)) fail("지식 색인 임베딩 개수 또는 차원이 맞지 않아요.");
  vectors.forEach(v => cosine(v, v));
}

/** Durable local generations. Remote ACL changes cannot recall exported snapshots. */
// 소유자·워크플로·색인 키로 저장 범위를 나누고 operationId로 동일 변경의 중복 적용을 막는다.
export async function executeKnowledge(raw: KnowledgeConfig, input: Record<string, Json>, context: KnowledgeContext): Promise<Record<string, Json>> {
  const config = parseKnowledgeConfig(raw);
  if (!context.ownerId || !context.workflowId || !context.operationId) fail("지식 색인 소유자와 실행 범위를 확인해 주세요.");
  await context.assertAccess(config.resourceIds);
  const available = config.resourceIds.map(id => context.resources.find(r => r.id === id && ["document", "prompt"].includes(r.type)) ?? fail("지식 색인의 허용 자료 또는 종류를 확인해 주세요."));
  const key = `knowledge_${config.indexKey}`;
  const scope = { ownerId: context.ownerId, workflowId: context.workflowId, key };
  const stored = await context.memory({ ...scope, action: "read", operationId: `${context.operationId}:read`, trackOperation: false });
  const state = (stored.found ? structuredClone(stored.data) : { version: 1, ...scope, indexKey: config.indexKey, revision: 0, sequence: 0, tombstoneRevision: 0, published: null, generations: {}, vectors: {}, revoked: [], operations: {} }) as unknown as State;
  if (!state || state.version !== 1 || state.ownerId !== context.ownerId || state.workflowId !== context.workflowId || state.indexKey !== config.indexKey || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.revoked) || !state.generations || !state.vectors || !state.operations) fail("저장된 지식 색인의 범위 또는 형식이 올바르지 않아요.");
  const requestHash = await argsHash({ config, input });
  const operationKey = await argsHash({ operationId: context.operationId });
  if (config.action !== "query" && config.action !== "inspect" && state.operations[operationKey]) {
    if (state.operations[operationKey].hash !== requestHash) fail("완료된 지식 작업의 입력이 바뀌었어요.");
    return structuredClone(state.operations[operationKey].result);
  }
  const expected = scalar(input, config.expectedRevisionPath);
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected !== state.revision)) fail("색인 리비전이 바뀌었어요. 최신 상태를 확인하고 다시 요청해 주세요.");
  const previousRevision = state.revision;
  const generationValue = scalar(input, config.generationPath);
  const generation = generationValue === undefined ? state.published && state.generations[state.published] : typeof generationValue === "string" && state.generations[generationValue];
  const target = (): Generation => generation || fail("대상 색인 버전이 없어요. 먼저 준비·평가·발행해 주세요.");
  const allowed = new Set(config.resourceIds);
  const activeChunks = (g: Generation) => g.chunks.filter(c => allowed.has(c.resourceId) && !state.revoked.includes(c.resourceId));
  const search = async (g: Generation, query: string) => {
    if (g.mode !== (config.mode ?? "lexical")) fail("색인 검색 방식과 노드 설정이 달라요. 같은 검색 방식을 선택해 주세요.");
    if (typeof query !== "string" || !query.trim() || query.length > 2000) fail("지식 검색 질문은 비어 있지 않은 2,000자 이내 문자열이어야 해요.");
    const chunks = activeChunks(g); await context.assertAccess(sorted(chunks.map(c => c.resourceId)));
    let scores: number[];
    if (g.mode === "vector") {
      if (!context.embed || g.model !== (context.embeddingModel ?? "text-embedding-3-small")) fail("색인 임베딩 모델이 현재 설정과 달라요. 같은 모델로 조회하거나 새 버전을 준비해 주세요.");
      const embedded = await context.embed([query]);
      if (embedded.model !== g.model) fail("질문 임베딩 모델이 색인과 달라요.");
      validateVectors(embedded.vectors, 1);
      scores = chunks.map(c => cosine(state.vectors[c.vectorKey!] ?? [], embedded.vectors[0]));
    } else {
      const terms = sorted(query.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_]+/gu) ?? []);
      scores = chunks.map(c => terms.reduce((sum, term) => sum + (c.excerpt.toLocaleLowerCase("en-US").includes(term) ? 1 : 0), 0));
    }
    return chunks.map((c, i) => ({ resourceId: c.resourceId, version: c.version, name: c.name, url: c.url, chunkIndex: c.chunkIndex, excerpt: c.excerpt, score: scores[i] })).filter(m => g.mode === "vector" || m.score > 0).sort((a, b) => b.score - a.score || a.resourceId.localeCompare(b.resourceId, "en") || a.chunkIndex - b.chunkIndex).slice(0, config.topK ?? 3);
  };
  // 갱신 직전 자료 접근을 다시 확인하고 expectedRevision으로 동시 변경을 검사한다. 저장 성공 전에는 새 버전을 확정하지 않는다.
  const persist = async (data: Record<string, Json>) => {
    if (Object.keys(state.operations).length >= 128) fail("색인 변경 기록 128개 한도에 도달했어요. 새 색인 이름으로 보관을 분리해 주세요.");
    state.revision++;
    const result = output({ ...data, revision: state.revision, publishedGeneration: state.published });
    state.operations[operationKey] = { hash: requestHash, result };
    if (canonicalJson(state as unknown as Json).length > 200000) fail("지식 색인 저장 한도 200,000자에 도달했어요. 자료·조각 또는 버전 수를 줄여 주세요.");
    await context.assertAccess(config.resourceIds);
    await context.memory({ ...scope, operationId: `${context.operationId}:commit`, action: "write", value: state as unknown as Json, expectedRevision: previousRevision, trackOperation: false });
    return result;
  };
  if (config.action === "inspect") return output({ revision: state.revision, publishedGeneration: state.published, revoked: state.revoked.filter(id => allowed.has(id)), generations: Object.values(state.generations).map(g => ({ generation: g.id, mode: g.mode, model: g.model, chunkCount: activeChunks(g).length, evaluated: Boolean(g.evaluation?.passed && g.evaluation.tombstoneRevision === state.tombstoneRevision), publishedOnce: Boolean(g.publishedOnce) })) });
  // 조회는 현재 발행 버전만 허용하며 철회된 자료는 후보에서 제외한다. 준비된 미발행 버전은 평가에만 사용한다.
  if (config.action === "query") {
    const g = target(), query = scalar(input, config.queryPath ?? "text");
    if (state.published !== g.id) fail("현재 발행한 색인 버전만 조회할 수 있어요. 후보는 평가 후 발행해 주세요.");
    if (typeof query !== "string") fail("지식 검색 질문 경로가 문자열이 아니에요.");
    const matches = await search(g, query);
    return output({ generation: g.id, revision: state.revision, published: state.published === g.id, count: matches.length, matches });
  }
  if (config.action === "stage") {
    if (Object.keys(state.generations).length >= 8) fail("색인 버전 8개 한도에 도달했어요. 새 색인 이름으로 보관을 분리해 주세요.");
    const supplied = scalar(input, config.documentsPath);
    const documents = supplied === undefined ? available.filter(r => !state.revoked.includes(r.id)).map(r => ({ resourceId: r.id, version: r.updatedAt, content: resourceSearchText(r) })) : supplied;
    if (!Array.isArray(documents) || !documents.length || documents.length > 20) fail("갱신 문서는 1~20개 필요해요.");
    const changes = new Set<string>();
    const newChunks: Chunk[] = [];
    for (const doc of documents) {
      if (!doc || typeof doc !== "object" || Array.isArray(doc) || Object.keys(doc).some(k => !["resourceId", "version", "content"].includes(k)) || typeof doc.resourceId !== "string" || typeof doc.version !== "string" || !doc.version.trim() || doc.version.length > 100 || typeof doc.content !== "string" || !doc.content.trim() || doc.content.length > 40000 || !allowed.has(doc.resourceId) || changes.has(doc.resourceId) || state.revoked.includes(doc.resourceId)) fail("갱신 문서의 허용 ID·버전·본문 또는 철회 상태를 확인해 주세요.");
      changes.add(doc.resourceId); const resource = available.find(r => r.id === doc.resourceId)!;
      const chars = Array.from(doc.content), size = config.chunkSize ?? 700;
      for (let start = 0, index = 0; start < chars.length; start += size, index++) newChunks.push({ resourceId: doc.resourceId, version: doc.version, name: resource.name, url: resource.url, chunkIndex: index, excerpt: chars.slice(start, start + size).join("") });
    }
    const base = state.published && state.generations[state.published];
    const chunks = [...(base ? structuredClone(activeChunks(base).filter(c => !changes.has(c.resourceId))) : []), ...newChunks].sort((a, b) => a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : a.chunkIndex - b.chunkIndex);
    if (chunks.length > 100) fail("지식 색인은 버전당 100개 조각까지 저장할 수 있어요.");
    const mode = config.mode ?? "lexical", model = mode === "vector" ? context.embeddingModel ?? "text-embedding-3-small" : "";
    let embeddedChunks = 0;
    if (mode === "vector") {
      if (!context.embed) fail("지식 색인 임베딩 제공자가 미설정이에요.");
      const missing = new Map<string, string>();
      for (const chunk of chunks) { chunk.vectorKey = await argsHash({ resourceId: chunk.resourceId, model, excerpt: chunk.excerpt }); if (!state.vectors[chunk.vectorKey]) missing.set(chunk.vectorKey, chunk.excerpt); }
      if (missing.size) {
        const embedded = await context.embed([...missing.values()]); if (embedded.model !== model) fail("문서 임베딩 모델이 현재 설정과 달라요.");
        validateVectors(embedded.vectors, missing.size);
        [...missing.keys()].forEach((hash, i) => { state.vectors[hash] = embedded.vectors[i]; }); embeddedChunks = missing.size;
      }
    } else chunks.forEach(c => { delete c.vectorKey; });
    const id = `g${++state.sequence}`, signature = await argsHash({ chunks, model, mode });
    state.generations[id] = { id, chunks, model, mode, signature };
    return persist({ generation: id, status: "staged", chunkCount: chunks.length, embeddedChunks, reusedChunks: mode === "vector" ? chunks.length - embeddedChunks : 0, signature });
  }
  if (config.action === "evaluate") {
    const g = target();
    const checks = [];
    for (const sample of config.evaluation!) checks.push({ ...sample, passed: (await search(g, sample.query)).some(m => m.resourceId === sample.resourceId) });
    const passed = checks.every(c => c.passed);
    g.evaluation = { passed, checks, tombstoneRevision: state.tombstoneRevision };
    return persist({ generation: g.id, passed, checks });
  }
  if (config.action === "publish" || config.action === "rollback") {
    const g = target();
    if (!g.evaluation?.passed || g.evaluation.tombstoneRevision !== state.tombstoneRevision || (config.action === "rollback" && !g.publishedOnce)) fail("같은 철회 상태에서 검색 평가를 통과한 버전만 발행·복구할 수 있어요.");
    await context.assertAccess(sorted(activeChunks(g).map(c => c.resourceId)));
    state.published = g.id; g.publishedOnce = true;
    return persist({ generation: g.id, status: config.action === "rollback" ? "rolled_back" : "published" });
  }
  const ids = scalar(input, config.resourceIdsPath) ?? config.resourceIds;
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string" || !allowed.has(id))) fail("철회할 자료 ID는 허용 자료에서 선택해 주세요.");
  state.revoked = sorted([...state.revoked, ...(ids as string[])]); state.tombstoneRevision++;
  for (const g of Object.values(state.generations)) { g.chunks = g.chunks.filter(c => !state.revoked.includes(c.resourceId)); delete g.evaluation; g.signature = await argsHash({ chunks: g.chunks, model: g.model, mode: g.mode }); }
  const vectorKeys = new Set(Object.values(state.generations).flatMap(g => g.chunks.flatMap(c => c.vectorKey ? [c.vectorKey] : [])));
  for (const key of Object.keys(state.vectors)) if (!vectorKeys.has(key)) delete state.vectors[key];
  return persist({ status: "revoked", revoked: ids, tombstoneRevision: state.tombstoneRevision });
}
