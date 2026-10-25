/** Clipboard failure keeps the complete prompt visible and selects it for manual copying. */
export async function copyExportPrompt(text: string, clipboard: Pick<Clipboard, "writeText"> | undefined, select: () => void): Promise<"copied" | "selected"> {
  try {
    if (!clipboard) throw new Error("Clipboard unavailable");
    await clipboard.writeText(text);
    return "copied";
  } catch {
    select();
    return "selected";
  }
}

export const PROMPT_PART_CHARACTERS = 20_000;

/** Lossless pieces: concatenating them reproduces the original design, including whitespace. */
export function splitExportPrompt(text: string, limit = PROMPT_PART_CHARACTERS): string[] {
  if (!Number.isInteger(limit) || limit < 256) throw new Error("프롬프트 조각 크기가 올바르지 않아요.");
  if (!text.length) return [""];
  const parts: string[] = [];
  let start = 0, offset = 0, characters = 0;
  for (const character of text) {
    offset += character.length;
    if (++characters === limit) {
      parts.push(text.slice(start, offset)); start = offset; characters = 0;
    }
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}

export function exportPromptCharacterCount(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; count++) index += text.codePointAt(index)! > 0xffff ? 2 : 1;
  return count;
}

/** The delivery envelope is separate from the raw payload and never removes execution policy. */
export function exportPromptPart(parts: string[], index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= parts.length) throw new Error("복사할 프롬프트 조각을 선택해 주세요.");
  const used = new Set(parts.flatMap(part => Array.from(part.matchAll(/FLOWLY_PROMPT_PAYLOAD_\d+_END/g), match => match[0])));
  let suffix = 0;
  while (used.has(`FLOWLY_PROMPT_PAYLOAD_${suffix}_END`)) suffix++;
  const marker = `FLOWLY_PROMPT_PAYLOAD_${suffix}_END`;
  return `Flowly AI 명령 프롬프트 ${index + 1}/${parts.length} 조각입니다. 모든 조각을 번호순으로 받을 때까지 작업을 실행하거나 부분 설계를 해석하지 말고 수신만 확인하세요. 각 조각의 BEGIN/END 표시 사이 원문을 추가 문자 없이 이어 붙인 전체 프롬프트를 사용하세요. 자료·분기·한도·승인 조건을 요약하거나 생략하지 마세요. 마지막 조각까지 받은 후에만 실행 프로젝트와 설정을 확인하고 전체 지시를 수행하세요. 아래 표시 바로 다음 줄부터 END 표시 직전 줄바꿈 앞까지가 원문입니다.\nBEGIN_${marker}\n${parts[index]}\nEND_${marker}`;
}
