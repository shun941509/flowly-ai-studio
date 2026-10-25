"use client";
import type { FlowNode } from "../lib/model";

export function MemoryPolicySettings({ node, onChange }: { node: FlowNode; onChange: (node: FlowNode) => void }) {
  const config = node.memory!;
  if (config.backend === "mcp") return null;
  return <><label className="field-label">기억 공유 범위<select value={config.scope ?? "workflow"} onChange={event => onChange({ ...node, memory: { ...config, scope: event.target.value as "workflow" | "run" } })}><option value="workflow">같은 워크플로의 다음 실행에서도 사용</option><option value="run">이번 실행과 하위 Agent에서만 사용</option></select></label>{config.action === "write" && <><label className="inline-check"><input type="checkbox" checked={Boolean(config.expectedRevisionPath)} onChange={event => { const next = { ...config }; if (event.target.checked) { next.expectedRevisionPath = "data.revision"; delete next.ttlSeconds; } else delete next.expectedRevisionPath; onChange({ ...node, memory: next }); }}/><span>읽은 버전이 같을 때만 저장</span></label>{config.expectedRevisionPath && <label className="field-label">확인한 버전의 입력 경로<input value={config.expectedRevisionPath} maxLength={200} onChange={event => onChange({ ...node, memory: { ...config, expectedRevisionPath: event.target.value } })}/><small className="field-help">저장할 객체의 revision은 확인한 버전보다 1 커야 해요. 다른 작업이 먼저 저장하면 오류 경로로 전달됩니다. 이 기억은 이후에도 버전 검사로 갱신하며, 삭제 대신 새 버전에 폐기 상태를 기록하세요. 보관 기간과 함께 사용할 수 없어요.</small></label>}</>}</>;
}
