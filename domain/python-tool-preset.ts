/**
 * Document에 저장된 Python 도구 프리셋을 고정 program 설정으로 읽는 어댑터.
 * 등록 문서에 코드가 있어도 임의로 실행하지 않으며 지원 도구 ID와 인자 계약을 사용한다.
 */
import type { Resource } from "../app/lib/model";
import { getToolCandidate } from "./tool-catalog";
import { parseDataNodeConfig } from "./node-config";

/** Presets are ordinary permission-controlled documents; never uploaded Python code. */
/**
 * 지원하는 프리셋 문서인지 확인해 프로그램 설정을 반환한다.
 */
export function readPythonToolPreset(resource: Pick<Resource, "type" | "content">) {
  if (resource.type !== "document") return null;
  let parsed: unknown;
  try { parsed = JSON.parse(resource.content); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || !("flowlyPython" in parsed)) return null;
  const config = (parsed as { flowlyPython: unknown }).flowlyPython;
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Python 설정 자료 형식을 확인해 주세요.");
  const value = config as Record<string, unknown>;
  if (value.version !== 1 || typeof value.toolId !== "string" || !getToolCandidate(value.toolId) || Object.keys(value).some(key => !["version", "toolId", "arguments"].includes(key))) throw new Error("등록된 Python 도구와 version 1 설정을 사용해 주세요.");
  return parseDataNodeConfig({ type: "program", program: { name: "python_tool", arguments: { toolId: value.toolId, arguments: value.arguments ?? {} }, bindings: {} } }).program!;
}
