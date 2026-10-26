/** 현재 읽기 권한으로 받은 자료 첨부만 ZIP에 넣는다. 서버 저장소 키와 파일 소유권은 출력에 복사하지 않는다. */
import type { Identity, Resource } from "../app/lib/model";
import { EXPORT_RESOURCE_FILES_MAX_BYTES, RESOURCE_FILE_MAX_BYTES, type ResourceFilePayload } from "../domain/resource-contract";
import { resourceFileHash } from "../domain/resource-export";
import { ExportPackageError, type ExportManifest } from "./export-package";

export type ResourceFileResolver = (user: Identity, resources: Resource[]) => Promise<ResourceFilePayload[]>;

export async function buildResourceExportFiles(manifest: ExportManifest, resources: Resource[], resolve?: ResourceFileResolver): Promise<Record<string, Uint8Array>> {
  const selected = manifest.resources.flatMap(resource => (resource.files ?? []).map(file => ({ resourceId: resource.id, file })));
  if (!selected.length) return {};
  if (!resolve) throw new ExportPackageError("첨부 파일 저장소가 미설정이에요. 관리자에게 확인해 주세요.", 503);
  const payloads = await resolve(manifest.owner, resources), entries: Record<string, Uint8Array> = {};
  let total = 0;
  for (const { resourceId, file } of selected) {
    const matches = payloads.filter(payload => payload.resourceId === resourceId && payload.file.id === file.id);
    if (matches.length !== 1) throw new ExportPackageError("자료 첨부가 삭제되었거나 변경됐어요. 자료를 새로고침한 뒤 다시 내보내 주세요.", 409);
    const payload = matches[0];
    if (!file.exportPath || payload.file.path !== file.path || payload.file.sha256 !== file.sha256 || payload.bytes.byteLength !== file.size || file.size > RESOURCE_FILE_MAX_BYTES || await resourceFileHash(payload.bytes) !== file.sha256) throw new ExportPackageError("첨부 파일의 경로·크기·내용이 등록된 버전과 다릅니다. 자료를 확인한 뒤 다시 내보내 주세요.", 409);
    total += payload.bytes.byteLength;
    if (total > EXPORT_RESOURCE_FILES_MAX_BYTES) throw new ExportPackageError("전체 내보내기 첨부는 20MB까지 포함할 수 있어요.", 413);
    if (Object.keys(entries).some(path => path.toLowerCase() === file.exportPath!.toLowerCase())) throw new ExportPackageError("첨부 파일 경로가 겹칩니다. 파일 이름을 확인해 주세요.");
    entries[file.exportPath] = payload.bytes;
  }
  return entries;
}
