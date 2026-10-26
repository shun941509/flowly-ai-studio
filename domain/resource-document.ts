/** 검색·색인용 텍스트 선택. 첨부 등록을 추출 완료로 오인하지 않으며 기존 content-only 자료는 그대로 읽는다. */
import type { Resource } from "../app/lib/model";

export function resourceSearchText(resource: Resource): string {
  const document = resource.type === "document" ? resource.details?.document : undefined;
  if (document?.extractionStatus === "provided") return document.extractedText!;
  if (document && (document.originalFileId || ["pending_local", "failed"].includes(document.extractionStatus))) throw new Error(`${resource.name}: Document 텍스트 추출이 완료되지 않았어요. 원본을 파일 입력 → 문서 내용 추출로 처리한 뒤 추출 텍스트를 등록하거나 지식 색인의 문서 입력으로 연결해 주세요.`);
  return resource.content;
}
