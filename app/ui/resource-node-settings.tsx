"use client";
import { useState } from "react";
import type { FlowNode, Resource } from "../lib/model";
import type { Json } from "../../runtime/types";
import { resolveResourcePrompt } from "../../domain/resource-prompt";
import { useTextDraft } from "./control-fields";

/** 적용 전 JSON은 블록 값과 구분한다. 다른 속성 변경이나 탭 전환이 미완성 문자열을 덮어쓰지 않는다. */
function JsonObjectField({ label, value, onChange }: { label: string; value: Record<string, Json> | Record<string, string>; onChange: (value: Record<string, Json>) => void }) {
  const field = useTextDraft(JSON.stringify(value, null, 2)), [error, setError] = useState("");
  function apply() { try { const value: unknown = JSON.parse(field.draft); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON 객체를 입력해 주세요."); onChange(value as Record<string, Json>); field.applied(JSON.stringify(value, null, 2)); setError(""); } catch (reason) { setError(reason instanceof Error ? reason.message : "입력을 확인하세요."); } }
  return <><label className="field-label">{label}<textarea rows={5} maxLength={20000} value={field.draft} onChange={event => { field.setDraft(event.target.value); setError(""); }} /></label>{field.stale && <p className="draft-stale">적용된 설정이 변경됐습니다. 현재 초안을 확인한 뒤 적용하거나 최신 적용값으로 되돌리세요.</p>}<div className="prompt-actions"><button type="button" className="text-btn" disabled={!field.dirty} onClick={apply}>검사 후 적용</button><button type="button" className="text-btn" onClick={() => { field.reset(); setError(""); }}>적용된 값으로 되돌리기</button></div>{error && <p className="form-error" role="alert">{error}</p>}</>;
}

/** 자료 선택과 실행 선택을 분리한다. Skill 패키지가 실행 정의를 갖더라도 사용자가 실행 ID를 선택하기 전에는 지침만 전달한다. */
export function ResourceNodeSettings({ node, resources, onChange }: { node: FlowNode; resources: Resource[]; onChange: (node: FlowNode) => void }) {
  const resource = resources.find(item => item.id === node.resourceId), execution = resource?.details?.skill?.executions?.find(item => item.id === node.skillExecution?.entryId);
  const [preview, setPreview] = useState(""), [previewError, setPreviewError] = useState("");
  function paths(value: Record<string, Json>): Record<string, string> { if (Object.values(value).some(item => typeof item !== "string")) throw new Error("값 연결은 변수 이름: 경로 문자열로 입력하세요."); return value as Record<string, string>; }
  return <><label className="field-label">연결할 도구 및 자료<select value={node.resourceId ?? ""} onChange={event => { onChange({ ...node, resourceId: event.target.value }); setPreview(""); setPreviewError(""); }}><option value="">자료 선택</option>{resources.map(item => <option key={item.id} value={item.id}>{item.name} · {item.type}{item.sample ? " · 예제" : ""}</option>)}{node.resourceId && !resource && <option value={node.resourceId}>현재 권한으로 확인할 수 없는 자료</option>}</select></label>
    {resource && <><p>{resource.details?.purpose || resource.description}</p><details><summary>자료 본문 확인</summary><pre className="content-preview">{resource.content}</pre></details></>}
    {resource?.type === "prompt" && resource.details?.prompt && <section><h4>Prompt 변수 연결</h4><p className="field-help">앞 단계의 입력 경로 → 명시 값 → 기본값 순서로 사용합니다. 실제 앞 단계의 데이터는 입출력 탭에서 먼저 연결하세요.</p><ul>{resource.details.prompt.variables.map(variable => <li key={variable.name}><code>{variable.name}</code> · {variable.type} · {variable.required ? "필수" : "선택"}{variable.defaultValue !== undefined ? ` · 기본값 ${JSON.stringify(variable.defaultValue)}` : ""}<p>{variable.description}</p></li>)}</ul>
      <JsonObjectField key={resource.id + "-values"} label="변수에 직접 전달할 값" value={node.resourceValues ?? {}} onChange={resourceValues => { onChange({ ...node, resourceValues }); setPreview(""); }} />
      <JsonObjectField key={resource.id + "-bindings"} label={'앞 단계 입력과 변수 연결 (예: {"question":"data.question"})'} value={node.resourceBindings ?? {}} onChange={value => { onChange({ ...node, resourceBindings: paths(value) }); setPreview(""); }} />
      <button type="button" className="btn secondary" onClick={() => { try { const result = resolveResourcePrompt(resource, resource.details?.prompt?.sampleInput ?? {}, node.resourceValues ?? {}, node.resourceBindings ?? {}); setPreview(result.text); setPreviewError(""); } catch (reason) { setPreview(""); setPreviewError((reason as Error).message); } }}>샘플 입력으로 치환 미리보기</button><p className="field-help">자료에 등록한 샘플 입력과 현재 적용값만 사용합니다. 실제 모델 응답이나 앞 단계 실행 결과가 아닙니다.</p>{preview && <pre className="content-preview">{preview}</pre>}{previewError && <p className="form-error" role="alert">{previewError}</p>}
    </section>}
    {resource?.type === "skill" && <section><h4>Skill 사용 방식</h4><p className="field-help">기본은 지침 전달입니다. 파일을 포함했거나 실행 정의를 등록한 사실만으로 코드가 실행되지 않습니다.</p><label className="field-label">명시적으로 실행할 코드<select value={node.skillExecution?.entryId ?? ""} onChange={event => { if (!event.target.value) { const next = { ...node }; delete next.skillExecution; onChange(next); } else onChange({ ...node, skillExecution: { entryId: event.target.value, arguments: node.skillExecution?.arguments ?? {}, bindings: node.skillExecution?.bindings ?? {} } }); }}><option value="">실행하지 않음 · 지침과 파일만 전달</option>{resource.details?.skill?.executions?.map(item => <option key={item.id} value={item.id}>{item.id} · {item.language}</option>)}{node.skillExecution && !execution && <option value={node.skillExecution.entryId}>찾을 수 없는 실행 정의 · 다시 선택</option>}</select></label>
      {node.skillExecution && <><p className="soft-note">read라고 선언해도 모든 Skill 코드는 실행 전에 승인받습니다. 웹에서 코드를 실행하지 않습니다. 언어 자동 번역이나 OS 보안 샌드박스를 제공하지 않으며, 두 내보내기 모두 Python 3.11 이상 감독 도우미가 필요합니다.</p>{execution && <><p>실행 파일: {resource.files?.find(file => file.id === execution.entryFileId)?.path ?? "현재 파일 목록에 없음"}</p><p>필요 환경: {execution.language === "python" ? "Python 3.11 이상" : "Node.js 22.13 이상 · .mjs · 내장·동봉 모듈만 지원"} · 제한 {execution.timeoutMs}ms</p><p>사용자가 설치할 의존성: {execution.dependencies.join(", ") || "추가 의존성 없음"}</p><p className="field-help">코드 stdout·stderr 제한은 {execution.maxOutputBytes.toLocaleString()}바이트입니다. 다음 블록으로 전달되는 JSON 입출력은 별도의 200KB 한도도 적용합니다.</p><details><summary>입력·출력 형식 확인</summary><pre>{JSON.stringify({ input: execution.inputSchema, output: execution.outputSchema }, null, 2)}</pre></details></>}
        <JsonObjectField label="코드 실행 고정 입력" value={node.skillExecution.arguments} onChange={args => onChange({ ...node, skillExecution: { ...node.skillExecution!, arguments: args } })} />
        <JsonObjectField label="코드 입력과 앞 단계 경로 연결" value={node.skillExecution.bindings} onChange={value => onChange({ ...node, skillExecution: { ...node.skillExecution!, bindings: paths(value) } })} />
      </>}
    </section>}
    {resource?.type === "document" && <p className="field-help">본문·원본 첨부·추출·검색 색인은 별도 상태입니다. 첨부 {resource.files?.length ?? 0}개 · 추출 {resource.details?.document?.extractionStatus ?? "not_requested"}. 원본 파일은 내보낸 환경의 파일 처리 블록에서 사용하세요.</p>}
    {resource?.type === "mcp" && <p className="field-help">MCP 자료 블록은 정의를 전달합니다. 실제 호출은 도구 실행 블록 또는 Agent 허용 도구에서 선택하며 주소·토큰은 내보낸 환경에 설정합니다.</p>}
    {(node.resourceValues || node.resourceBindings || node.skillExecution) && <p className="field-help">자료를 바꿔도 기존 변수·실행 입력은 유지됩니다. 새 자료의 계약과 맞는지 확인하고 필요한 항목을 수정하세요.</p>}
  </>;
}
