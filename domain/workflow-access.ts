/**
 * 워크플로 읽기·수정·삭제·공유 관리 권한의 공통 정책.
 * Identity는 서버에서 검증한 세션으로 공급해야 하며, 연결 자료의 권한은 별도로 검사한다.
 */
import type { Identity, Workflow } from "../app/lib/model";

export type WorkflowSharing = { visibility: "private" | "selected" | "public"; readEmails: string[]; editEmails: string[] };
export type WorkflowAccess = { canRead: boolean; canEdit: boolean; canDelete: boolean; canManage: boolean };
/**
 * 소유자는 전체 권한을 갖고 지정 편집자는 읽기·수정만 할 수 있다. 전체 공개는 읽기에만 적용된다.
 */
export function workflowAccess(workflow: Pick<Workflow, "ownerId" | "visibility" | "readEmails" | "editEmails">, user: Identity): WorkflowAccess {
  const owner = workflow.ownerId === user.userId;
  const email = user.email.toLowerCase();
  const edit = owner || Boolean(workflow.editEmails?.includes(email));
  return { canRead: edit || workflow.visibility === "public" || workflow.visibility === "selected" && Boolean(workflow.readEmails?.includes(email)), canEdit: edit, canDelete: owner, canManage: owner };
}
/**
 * 공유 요청의 범위와 이메일 목록을 정규화하고 전체 사용자 수정 권한을 거절한다.
 */
export function parseWorkflowSharing(value: unknown): WorkflowSharing {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("공유 설정을 확인해 주세요.");
  const data = value as Record<string, unknown>;
  if (!["private", "selected", "public"].includes(String(data.visibility))) throw new Error("읽기 범위를 선택해 주세요.");
  if (data.editVisibility === "public" || data.editScope === "public" || data.editEmails === "*" || data.editAll === true) throw new Error("전체 사용자에게 수정 권한을 줄 수 없어요.");
  const emails = (input: unknown) => {
    if (input === undefined) return [];
    if (!Array.isArray(input) || input.some(email => typeof email !== "string")) throw new Error("사용자 이메일 목록을 확인해 주세요.");
    const result = [...new Set((input as string[]).map(email => email.trim().toLowerCase()).filter(Boolean))];
    if (result.length > 50 || result.some(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error("올바른 이메일을 최대 50개까지 입력해 주세요.");
    return result;
  };
  const readEmails = data.visibility === "selected" ? emails(data.readEmails) : [];
  const editEmails = emails(data.editEmails);
  if (data.visibility === "selected" && !readEmails.length && !editEmails.length) throw new Error("읽거나 수정할 사용자를 지정해 주세요.");
  return { visibility: data.visibility as WorkflowSharing["visibility"], readEmails, editEmails };
}
