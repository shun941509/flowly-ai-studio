import type { Resource } from "../app/lib/model";
import { getToolCandidate } from "./tool-catalog";
import { parseDataNodeConfig } from "./node-config";

/** Presets are ordinary permission-controlled documents; never uploaded Python code. */
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
