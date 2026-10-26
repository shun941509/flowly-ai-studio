/** 내보낸 자료의 경로와 바이트 계약. 저장소 주소나 사용자 입력 경로를 ZIP 경로로 직접 사용하지 않는다. */
import type { Resource } from "../app/lib/model";
import type { ResourceAttachment } from "./resource-contract";
import { safeResourcePath } from "./resource-validation";

export function safeResourceFilePath(path: string): boolean {
  try { return safeResourcePath(path) === path; } catch { return false; }
}

const slug = (id: string) => id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 35) || "registered";
export function skillExportName(index: number, id: string): string { return `flowly-skill-${String(index + 1).padStart(3, "0")}-${slug(id)}`; }

export function resourceExportDirectory(resources: Pick<Resource, "id" | "type">[], resourceId: string): string {
  const index = resources.findIndex(resource => resource.id === resourceId), resource = resources[index];
  if (!resource) throw new Error("내보낼 자료를 찾을 수 없어요.");
  if (resource.type === "skill") return `skills/${skillExportName(resources.filter(item => item.type === "skill").findIndex(item => item.id === resourceId), resourceId)}`;
  return `inputs/resources/resource-${String(index + 1).padStart(3, "0")}-${slug(resourceId)}`;
}

/** 실행기나 다른 자료 파일을 덮어쓰지 못하도록 자료마다 독립된 폴더 안에 고정한다. */
export function exportedAttachment(resources: Pick<Resource, "id" | "type">[], resourceId: string, file: ResourceAttachment): ResourceAttachment {
  if (!safeResourceFilePath(file.path) || resources.find(resource => resource.id === resourceId)?.type === "skill" && file.path.toLowerCase() === "skill.md") throw new Error("자료 첨부 경로를 확인해 주세요. SKILL.md는 본문에서 생성합니다.");
  return { id: file.id, path: file.path, mimeType: file.mimeType, size: file.size, sha256: file.sha256, createdAt: file.createdAt, exportPath: `${resourceExportDirectory(resources, resourceId)}/${file.path}` };
}

export async function resourceFileHash(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer)), byte => byte.toString(16).padStart(2, "0")).join("");
}
