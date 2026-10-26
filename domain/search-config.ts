/**
 * 유한한 후보 문제에 사용하는 트리/그래프 탐색 설정과 공통 기본값.
 * 모델의 내부 사고 원문이나 임의 실행 코드를 저장하는 구조가 아니며 탐색 예산을 명시적으로 제한한다.
 */
import { safeDataPath } from "./node-config";

/** A finite, registered problem contract; never executable model supplied code. */
export type SearchConfig = {
  mode: "tree" | "graph";
  itemsPath: string;
  targetPath: string;
  maxDepth: number;
  maxCandidates: number;
  maxIterations: number;
  branchFactor: number;
  beamWidth: number;
};
export const SEARCH_DEFAULTS: SearchConfig = { mode: "tree", itemsPath: "items", targetPath: "target", maxDepth: 4, maxCandidates: 24, maxIterations: 12, branchFactor: 3, beamWidth: 4 };
/**
 * 생략한 옵션에 기본값을 채우고 후보 수·깊이·반복·분기·빔 폭의 상한을 검사한다.
 */
export function parseSearchConfig(value: unknown): SearchConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("후보 탐색 설정은 객체여야 해요.");
  const supplied = value as Record<string, unknown>;
  if (Object.keys(supplied).some(key => !Object.hasOwn(SEARCH_DEFAULTS, key))) throw new Error("지원하지 않는 후보 탐색 설정이에요.");
  const config = { ...SEARCH_DEFAULTS, ...supplied };
  if (config.mode !== "tree" && config.mode !== "graph") throw new Error("트리 또는 그래프 탐색을 선택해 주세요.");
  for (const key of ["itemsPath", "targetPath"] as const) if (typeof config[key] !== "string" || !safeDataPath(config[key])) throw new Error("후보 탐색의 입력 경로를 확인해 주세요.");
  for (const [key, min, max] of [["maxDepth", 1, 8], ["maxCandidates", 2, 64], ["maxIterations", 1, 32], ["branchFactor", 1, 6], ["beamWidth", 1, 16]] as const) {
    if (!Number.isSafeInteger(config[key]) || Number(config[key]) < min || Number(config[key]) > max) throw new Error(`후보 탐색 ${key}는 ${min}~${max} 범위여야 해요.`);
  }
  return config as SearchConfig;
}
