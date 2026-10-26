/** 자료·첨부·내보낸 실행기가 공유하는 v1 확장 계약. 기존 content-only 자료에는 확장 필드를 강제하지 않는다. */
import type { DataSchema, Json } from "../runtime/types";

export const RESOURCE_CONTENT_MAX_CHARS = 200_000;
export const RESOURCE_METADATA_MAX_BYTES = 1_300_000;
export const RESOURCE_REQUEST_MAX_BYTES = 4_000_000;
export const RESOURCE_FILE_MAX_BYTES = 5_000_000;
export const RESOURCE_FILES_MAX_BYTES = 20_000_000;
export const RESOURCE_FILES_MAX_COUNT = 40;
export const EXPORT_RESOURCE_FILES_MAX_BYTES = 20_000_000;

/** 저장소 키와 소유권은 서버 전용이다. exportPath는 내보내기 생성기가 지정하며 웹 저장 요청에서는 신뢰하지 않는다. */
export type ResourceAttachment = {
  id: string; path: string; mimeType: string; size: number; sha256: string; createdAt: string; exportPath?: string;
};
export type PromptVariable = {
  name: string; type: DataSchema["type"]; required: boolean; defaultValue?: Json; description?: string;
};
export type PromptDefinition = {
  variables: PromptVariable[]; role?: string; goal?: string; outputFormat?: string; sampleInput?: Record<string, Json>;
};
/** 실행 ID를 노드에서 선택한 경우에만 코드를 실행한다. effect 표기와 무관하게 초기 구현의 코드 실행은 승인 대상이다. */
export type SkillExecutionDefinition = {
  id: string; language: "python" | "javascript"; entryFileId: string; inputSchema: DataSchema; outputSchema: DataSchema;
  dependencies: string[]; timeoutMs: number; maxOutputBytes: number; effect: "read" | "write";
};
export type SkillDefinition = { kind: "instruction" | "package" | "executable"; executions?: SkillExecutionDefinition[] };
export type DocumentDefinition = {
  source?: string; authoredAt?: string; sourceUpdatedAt?: string; originalFileId?: string;
  extractionStatus: "not_requested" | "pending_local" | "provided" | "failed"; extractedText?: string; extractionError?: string;
};
export type ResourceDetails = {
  version: 1; purpose?: string; whenToUse?: string; inputExample?: Json; outputExample?: Json; limitations?: string;
  verification?: { kind: "user_reported"; checkedAt: string; environment: string; scope: string; outcome: "passed" | "failed" };
  prompt?: PromptDefinition; skill?: SkillDefinition; document?: DocumentDefinition;
};
export type ResourceNodeConfig = {
  resourceBindings?: Record<string, string>; resourceValues?: Record<string, Json>;
  skillExecution?: { entryId: string; arguments: Record<string, Json>; bindings: Record<string, string> };
};
export type ResourceFilePayload = { resourceId: string; file: ResourceAttachment; bytes: Uint8Array };
export type ResourceVersion = { id: string; resourceId: string; number: number; createdAt: string; actorId: string; snapshot: import("../app/lib/model").Resource };
