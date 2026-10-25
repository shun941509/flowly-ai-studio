import { safeDataPath } from "./node-config";

export type KnowledgeConfig = {
  action: "stage" | "evaluate" | "publish" | "query" | "revoke" | "rollback" | "inspect";
  indexKey: string;
  resourceIds: string[];
  mode?: "lexical" | "vector";
  chunkSize?: number;
  topK?: number;
  generationPath?: string;
  expectedRevisionPath?: string;
  documentsPath?: string;
  resourceIdsPath?: string;
  queryPath?: string;
  evaluation?: { query: string; resourceId: string }[];
};

export function parseKnowledgeConfig(value: unknown): KnowledgeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("지식 색인 설정은 객체여야 해요.");
  const c = value as Record<string, unknown>;
  if (Object.keys(c).some(k => !["action", "indexKey", "resourceIds", "mode", "chunkSize", "topK", "generationPath", "expectedRevisionPath", "documentsPath", "resourceIdsPath", "queryPath", "evaluation"].includes(k))) throw new Error("지원하지 않는 지식 색인 설정이에요.");
  if (!["stage", "evaluate", "publish", "query", "revoke", "rollback", "inspect"].includes(String(c.action))) throw new Error("지식 색인 작업을 선택해 주세요.");
  if (typeof c.indexKey !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,59}$/.test(c.indexKey) || ["constructor", "prototype", "__proto__"].includes(c.indexKey)) throw new Error("색인 이름은 영문으로 시작하는 60자 이내 이름이어야 해요.");
  if (!Array.isArray(c.resourceIds) || c.resourceIds.length < 1 || c.resourceIds.length > 20 || new Set(c.resourceIds).size !== c.resourceIds.length || c.resourceIds.some(id => typeof id !== "string" || !id || id.length > 100)) throw new Error("허용 자료를 중복 없이 1~20개 선택해 주세요.");
  if (c.mode !== undefined && !["lexical", "vector"].includes(String(c.mode))) throw new Error("지식 색인 검색 방식을 확인해 주세요.");
  for (const [key, min, max] of [["chunkSize", 200, 2000], ["topK", 1, 10]] as const) if (c[key] !== undefined && (!Number.isInteger(c[key]) || Number(c[key]) < min || Number(c[key]) > max)) throw new Error("조각 크기 또는 검색 개수 한도를 확인해 주세요.");
  for (const key of ["generationPath", "expectedRevisionPath", "documentsPath", "resourceIdsPath", "queryPath"]) if (c[key] !== undefined && (typeof c[key] !== "string" || !safeDataPath(c[key] as string))) throw new Error("지식 색인의 입력 경로를 확인해 주세요.");
  if (["evaluate", "publish", "rollback"].includes(c.action as string) && !c.generationPath) throw new Error("작업 대상 색인 버전 경로가 필요해요.");
  if (c.evaluation !== undefined) {
    if (!Array.isArray(c.evaluation) || !c.evaluation.length || c.evaluation.length > 10 || c.evaluation.some(v => !v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !["query", "resourceId"].includes(k)) || typeof v.query !== "string" || !v.query.trim() || v.query.length > 500 || !(c.resourceIds as string[]).includes(v.resourceId))) throw new Error("평가 질문과 허용 자료의 정답 ID를 1~10개 등록해 주세요.");
  }
  if (c.action === "evaluate" && !c.evaluation) throw new Error("발행 전 검색 평가 질문이 필요해요.");
  return structuredClone(c) as KnowledgeConfig;
}
