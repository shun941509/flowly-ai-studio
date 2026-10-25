import { parseSearchConfig, type SearchConfig } from "../domain/search-config";
import { dataAt } from "./data-nodes";
import { argsHash, canonicalJson, redactText } from "./policy";
import type { Json } from "./types";
export type { SearchConfig } from "../domain/search-config";

type Obj = Record<string, Json>;
type CandidateStatus = "frontier" | "expanded" | "dead_end" | "pruned" | "invalidated" | "solution";
export type SearchCandidate = { id: string; revision: number; items: string[]; parents: { id: string; revision: number }[]; depth: number; total: number; distance: number; status: CandidateStatus };
export type SearchState = {
  version: 1; configHash: string; inputHash: string; integrity: string;
  iteration: number; candidates: SearchCandidate[]; frontier: string[];
  events: { type: string; iteration: number; candidateId?: string; details?: Json }[];
  status: "searching" | "solved" | "exhausted" | "limit";
  pending?: { selectedId: string; request: Obj; reply?: Obj };
};
export type SearchHooks = { model(prompt: string, input: Obj): Promise<Obj>; persist(state: SearchState): Promise<void>; check(): Promise<void> };
function fail(text: string): never { throw new Error(text); }
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail("후보 탐색 데이터는 객체여야 해요.");
const active = (c: SearchCandidate) => !["pruned", "dead_end", "invalidated"].includes(c.status);
const clone = <T>(value: T): T => structuredClone(value);
function problem(config: SearchConfig, input: Obj) {
  const raw = dataAt(input, config.itemsPath), target = dataAt(input, config.targetPath);
  if (!Array.isArray(raw) || !raw.length || raw.length > 20 || !Number.isSafeInteger(target) || Number(target) < 1 || Number(target) > 10000000) fail("후보 탐색에는 1~20개 항목과 양의 정수 목표가 필요해요.");
  const items = (raw as Json[]).map(value => { const item = record(value); if (Object.keys(item).some(key => !["id", "value"].includes(key)) || typeof item.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(item.id) || !Number.isSafeInteger(item.value) || Number(item.value) < 1 || Number(item.value) > 1000000) fail("탐색 항목의 ID와 양의 정수 값을 확인해 주세요."); return { id: item.id as string, value: item.value as number }; });
  if (new Set(items.map(item => item.id)).size !== items.length) fail("탐색 항목 ID가 중복되었어요.");
  return { items, target: target as number };
}
export const SEARCH_PROMPT = "FLOWLY_CANDIDATE_SEARCH: 원래 problem의 항목 ID만 사용하여 목표 합계를 찾는 공개 후보를 제안하세요. JSON {actions:[{type:'create',items:[ID],parents:[후보ID]} 또는 {type:'revise',id:후보ID,items:[ID]}],summary?:'짧은 공개 작업 설명'}만 반환하세요. 합계, 점수, 성공 여부는 실행기가 원본 데이터로 계산합니다. tree에서는 selected 후보의 항목을 포함하는 자식만 만드세요. graph에서는 현재 유효 후보를 최대 3개 병합하거나 기존 후보를 수정할 수 있어요. 수정한 조상의 모든 자손은 폐기됩니다. 내부 사고 과정이나 비공개 추론을 작성하지 마세요. 더 진행할 수 없으면 actions:[]를 반환하세요.";

/** Persist request, then provider reply, then the entire validated transition separately. */
export async function runCandidateSearch(rawConfig: SearchConfig, input: Obj, saved: SearchState | undefined, hooks: SearchHooks): Promise<Obj> {
  const config = parseSearchConfig(rawConfig), source = problem(config, input);
  const configHash = await argsHash(config as unknown as Obj), inputHash = await argsHash(input);
  let state: SearchState;
  const hash = async (s: SearchState) => argsHash(Object.fromEntries(Object.entries(s).filter(([key]) => key !== "integrity")) as Obj);
  const persist = async () => { state.integrity = await hash(state); await hooks.persist(clone(state)); };
  if (saved) {
    state = clone(saved);
    if (state.version !== 1 || state.configHash !== configHash || state.inputHash !== inputHash || state.integrity !== await hash(state)) fail("저장된 후보 탐색의 입력·설정·체크포인트가 달라졌어요.");
  } else {
    state = { version: 1, configHash, inputHash, integrity: "", iteration: 0, candidates: [{ id: "c0", revision: 1, items: [], parents: [], depth: 0, total: 0, distance: source.target, status: "frontier" }], frontier: ["c0"], events: [], status: "searching" };
    await persist();
  }
  const values = new Map(source.items.map(item => [item.id, item.value]));
  const publicReply = (value: unknown): Obj => {
    const response = record(value);
    if (Object.keys(response).some(key => !["actions", "summary"].includes(key)) || !Array.isArray(response.actions) || response.actions.length > config.branchFactor || response.summary !== undefined && (typeof response.summary !== "string" || response.summary.length > 300)) fail("후보 제안은 허용된 actions와 짧은 공개 설명만 포함할 수 있어요.");
    for (const value of response.actions) {
      const action = record(value), revise = action.type === "revise";
      if (action.type !== "create" && !revise || Object.keys(action).some(key => !(revise ? ["type", "id", "items"] : ["type", "items", "parents"]).includes(key)) || !Array.isArray(action.items) || action.items.length < 1 || action.items.length > source.items.length || action.items.some(id => typeof id !== "string" || !values.has(id)) || new Set(action.items).size !== action.items.length) fail("후보는 원래 항목 ID를 중복 없이 사용해야 해요.");
      if (revise && (typeof action.id !== "string" || !/^c\d{1,3}$/.test(action.id)) || action.parents !== undefined && (!Array.isArray(action.parents) || action.parents.length < 1 || action.parents.length > 3 || action.parents.some(id => typeof id !== "string" || !/^c\d{1,3}$/.test(id)))) fail("후보의 부모 연결을 확인해 주세요.");
    }
    return { actions: clone(response.actions) as Json[], ...(typeof response.summary === "string" ? { summary: redactText(response.summary) } : {}) };
  };
  const event = (type: string, candidateId?: string, details?: Json) => state.events.push({ type, iteration: state.iteration, ...(candidateId ? { candidateId } : {}), ...(details !== undefined ? { details } : {}) });
  const ranked = () => state.candidates.filter(c => c.status === "frontier").sort((a, b) => a.distance - b.distance || a.depth - b.depth || Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const rebuild = () => { const ordered = ranked(); for (const candidate of ordered.slice(config.beamWidth)) { candidate.status = "pruned"; event("pruned", candidate.id); } state.frontier = ordered.slice(0, config.beamWidth).map(c => c.id); };
  while (state.status === "searching") {
    await hooks.check();
    if (!state.pending) {
      if (state.iteration >= config.maxIterations || state.candidates.length >= config.maxCandidates) { state.status = "limit"; event("limit"); await persist(); break; }
      const selected = state.candidates.find(c => c.id === state.frontier[0]);
      if (!selected) { state.status = "exhausted"; event("exhausted"); await persist(); break; }
      state.pending = { selectedId: selected.id, request: { mode: config.mode, problem: source, selected: clone(selected) as unknown as Json, candidates: state.candidates.filter(active).map(c => clone(c) as unknown as Json), limits: { branchFactor: config.branchFactor, remainingCandidates: config.maxCandidates - state.candidates.length, maxDepth: config.maxDepth } } };
      await persist();
    }
    if (!state.pending.reply) {
      await hooks.check();
      const response = await hooks.model(SEARCH_PROMPT, clone(state.pending.request));
      canonicalJson(response); state.pending.reply = publicReply(response); await persist();
    }
    await hooks.check();
    // Work on a copy; a rejected batch never commits half a revision or a partial merge.
    state = clone(state);
    const pending = state.pending!, response = publicReply(pending.reply), actions = response.actions as Json[];
    state.iteration++;
    const selected = state.candidates.find(c => c.id === pending.selectedId)!;
    if (selected.status === "frontier") selected.status = "expanded";
    let created = 0;
    for (const rawAction of actions) {
      const action = record(rawAction), revise = action.type === "revise";
      if (action.type !== "create" && !revise || Object.keys(action).some(key => !(revise ? ["type", "id", "items"] : ["type", "items", "parents"]).includes(key)) || !Array.isArray(action.items) || action.items.length < 1 || action.items.length > source.items.length || action.items.some(id => typeof id !== "string" || !values.has(id)) || new Set(action.items).size !== action.items.length) fail("후보는 원래 항목 ID를 중복 없이 사용해야 해요.");
      const items = [...action.items as string[]].sort();
      let candidate: SearchCandidate | undefined;
      let parents: SearchCandidate[];
      if (revise) {
        if (config.mode !== "graph" || typeof action.id !== "string" || action.id === "c0") fail("트리에서는 후보를 수정할 수 없고 루트 후보는 변경할 수 없어요.");
        candidate = state.candidates.find(c => c.id === action.id);
        if (!candidate || !active(candidate)) fail("수정할 유효 후보가 없어요.");
        parents = candidate.parents.map(ref => state.candidates.find(c => c.id === ref.id && c.revision === ref.revision && active(c)) ?? fail("후보의 선행 버전이 유효하지 않아요."));
      } else {
        if (state.candidates.length >= config.maxCandidates) fail("후보 개수 한도를 넘긴 제안이에요.");
        const refs = action.parents ?? [selected.id];
        if (!Array.isArray(refs) || refs.length < 1 || refs.length > (config.mode === "tree" ? 1 : 3) || refs.some(id => typeof id !== "string") || new Set(refs).size !== refs.length || config.mode === "tree" && refs[0] !== selected.id) fail("후보의 부모 연결을 확인해 주세요.");
        parents = refs.map(id => state.candidates.find(c => c.id === id && active(c)) ?? fail("병합할 유효한 부모 후보가 없어요."));
      }
      if (parents.some(p => p.items.some(id => !items.includes(id)))) fail("새 후보는 부모 후보의 항목을 모두 포함해야 해요.");
      const depth = 1 + Math.max(...parents.map(p => p.depth));
      if (depth > config.maxDepth) fail("후보 깊이 한도를 넘긴 제안이에요.");
      if (!revise && state.candidates.some(c => active(c) && c.items.join("|") === items.join("|"))) { event("duplicate_skipped"); continue; }
      if (revise) {
        const invalid = new Set([candidate!.id]);
        for (const descendant of state.candidates) if (descendant.id !== candidate!.id && descendant.parents.some(ref => invalid.has(ref.id))) { descendant.status = "invalidated"; invalid.add(descendant.id); event("invalidated", descendant.id, { ancestor: candidate!.id }); }
      }
      const total = items.reduce((sum, id) => sum + values.get(id)!, 0), status: CandidateStatus = total === source.target ? "solution" : total > source.target || depth === config.maxDepth ? "dead_end" : "frontier";
      const next: SearchCandidate = { id: candidate?.id ?? `c${state.candidates.length}`, revision: (candidate?.revision ?? 0) + 1, items, parents: parents.map(p => ({ id: p.id, revision: p.revision })), depth, total, distance: Math.abs(source.target - total), status };
      if (candidate) Object.assign(candidate, next); else { state.candidates.push(next); created++; }
      event(revise ? "revised" : parents.length > 1 ? "merged" : "created", next.id, { total, status, parents: next.parents });
    }
    if (response.summary !== undefined) event("summary", selected.id, redactText(response.summary as string));
    const continuation = state.candidates.some(c => c.parents.some(parent => parent.id === selected.id) && (c.status === "frontier" || c.status === "solution"));
    if (config.mode === "tree" ? !continuation : !created && !actions.some(action => record(action).type === "revise")) { if (config.mode === "tree" && selected.status === "expanded") selected.status = "dead_end"; event("backtracked", selected.id); }
    delete state.pending;
    if (state.candidates.some(c => c.status === "solution")) state.status = "solved";
    rebuild(); await persist();
  }
  const winner = state.candidates.find(c => c.status === "solution");
  const data: Obj = { mode: config.mode, status: state.status, solved: !!winner, target: source.target, selected: winner?.items ?? [], total: winner?.total ?? 0, iterations: state.iteration, candidates: state.candidates as unknown as Json, events: state.events as unknown as Json };
  return { text: canonicalJson(data), data };
}
