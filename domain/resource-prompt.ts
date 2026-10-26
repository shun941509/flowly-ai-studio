/** 화면 미리보기와 Node 실행기가 공유하는 단일 패스 Prompt 치환. 모델 호출이나 표현식 실행은 하지 않는다. */
import type { Resource } from "../app/lib/model";
import type { Json } from "../runtime/types";
import { canonicalJson } from "../runtime/policy";
import { safeDataPath } from "./node-config";
import { assertSchema } from "./schema";

function at(input: Record<string, Json>, path: string): Json {
  if (!safeDataPath(path)) throw new Error("Prompt 변수의 앞 단계 값 경로를 확인해 주세요.");
  let value: Json = input;
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) throw new Error(`Prompt 변수에 연결한 ${path} 값을 찾지 못했어요.`);
    value = (value as Record<string, Json>)[key];
  }
  return value;
}

/** 앞 단계 연결 → 명시 값 → 기본값 순서. 선택 변수 누락은 빈 문자열이며 입력 속의 {{name}}은 재치환하지 않는다. */
export function resolveResourcePrompt(resource: Resource, input: Record<string, Json> = {}, values: Record<string, Json> = {}, bindings: Record<string, string> = {}): { text: string; values: Record<string, Json> } {
  const definition = resource.type === "prompt" ? resource.details?.prompt : undefined;
  if (!definition) {
    if (Object.keys(values).length || Object.keys(bindings).length) throw new Error("변수 정의가 없는 자료에는 Prompt 변수 값을 연결할 수 없어요.");
    return { text: resource.content, values: {} };
  }
  const names = new Set(definition.variables.map(variable => variable.name));
  for (const name of [...Object.keys(values), ...Object.keys(bindings)]) if (!names.has(name)) throw new Error(`등록되지 않은 Prompt 변수예요: ${name}`);
  const resolved: Record<string, Json> = Object.create(null);
  for (const variable of definition.variables) {
    const value = Object.hasOwn(bindings, variable.name) ? at(input, bindings[variable.name]) : Object.hasOwn(values, variable.name) ? values[variable.name] : variable.defaultValue;
    if (value === undefined) {
      if (variable.required) throw new Error(`Prompt 필수 변수 ${variable.name} 값을 입력하거나 연결해 주세요.`);
      continue;
    }
    assertSchema(value, { type: variable.type }, `Prompt 변수 ${variable.name}`);
    canonicalJson(value);
    resolved[variable.name] = structuredClone(value);
  }
  const text = resource.content.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_-]{0,79})\s*\}\}/g, (_, name: string) => {
    if (!names.has(name)) throw new Error(`본문의 ${name} 변수가 정의되지 않았어요.`);
    if (!Object.hasOwn(resolved, name)) return "";
    return typeof resolved[name] === "string" ? resolved[name] as string : canonicalJson(resolved[name]);
  });
  if (text.length > 200_000) throw new Error("치환한 Prompt가 200,000자를 넘어요. 변수 값이나 본문을 줄여 주세요.");
  return { text, values: resolved };
}
