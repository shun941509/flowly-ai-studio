"use client";

import { useState } from "react";
import type { Resource, Workflow } from "../lib/model";
import type { RuntimeCapabilities } from "../../runtime/types";
import { inspectWorkflow } from "../../domain/preflight";
import { Icon, Modal } from "./common";
import { workflowInputExample } from "./advanced-nodes";
import { allNodes } from "../../domain/advanced-config";
import { readMcpRegistration, readLegacyMcpRegistration } from "../../domain/mcp-registration";
import { PromptPreview } from "./export-prompt";

export function ExportDialog({workflow,publishedVersion,resources,capabilities,onClose,onInspectNode}:{workflow:Workflow;publishedVersion?:{id:string;number:number};resources:Resource[];capabilities?:RuntimeCapabilities|null;onClose:()=>void;onInspectNode:(id:string)=>void}) {
  const [selection,setSelection]=useState<"node"|"python"|"prompt"|"agent">("node");
  const [agentLanguage,setLanguage]=useState<"node"|"python">("node");
  const [prompt,setPrompt]=useState("");
  const language=selection==="node"||selection==="python"?selection:agentLanguage;
  const kind=selection==="agent"||selection==="prompt"?selection:"runtime";
  const hasAgent=allNodes(workflow.definition).some(node=>node.type==="agent");
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[downloaded,setDownloaded]=useState(false);
  const inspection=inspectWorkflow(workflow,resources,capabilities??undefined);
  const errors=inspection.issues.filter(issue=>issue.severity==="error").length;
  const warnings=inspection.issues.filter(issue=>issue.severity==="warning").length;
  async function download() {
    if(!inspection.canExport||(kind==="agent"&&!hasAgent))return;
    setBusy(true);setError("");setDownloaded(false);
    try {
      const response=await fetch("/api/export",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(publishedVersion?{workflowId:workflow.id,versionId:publishedVersion.id,language,kind}:{workflow,language,kind})});
      if(!response.ok) {const data=await response.json() as {error?:string};throw new Error(data.error||"내보내지 못했어요. 잠시 후 다시 시도해 주세요.");}
      if(kind==="prompt"){const data=await response.json() as {text:string};setPrompt(data.text);return;}
      const url=URL.createObjectURL(await response.blob()),link=document.createElement("a");
      link.href=url;link.download=`flowly-${language}-${kind==="agent"?"agent":"project"}.zip`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setDownloaded(true);
    } catch(e) {setError(e instanceof Error?e.message:"연결을 확인하고 다시 내보내 주세요.");}
    finally {setBusy(false);}
  }
  const usesAgentEntry=kind==="agent"||(kind==="prompt"&&hasAgent);
  const command=usesAgentEntry?(language==="node"?"node agent.mjs":"python agent.py"):(language==="node"?"node runner.mjs":"python runner.py");
  const inputExample=workflowInputExample(workflow);
  const nodes=allNodes(workflow.definition),trigger=workflow.definition.nodes.find(node=>node.type==="trigger")?.trigger;
  const usesFiles=nodes.some(node=>["file_input","document_extract","file_output"].includes(node.type));
  const hasFileField=nodes.some(node=>node.form?.fields.some(field=>field.type==="file"));
  const selectedResourceIds=new Set(nodes.flatMap(node=>(node.allowedTools??[]).map(tool=>tool.resourceId)));
  const connectionSettings=resources.filter(resource=>selectedResourceIds.has(resource.id)).flatMap(resource=>{
    try {const registration=readMcpRegistration(resource)??readLegacyMcpRegistration(resource);return registration?[{resourceId:resource.id,name:resource.name,...registration}]:[];}catch{return [];}
  });
  const executionCommand=trigger?trigger.kind==="schedule"?"python flowly_triggers.py schedule --max-runs 3 --input-file input.txt":"python flowly_triggers.py serve --port 8789":inputExample?`${command} run --input-file input.txt`:`${command} run --input "질문이나 요청"`;
  return <Modal title="실행 프로젝트 내보내기" wide onClose={()=>{if(!busy)onClose();}}>
    <div className="modal-body runtime-body">
      <p className="form-intro">내 컴퓨터나 서버에서 실제 AI 워크플로를 실행하세요. 웹에서는 API 키를 받거나 OpenAI를 호출하지 않아요.</p>
      <div className="runtime-modes export-kind-options" role="group" aria-label="내보낼 항목">
        {([['node','Node.js','실행 프로젝트 ZIP'],['python','Python','실행 프로젝트 ZIP'],['prompt','AI 명령 프롬프트','미리보기와 복사'],['agent','Agent 다운로드','역할 지침과 실행 진입점']] as const).map(([value,title,description])=><button key={value} aria-pressed={selection===value} disabled={busy||(value==='agent'&&!hasAgent)} onClick={()=>{setSelection(value);setDownloaded(false);setPrompt("");setError("");}}><Icon name={value==='prompt'?'copy':value==='agent'?'workflow':'code'} size={20}/><strong>{title}</strong><small>{description}</small></button>)}
      </div>
      {!hasAgent&&<p className="field-help">Agent 다운로드는 AI Agent 블록이 있는 설계에서 사용할 수 있어요. 하위 흐름의 Agent도 포함하며 AI 답변·도구·Skill 블록만으로는 활성화되지 않아요.</p>}
      {(kind==='agent'||kind==='prompt')&&<div className="export-agent-language"><label>실행 언어 <select aria-label="Agent 또는 프롬프트 실행 언어" disabled={busy} value={language} onChange={event=>{setLanguage(event.target.value as 'node'|'python');setPrompt("");setDownloaded(false);}}><option value="node">Node.js 22.13 이상</option><option value="python">Python 3.11 이상</option></select></label></div>}
      {kind==='agent'&&<p className="soft-note">Agent.md·AGENTS.md·역할별 지침·선택 Skill·MCP 정의와 agent-manifest.json을 포함해요. Agent 전용 진입점이 고정된 설계·실행기를 확인하고 전체 워크플로를 실행합니다.</p>}
      {kind==='prompt'&&<p className="soft-note">이 프롬프트는 {hasAgent?'같은 실행 언어의 Agent 다운로드':'같은 실행 언어의 실행 프로젝트 ZIP'}를 준비한 뒤 사용해요. 파일·터미널을 사용할 수 있는 외부 AI 도구에 전달하거나 직접 실행하세요. 복사만으로 AI 실행이나 승인 처리가 시작되지는 않아요.</p>}
      {prompt&&kind==='prompt'&&<PromptPreview key={language+prompt.slice(-30)} text={prompt}/>}
      <div className="run-summary"><Icon name="workflow" size={17}/><span>{workflow.name}</span><span>{workflow.definition.nodes.length}개 블록</span></div>
      {publishedVersion&&<p className="soft-note">발행 버전 {publishedVersion.number}의 고정된 구성을 내보냅니다. 연결된 자료와 도구는 내보내는 시점의 접근 권한과 내용을 사용해요.</p>}
      <section className="export-preflight" aria-labelledby="export-preflight-title">
        <div className="export-preflight-heading"><h3 id="export-preflight-title">내보내기 전 점검</h3><span className={errors?"preflight-error-badge":warnings?"warning-badge":"success-badge"}>{errors?`수정 필요 ${errors}개`:warnings?`확인 사항 ${warnings}개`:"구성 점검 완료"}</span></div>
        <p className="field-help">현재 편집 내용과 자료·도구 정의를 검사해요. 실제 외부 연결이나 모델 응답을 확인하는 검사는 아니에요.</p>
        {inspection.issues.length>0?<ul className="preflight-issues">{inspection.issues.map((issue,index)=><li key={`${issue.nodeId||"flow"}:${index}`} className={`preflight-${issue.severity}`}><Icon name={issue.severity==="error"?"alert":issue.severity==="warning"?"info":"checkCircle"} size={16}/><div><span className="preflight-severity">{issue.severity==="error"?"수정 필요":issue.severity==="warning"?"확인 사항":"안내"}</span><p>{issue.message}</p>{issue.nodeId&&<button className="text-btn" disabled={busy} onClick={()=>onInspectNode(issue.nodeId!)}>{workflow.definition.nodes.find(node=>node.id===issue.nodeId)?.title||"해당 블록"} 설정 열기<Icon name="arrowRight" size={13}/></button>}</div></li>)}</ul>:<p className="preflight-clear"><Icon name="checkCircle" size={16}/>현재 구성에서 차단되는 항목은 없어요.</p>}
        {!inspection.canExport&&<p className="form-error">수정 필요 항목을 해결하면 내보내거나 프롬프트를 볼 수 있어요.</p>}
      </section>
      <p className="field-help">Node.js·Python ZIP 모두 <code>AI_PROMPT.md</code>(AI 작업 요청), <code>AGENTS.md</code>(작업 규칙), <code>skills/flowly-workflow/SKILL.md</code>(실행 절차)를 포함해요. 외부 AI 도우미에게 맡기거나 직접 실행할 때 <code>START_HERE.md</code>부터 확인하세요.</p>
      <h3 className="run-section-title">다운로드한 뒤 시작하는 방법</h3>
      <ol className="export-steps"><li>ZIP을 풀고 함께 제공되는 README를 확인하세요.</li><li>{inspection.requiresModel?<>로컬 편집기에서 <code>.env.example</code>을 <code>.env</code>로 복사하고 본인의 <code>OPENAI_API_KEY</code>와 사용할 <code>FLOWLY_MODEL</code>을 입력하세요. 키를 채팅이나 워크플로에 넣지 마세요.</>:<>이 흐름에는 모델 호출이 없어 모델 키가 필요하지 않아요. MCP를 사용하면 <code>.env.example</code>을 <code>.env</code>로 복사하고 사내 주소와 필요한 서비스 토큰을 입력하세요.</>}</li><li>해당 폴더의 터미널에서 아래 명령을 실행하세요. 필요한 서비스 설정과 승인·재개 방법은 함께 제공되는 README에 안내돼요.</li></ol>
      {connectionSettings.length>0&&<section className="settings-card"><h4>사내 MCP 설정 위치 · 내보낸 폴더의 .env</h4><ul>{connectionSettings.map(connection=><li key={connection.resourceId}><strong>{connection.name}</strong><p>사내 주소: <code>{connection.endpointEnv}</code><br/>{connection.tokenEnv?<>본인 토큰: <code>{connection.tokenEnv}</code></>:"토큰 환경 변수는 등록하지 않았습니다."}</p></li>)}</ul><p className="field-help">MCP의 도구 정의는 ‘도구 및 자료’에서 수정합니다. 위 항목은 변수 이름이며 비밀 값은 웹에 입력하지 않습니다.</p></section>}
      {inputExample&&<><p className="field-help">이 흐름의 입력 예시를 <code>input.txt</code>에 UTF-8로 저장하세요.</p><pre className="result-content">{inputExample}</pre></>}
      {(usesFiles||hasFileField)&&<div className="soft-note"><Icon name="file" size={17}/><p>입력 파일은 다운로드한 폴더의 inputs/에 직접 복사하고 JSON에는 상대 파일명을 넣으세요. 파일 처리에는 Python 3.11+가 필요하며 Node.js도 공용 도우미를 사용합니다. PDF·Word·Excel·OCR에 필요한 추가 설치는 requirements-files.txt와 README를 확인하세요. 출력 파일은 outputs/에 생성되고 웹으로 전송되지 않아요.</p></div>}
      {trigger&&<div className="soft-note"><Icon name="play" size={17}/><p>{trigger.kind==="schedule"?"실행에 사용할 입력을 UTF-8 input.txt로 저장하세요. 아래 명령은 지정한 일정으로 최대 3회 실행하며 Ctrl+C로 종료할 수 있어요.":".env의 FLOWLY_TRIGGER_SECRET과 README에 안내된 서명 요청 형식을 설정하세요. 기본 수신 주소는 같은 컴퓨터에서만 접근할 수 있어요."} Node.js 프로젝트도 트리거 도우미에는 Python 3.11+가 필요해요. 이 웹 화면에 예약이나 수신 서버가 등록되지는 않아요.</p></div>}
      <pre className="result-content">{executionCommand}</pre>
      {nodes.some(node=>node.delivery?.stream)&&<p className="field-help">모델의 부분 응답은 stderr의 JSONL 이벤트로 표시되고, 완료 확인된 최종 결과만 stdout에 남습니다.</p>}
      <p className="field-help">{inspection.requiresModel?"실제 실행 시 모델 사용료가 발생할 수 있어요. ":"선택한 외부 서비스에는 별도 요금이 발생할 수 있어요. "}실행 기록과 승인 대기는 다운로드한 프로젝트에 저장되며, Node.js와 Python의 기록은 각각 관리돼요.</p>
      <div className="soft-note"><Icon name="info" size={17}/><p>현재 접근 가능한 자료와 선택한 도구 정의가 ZIP에 포함돼요. API 키와 서비스 토큰은 포함되지 않아요. 내보낸 복사본에는 이후 원본 수정이나 공유 철회가 반영되지 않으므로, 자료가 바뀌면 다시 내보내 주세요.</p></div>
      {downloaded&&<p className="success-badge" role="status">ZIP 다운로드를 시작했어요. 다른 형식도 선택해 받을 수 있어요.</p>}
      {error&&<p className="form-error" role="alert">{error}</p>}
    </div><footer className="modal-footer"><button className="btn secondary" disabled={busy} onClick={onClose}>닫기</button><button className="btn primary" disabled={busy||!inspection.canExport||(kind==="agent"&&!hasAgent)} onClick={()=>void download()}><Icon name={busy?"loader":kind==="prompt"?"copy":"download"} size={16} className={busy?"spin":""}/>{busy?"준비 중…":kind==="prompt"?"프롬프트 미리보기":`${kind==="agent"?"Agent · ":""}${language==="node"?"Node.js":"Python"} ZIP 다운로드`}</button></footer>
  </Modal>;
}
