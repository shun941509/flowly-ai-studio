// 로컬 운영 대기열의 취소 파일을 AbortSignal로 변환한다. 파일 내용은 읽거나 실행하지 않고 존재 여부만 관찰한다.
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

function inside(root: string, path: string) {
  const part = relative(root, path);
  return part !== "" && part !== ".." && !part.startsWith("..\\") && !part.startsWith("../") && !isAbsolute(part);
}
/** Queue cancellation is a presence-only local signal, never executable content. */
// 프로젝트 내부 경로인지 확인한 뒤 기존 조상 경로를 해석하여 심볼릭 링크·정션을 통한 외부 경로도 거절한다.
export async function monitorCancellationFile(packagePath: string, supplied: string, controller: AbortController): Promise<() => void> {
  const root = await realpath(dirname(resolve(packagePath))), target = resolve(root, supplied);
  if (!inside(root, target)) throw new Error("취소 신호 파일은 실행 프로젝트 폴더 안에 지정해 주세요.");
  // Resolve existing ancestors so symlink/junction paths cannot escape the package directory.
  let parent = dirname(target);
  for (;;) {
    try {
      const actual = await realpath(parent);
      if (actual !== root && !inside(root, actual)) throw new Error("취소 신호 경로가 실행 프로젝트 폴더를 벗어났어요.");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const next = dirname(parent); if (next === parent) throw error; parent = next;
    }
  }
  const check = () => { if (existsSync(target)) controller.abort(); };
  check(); const timer = setInterval(check, 100);
  timer.unref(); return () => clearInterval(timer);
}
