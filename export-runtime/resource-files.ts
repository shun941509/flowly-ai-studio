/** 내려받은 첨부 원본은 실행/재개 전에 바이트 해시를 검사한다. 사용자 원본을 덮어쓰거나 웹에서 실행하지 않는다. */
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExportManifest } from "./manifest";
import { RuntimeFault } from "../runtime/policy";

export async function assertResourceFiles(packagePath: string, resources: ExportManifest["resources"]) {
  const root = await realpath(dirname(resolve(packagePath)));
  for (const resource of resources) for (const file of resource.files ?? []) {
    const path = join(root, file.exportPath!);
    for (let current = path; current !== root; current = dirname(current)) {
      if (dirname(current) === current || (await lstat(current)).isSymbolicLink()) throw new RuntimeFault("failed", "자료 파일 경로에 심볼릭 링크나 정션을 사용할 수 없어요.");
    }
    const actual = await realpath(path), rel = relative(root, actual), stat = await lstat(path);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || !stat.isFile() || stat.size !== file.size || stat.size > 5_000_000) throw new RuntimeFault("failed", "자료 원본 파일의 위치 또는 크기가 바뀌었어요.");
    if (createHash("sha256").update(await readFile(path)).digest("hex") !== file.sha256) throw new RuntimeFault("failed", "자료 원본 파일 해시가 바뀌었어요. 수정본을 새 자료 버전으로 등록해 주세요.");
  }
}

export async function skillRuntimeFingerprint(packagePath: string): Promise<string> {
  const data = await readFile(join(dirname(resolve(packagePath)), "flowly_skills.py"));
  if (data.length > 2_000_000) throw new RuntimeFault("failed", "Skill 감독 도우미 크기를 확인해 주세요.");
  return createHash("sha256").update(data).digest("hex");
}
