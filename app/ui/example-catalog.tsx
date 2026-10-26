"use client";
/**
 * 공통 예제의 검색·상세·복제·내보내기 화면. 구조/두 실행기/실제 API의 검증 범위를 각각 표시하여 예제 존재와 서비스 성공을 구분한다.
 */


import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { type Definition, type NodeType, type Resource, type Workflow, nodeNames } from "../lib/model";
import { EmptyState, Icon, Modal } from "./common";
import { PlannedExamples } from "./planned-examples";
import { PromptPreview } from "./export-prompt";
import { ExampleCustomizer, mergeExampleResources } from "./example-customizer";
import { WorkflowExplanation } from "./workflow-guide";
import { ExampleAdaptation } from "./example-adaptation";
import { workStyleLabels, type WorkStyle } from "../../domain/work-styles";
import { nodeRoutes } from "../../domain/advanced-config";
import { executionModeLabel, layoutWorkflow, routeWorkflowEdges, workflowBounds, WORKFLOW_NODE_HEIGHT as H, WORKFLOW_NODE_WIDTH as W } from "../../domain/workflow-layout";

type Verification = { schema: boolean; node: boolean; python: boolean; live: boolean };
type ProjectSummary = {
  id: string; title: string; description: string; category: string; frameworks: string[];
  tags: string[]; nodeTypes: string[]; hasAgent: boolean; classification: "agent" | "supporting"; status: "ready" | "setup_required";
  uniqueBehavior: string; verification: Verification; workStyles?: string[];
};
type Variant = {
  id: string; framework: string; language: string; kind: string; title: string;
  verification: { static: boolean; offline: boolean; live: boolean };
};
type Project = ProjectSummary & {
  inputExample: unknown; expectedOutput: unknown; requirements: string[];
  workflow: Workflow; resources: Resource[]; variants: Variant[]; acceptance: string[]; failureCases: string[];
};
type Catalog = {
  items: ProjectSummary[]; total: number; page: number; pageSize: number;
  stats: { projects: number; supporting: number; sourceGraphs: number; variants: number; target: number; reviewed: number; verified: number; remaining: number; topologies: number };
  frameworks: string[]; categories: string[]; workStyles?: {id:string;label:string}[];
};

function readable(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "아직 등록되지 않았어요.";
}

/** 취소 가능한 카탈로그 읽기 요청. 캐시된 목록 대신 최신 응답을 받고 서버 오류를 사용자 안내로 전달한다. */
async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || "예제 프로젝트를 불러오지 못했어요. 다시 시도해 주세요.");
  return data as T;
}

/** 스키마 검증·로컬 실행 검증·실제 API 검증 상태를 합치지 않고 별도 표시한다. */
function VerificationLabels({ verification }: { verification: Verification }) {
  return <div className="catalog-verification" aria-label="검증 범위">
    <span className={verification.schema ? "verified" : ""}>구조 {verification.schema ? "확인" : "미검증"}</span>
    <span className={verification.node ? "verified" : ""}>Node.js {verification.node ? "로컬 실행 확인" : "실행 미검증"}</span>
    <span className={verification.python ? "verified" : ""}>Python {verification.python ? "로컬 실행 확인" : "실행 미검증"}</span>
    <span className={verification.live ? "verified" : "pending"}>실제 API {verification.live ? "확인" : "미검증"}</span>
  </div>;
}

/** Arrange the real DAG by dependency depth; no nodes or connections are invented. */
/** 상세 화면용 배치와 연결 경로를 계산한다. 원본 예제의 저장 좌표를 바꾸는 편집 동작은 아니다. */
function ProjectGraph({ definition }: { definition: Definition }) {
  const marker = `example-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [expanded,setExpanded]=useState(true);
  const scroll=useRef<HTMLDivElement>(null);
  const graph=useMemo(()=>layoutWorkflow(definition,{recursive:false}),[definition]);
  const routes=useMemo(()=>routeWorkflowEdges(graph),[graph]);
  const bounds=useMemo(()=>workflowBounds(graph,routes),[graph,routes]);
  const nodes=graph.nodes;
  useEffect(()=>{if(expanded&&scroll.current){const start=[...nodes].sort((a,b)=>a.y-b.y||a.x-b.x)[0];if(start)scroll.current.scrollLeft=Math.max(0,start.x-bounds.minX+W/2-scroll.current.clientWidth/2);}},[nodes,bounds.minX,expanded]);
  if (!nodes.length) return <p className="catalog-empty-graph">등록된 노드가 없어요.</p>;
  const lookup = new Map(nodes.map(node => [node.id, node]));
  const branchName = (sourceId: string, branch: string) => {
    const source = lookup.get(sourceId);
    return source ? nodeRoutes(source).find(route=>route.id===branch)?.label || branch : branch;
  };
  const nested = nodes.flatMap(node => [
    ...(node.team?.tasks || node.parallel?.tasks || node.orchestration?.tasks || []).map((task,index) => ({ id: `${node.id}-${task.id}`, title: `${node.title} · ${index+1}. ${task.name}`, mode:executionModeLabel(node), definition: task.definition })),
    ...(node.loop ? [{ id: `${node.id}-loop`, title: `${node.title} · 반복 내부`, mode:executionModeLabel(node), definition: node.loop.definition }] : []),
    ...(node.subworkflow ? [{ id: `${node.id}-subworkflow`, title: `${node.title} · 하위 흐름`, mode:executionModeLabel(node), definition: node.subworkflow.definition }] : []),
  ]);
  return <figure className="catalog-graph">
    <div className="catalog-graph-tools"><span>{expanded ? "노드 크기 100% · 스크롤하여 이동" : "전체 연결 구조"}</span><button type="button" className="btn secondary" aria-pressed={expanded} onClick={()=>setExpanded(value=>!value)}>{expanded ? "전체 구조 보기" : "노드 크게 보기"}</button></div>
    <div ref={scroll} className="catalog-graph-scroll"><svg role="img" aria-label={`실제 워크플로: 노드 ${nodes.length}개, 연결 ${definition.edges.length}개`} style={{minWidth:expanded?bounds.width:280,width:expanded?bounds.width:"100%",height:expanded?bounds.height:400}} viewBox={`${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`}>
      <defs><marker id={marker} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0L7 3.5L0 7" fill="var(--muted, #64748b)"/></marker></defs>
      {definition.edges.map(edge => {
        const route=routes.find(route=>route.edgeId===edge.id);
        if (!route) return null;
        return <g key={edge.id}><path d={route.path} fill="none" stroke="var(--muted, #64748b)" strokeWidth="2" strokeLinejoin="round" markerEnd={`url(#${marker})`}/>{edge.branch && <text className="edge-label" x={route.label.x+5} y={route.label.y-7} fontSize="12" fill="var(--text, #475569)">{branchName(edge.source, edge.branch)}</text>}</g>;
      })}
      {nodes.map(node => <g key={node.id} transform={`translate(${node.x},${node.y})`}>
        <title>{node.title} · {nodeNames[node.type]}{executionModeLabel(node)?` · ${executionModeLabel(node)}`:""}</title>
        <rect width={W} height={H} rx="12" fill={node.type === "agent" || node.type === "ai" ? "var(--primary-soft, #eef2ff)" : "var(--surface, #ffffff)"} stroke="var(--line, #e2e8f0)"/>
        <foreignObject x="14" y="12" width={W-28} height={H-20}><div className="catalog-graph-node"><small>{nodeNames[node.type]}</small><strong>{node.title}</strong>{executionModeLabel(node)&&<span>{executionModeLabel(node)}</span>}</div></foreignObject>
      </g>)}
    </svg></div>
    <figcaption>노드 {nodes.length}개 · 연결 {definition.edges.length}개 · 위에서 아래로 의존 순서 표시. 나란한 배치는 동시 실행을 뜻하지 않으며 작업 묶음의 실행 방식을 따릅니다.</figcaption>
    <details><summary>노드와 분기 경로를 글로 보기</summary><ol>{[...nodes].sort((a,b)=>a.y-b.y||a.x-b.x).map(node => <li key={node.id}><strong>{node.title}</strong> ({nodeNames[node.type]})<span>{definition.edges.filter(edge => edge.target === node.id).map(edge => `${lookup.get(edge.source)?.title || edge.source}${edge.branch ? ` [${branchName(edge.source, edge.branch)}]` : ""}`).join(", ") || "이전 단계 없음"} → {node.title}</span></li>)}</ol></details>
    {nested.map(task => <details className="catalog-nested-graph" key={task.id}><summary>{task.title} 구성 보기<small>{task.mode}</small></summary><ProjectGraph definition={task.definition}/></details>)}
  </figure>;
}

/** 예제 상세를 읽고 복제된 사본을 맞춤 설정으로 넘긴다. 요청 중 선택한 예제가 바뀌면 이전 읽기를 취소한다. */
function ProjectDetail({ id, demo, resources, onClose, onChoose }: {
  id: string; demo: boolean; resources: Resource[]; onClose: () => void; onChoose: (workflow: Workflow, resources: Resource[]) => void;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [promptText, setPromptText] = useState("");
  const [exportLanguage, setExportLanguage] = useState<"node" | "python">("node");
  const [retry, setRetry] = useState(0);
  const [copy,setCopy]=useState<{workflow:Workflow;resources:Resource[]}|null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setError("");
      void getJson<{ project: Project }>(`/api/examples?id=${encodeURIComponent(id)}`, controller.signal)
        .then(data => { if (!controller.signal.aborted) setProject(data.project); }).catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message); });
    }, 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [id, retry]);

  async function instantiate() {
    setBusy("instantiate"); setError("");
    try {
      const response = await fetch("/api/examples", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "instantiate", id }) });
      const data = await response.json() as { error?: string; workflow: Workflow; resources: Resource[] };
      if (!response.ok) throw new Error(data.error || "예제를 내 워크플로로 복사하지 못했어요.");
      setCopy({workflow:data.workflow,resources:data.resources});
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(""); }
  }

  async function download(variant: Variant | { id: string; language: "node" | "python"; flowly: true; kind?: "runtime" | "agent" | "prompt" }) {
    setBusy(variant.id); setError(""); setNotice("");
    try {
      const body="flowly" in variant?{action:"download-project",id,language:variant.language,kind:variant.kind ?? "runtime"}:{action:"download",variantId:variant.id};
      const response = await fetch("/api/examples", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) { const data = await response.json() as { error?: string }; throw new Error(data.error || "실행 프로젝트를 내려받지 못했어요."); }
      if ("flowly" in variant && variant.kind === "prompt") {
        const data = await response.json() as { text?: string };
        if (!data.text) throw new Error("AI 명령 프롬프트를 만들지 못했어요.");
        setPromptText(data.text);
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `flowly-${variant.id.replace(/[^a-zA-Z0-9_-]/g, "-")}.zip`;
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("실행 프로젝트를 내려받았어요. ZIP의 README를 읽고 필요한 설정을 로컬 환경에 직접 등록하세요.");
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(""); }
  }

  if(copy)return <Modal title="복제 완료 · 내 작업에 맞추기" wide onClose={()=>{onChoose(copy.workflow,copy.resources);onClose();}}><div className="modal-body"><ExampleCustomizer workflow={copy.workflow} resources={mergeExampleResources(resources,copy.resources)} onDone={workflow=>{onChoose(workflow,copy.resources);onClose();}} onSkip={()=>{onChoose(copy.workflow,copy.resources);onClose();}}/></div></Modal>;
  return <Modal title={project?.title || "예제 프로젝트 살펴보기"} size="example" onClose={() => { if (!busy) onClose(); }}>
    <div className="modal-body catalog-detail">
      {error && <div className="form-error" role="alert"><Icon name="alert" size={17}/><span>{error}</span>{!project && <button className="text-btn" onClick={() => setRetry(value => value + 1)}>다시 시도</button>}</div>}
      {!project && !error && <p className="catalog-loading" role="status"><Icon name="loader" className="spin" size={18}/>구성과 실행 조건을 불러오고 있어요.</p>}
      {project && <>
        <div className="catalog-detail-columns"><section><div><span className="catalog-category">{project.category} · {project.hasAgent ? "AI Agent 예제" : "계산·기존 보조 흐름"}</span><p className="catalog-description">{project.description}</p></div>
        {!project.hasAgent && <p className="catalog-test-note">명시적인 AI Agent 블록이 없는 보조 흐름입니다. AI Agent 예제 수에 포함하지 않으며 계산·검증·노드 사용법을 참고할 수 있습니다.</p>}
        <VerificationLabels verification={project.verification}/>
        <p className="catalog-test-note">로컬 실행 확인은 검증용 응답을 사용해 입출력·분기·오류·재개 등 해당 예제의 실행 경로를 검사한 범위입니다. 실제 API 연결과 모델 답변 품질의 검증 여부는 별도입니다.</p>
        <section><h3>언제 사용하나요?</h3><p>{project.uniqueBehavior} 이런 처리 방식이 필요한 작업의 시작점으로 사용하세요. 실제 서비스 연결이 없어도 복제하고 설계를 바꿀 수 있어요.</p></section><section><h3>이 워크플로의 실행 방식</h3><p>{project.uniqueBehavior}</p></section>
        </section><section><h3>설계된 노드와 분기</h3><ProjectGraph definition={project.workflow.definition}/><WorkflowExplanation definition={project.workflow.definition}/><ExampleAdaptation workflow={project.workflow} resources={project.resources}/></section></div>
        <div className="catalog-contract"><section><h3>예시 입력</h3><pre>{readable(project.inputExample)}</pre></section><section><h3>기대하는 결과와 기준</h3><pre>{readable(project.expectedOutput)}</pre><small>실행해서 생성한 답변이 아닌 예제의 결과 기준입니다.</small></section></div>
        <div className="catalog-contract"><section><h3>판단 규칙</h3><ul>{project.acceptance.map(item=><li key={item}>{item}</li>)}</ul></section><section><h3>실패·경계 조건</h3><ul>{project.failureCases.map(item=><li key={item}>{item}</li>)}</ul></section></div>
        <section><h3>실행 전 준비</h3><ul className="catalog-requirements">{project.requirements.length ? project.requirements.map((item, index) => <li key={index}>{item}</li>) : <li>추가 연결 설정이 없는 예제예요. 내보낸 프로젝트에서 실행 환경을 확인하세요.</li>}</ul><p className="catalog-test-note">웹에서는 OpenAI를 호출하거나 API 키를 입력받지 않아요. 모델 키와 서비스 토큰은 내보낸 프로젝트의 로컬 환경에 직접 설정하세요.</p></section>
        {project.resources.length > 0 && <details className="catalog-resource-list"><summary>함께 복사할 도구 및 자료 {project.resources.length}개</summary><ul>{project.resources.map(resource => <li key={resource.id}><strong>{resource.name}</strong><span>{resource.description}</span></li>)}</ul><p>내 워크플로를 만들면 자료도 내 계정의 비공개 복사본으로 저장됩니다. 외부 서비스 연결 권한은 포함되지 않아요.</p></details>}
        <section className="catalog-export-options"><h3>실행 프로젝트 선택</h3><div className="catalog-flowly-export"><Icon name="workflow" size={20}/><div><strong>Flowly 실행기 · Node.js / Python</strong><p>예시 입력과 평가 기준을 포함한 실행 프로젝트입니다. 두 ZIP 모두 AI_PROMPT.md·AGENTS.md·Skill 실행 지침을 제공해요. START_HERE.md부터 확인하고, 수정하려면 ‘복제해서 시작하기’를 선택하세요.</p><div className="catalog-direct-downloads">{(["node","python"] as const).map(language=><button key={language} className="btn secondary" disabled={demo||!!busy} onClick={()=>void download({id:`${id}-${language}`,language,flowly:true})}><Icon name={busy===`${id}-${language}`?"loader":"download"} size={15}/>{language==="node"?"Node.js":"Python"} ZIP</button>)}</div></div></div>
          <div className="catalog-flowly-export"><Icon name="workflow" size={20}/><div><strong>AI 명령 프롬프트 · Agent 프로젝트</strong><p>AI 명령 프롬프트는 설계와 실행 지침을 미리 보고 복사합니다. Agent ZIP에는 Agent.md, 역할별 지침과 설계를 확인하여 실행하는 Agent 진입점이 포함됩니다.</p><label className="export-agent-language">실행 언어<select aria-label="예제 Agent 또는 프롬프트 실행 언어" value={exportLanguage} disabled={!!busy} onChange={event=>{setExportLanguage(event.target.value as "node"|"python");setPromptText("");}}><option value="node">Node.js</option><option value="python">Python</option></select></label><div className="catalog-direct-downloads"><button className="btn secondary" disabled={demo||!!busy} onClick={()=>void download({id:`${id}-prompt`,language:exportLanguage,flowly:true,kind:"prompt"})}><Icon name={busy===`${id}-prompt`?"loader":"copy"} size={15}/>AI 명령 프롬프트</button><button className="btn secondary" disabled={demo||!!busy} onClick={()=>void download({id:`${id}-agent-${exportLanguage}`,language:exportLanguage,flowly:true,kind:"agent"})}><Icon name={busy===`${id}-agent-${exportLanguage}`?"loader":"download"} size={15}/>Agent · {exportLanguage==="node"?"Node.js":"Python"} ZIP</button></div><p className="catalog-test-note">Agent 블록 없이도 현재 설계 그대로 다운로드합니다. 가짜 Agent를 추가하지 않으며 연결·자료 권한은 별도로 확인합니다.</p></div></div>
          {promptText&&<PromptPreview text={promptText}/>}
          {project.variants.length > 0 && <p className="catalog-test-note">아래 SDK 패키지는 같은 주제를 다루는 별도 구현입니다. 위 Flowly 그래프와 처리 단계·분기가 같다는 의미는 아닙니다.</p>}
          {project.variants.length > 0 ? <div className="catalog-variants">{project.variants.map(variant => <article key={variant.id}>
            <div><strong>{variant.title}</strong><p>{variant.framework} · {variant.language} · {variant.kind === "platform" || variant.kind === "platform_import" ? "플랫폼 가져오기 및 API 연결" : variant.kind === "bridge" ? "별도 실행 환경 연결" : "프레임워크 SDK 프로젝트"}</p><small>구조 {variant.verification.static ? "확인" : "미검증"} · 로컬 {variant.verification.offline ? "확인" : "미검증"} · 실제 API {variant.verification.live ? "확인" : "미검증"}</small></div>
            <button className="btn secondary" disabled={demo || !!busy} onClick={() => void download(variant)}><Icon name={busy === variant.id ? "loader" : "download"} className={busy === variant.id ? "spin" : ""} size={15}/>ZIP 받기</button>
          </article>)}</div> : <p className="catalog-test-note">이 예제의 별도 프레임워크 SDK 프로젝트는 아직 등록되지 않았어요. Flowly 실행기로 내보낼 수 있습니다.</p>}
        </section>
      </>}
      {demo && <p className="catalog-test-note">예제 복사와 실행 프로젝트 다운로드는 로그인 후 사용할 수 있어요. 노드 학습용 시작점은 체험 모드에서도 사용할 수 있습니다.</p>}
      {notice && <p className="catalog-download-notice" role="status">{notice}</p>}
    </div>
    <footer className="modal-footer"><button className="btn secondary" disabled={!!busy} onClick={onClose}>닫기</button><button className="btn primary" disabled={!project || demo || !!busy} onClick={() => void instantiate()}><Icon name={busy === "instantiate" ? "loader" : "copy"} className={busy === "instantiate" ? "spin" : ""} size={16}/>{busy === "instantiate" ? "복사 중" : "복제해서 시작하기"}</button></footer>
  </Modal>;
}

/** 검색 조건·페이지·선택한 상세 예제를 관리한다. 공통 예제 원본의 변경은 이 컴포넌트에서 수행하지 않는다. */
export function ExampleCatalog({ demo, resources = [], starters, starterCount, onChoose }: {
  demo: boolean; resources?: Resource[]; starters: ReactNode; starterCount: number; onChoose: (workflow: Workflow, resources: Resource[]) => void;
}) {
  const [tab, setTab] = useState<"catalog" | "supporting" | "starters" | "planned">("catalog");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [workStyle,setWorkStyle]=useState("");
  const [page, setPage] = useState(1);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  function chooseTab(next: typeof tab) {
    if (next === tab) return;
    setTab(next); setPage(1); setQuery(""); setCategory("");setWorkStyle(""); setError("");
    if (next === "catalog" || next === "supporting") setLoading(true);
  }
  function navigateTabs(event: KeyboardEvent<HTMLDivElement>) {
    const tabs = ["catalog", "supporting", "planned", "starters"] as const;
    const index = tabs.indexOf(tab);
    const next = event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length]
      : event.key === "ArrowLeft" ? tabs[(index + tabs.length - 1) % tabs.length]
      : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : null;
    if (next) { event.preventDefault(); chooseTab(next); document.getElementById(`${next}-tab`)?.focus(); }
  }
  useEffect(() => {
    if (tab !== "catalog" && tab !== "supporting") return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true); setError("");
      const parameters = new URLSearchParams({ view: tab, q: query, category, workStyle, page: String(page), pageSize: "18" });
      void getJson<Catalog>(`/api/examples?${parameters}`, controller.signal).then(data => {
        if (!controller.signal.aborted) { setCatalog(data); setLoading(false); }
      }).catch(reason => { if (!controller.signal.aborted) { setError((reason as Error).message); setLoading(false); } });
    }, query ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [tab, query, category, workStyle, page, retry]);
  const totalPages = catalog ? Math.max(1, Math.ceil(catalog.total / catalog.pageSize)) : 1;
  const count = (value: number | undefined) => value === undefined ? "—" : value.toLocaleString("ko-KR");
  return <section className="page-content example-catalog">
    <header className="page-heading"><div><span className="eyebrow">FROM IDEA TO RUNNABLE PROJECT</span><h1>예제 프로젝트<span className="heading-dot">.</span></h1><p>해결할 일과 받을 결과를 확인하고, 복제한 뒤 내 작업에 맞게 바꾸세요.</p></div>{tab==="catalog"&&<div className="page-heading-actions"><button className="btn secondary" onClick={()=>{setQuery("");setCategory("대표 AI 시스템");setWorkStyle("");setPage(1);}}>대표 예제 6개 보기<Icon name="arrowRight" size={15}/></button></div>}</header>
    <details className="catalog-overview-details"><summary><span>예제 {count(catalog?.stats.projects)}개 · 검증 범위 안내</span><span>실제 API·모델 품질 미검증</span></summary><div className="catalog-overview"><div><Icon name="templates" size={22}/><span>AI Agent 예제<strong>{count(catalog?.stats.projects)}<small>개</small></strong></span></div><div><span>두 언어 로컬 실행 확인<strong>{count(catalog?.stats.verified)}<small>개</small></strong></span><span>서로 다른 연결 구조<strong>{count(catalog?.stats.topologies)}<small>개</small></strong></span></div></div>
    <p className="catalog-count-note"><strong>모든 예제는 서로 다른 노드 연결·분기·실행 흐름을 가집니다. 이름·프롬프트만 바꾼 사례는 제공하지 않습니다.</strong><br/>로컬 실행 확인은 검증용 응답을 사용한 검사 범위이며 실제 API 연결과 모델 답변 품질은 아직 검증하지 않았습니다. 프레임워크·언어별 실행 변형과 노드 학습용 시작점은 개별 예제 수에 더하지 않습니다.</p>
    <p className="catalog-count-note">AI Agent 예제 목표 {count(catalog?.stats.target)}개 중 현재 {count(catalog?.stats.projects)}개를 제공하며, {count(catalog?.stats.remaining)}개가 남아 있습니다. Agent가 없는 보조 흐름 {count(catalog?.stats.supporting)}개는 별도 보관합니다.</p>
    <p className="catalog-count-note">대표 예제 6개로 병렬 검토·RAG·Harness·작업 조정·멀티 에이전트·승인과 복구를 살펴볼 수 있습니다.</p></details>
    <div className="catalog-tabs" role="tablist" aria-label="예제 종류" onKeyDown={navigateTabs}>
      <button role="tab" id="catalog-tab" aria-controls="catalog-panel" aria-selected={tab === "catalog"} tabIndex={tab === "catalog" ? 0 : -1} onClick={() => chooseTab("catalog")}>AI Agent 예제 <span>{count(catalog?.stats.projects)}</span></button>
      <button role="tab" id="supporting-tab" aria-controls="supporting-panel" aria-selected={tab === "supporting"} tabIndex={tab === "supporting" ? 0 : -1} onClick={() => chooseTab("supporting")}>계산·기존 보조 흐름 <span>{count(catalog?.stats.supporting)}</span></button>
      <button role="tab" id="planned-tab" aria-controls="planned-panel" aria-selected={tab === "planned"} tabIndex={tab === "planned" ? 0 : -1} onClick={() => chooseTab("planned")}>기획·도구 연결표 <span>100</span></button>
      <button role="tab" id="starters-tab" aria-controls="starters-panel" aria-selected={tab === "starters"} tabIndex={tab === "starters" ? 0 : -1} onClick={() => chooseTab("starters")}>노드 학습용 시작점 <span>{starterCount}</span></button>
    </div>
    {tab === "planned" ? <div role="tabpanel" id="planned-panel" aria-labelledby="planned-tab"><PlannedExamples onOpen={setSelected}/></div> : tab === "starters" ? <div role="tabpanel" id="starters-panel" aria-labelledby="starters-tab"><p className="catalog-starter-note">작은 흐름으로 노드 사용법을 익히는 학습용 시작점입니다. 독립적인 예제 프로젝트 개수와 목표 달성 수에는 포함하지 않습니다.</p>{starters}</div> : <div role="tabpanel" id={`${tab}-panel`} aria-labelledby={`${tab}-tab`} aria-busy={loading}>
      <p className="catalog-starter-note">{tab === "supporting" ? "명시적 AI Agent가 없는 계산·검증·기존 흐름입니다. AI Agent 예제 수에 더하지 않으며 기존 작업을 참고하거나 보조 흐름으로 가져올 수 있습니다." : "AI Agent 블록을 포함한 워크플로입니다. 조건별 경로와 팀·반복·하위 흐름의 내부 구성까지 확인할 수 있습니다."}</p>
      <div className="catalog-filters"><label className="search-field"><Icon name="search" size={17}/><input aria-label="예제 프로젝트 검색" placeholder="해결할 일, 기술, 노드 검색" value={query} maxLength={120} onChange={event => { setLoading(true); setQuery(event.target.value); setPage(1); }}/></label><label><span>일하는 방식</span><select aria-label="일하는 방식" value={workStyle} onChange={event=>{setLoading(true);setWorkStyle(event.target.value);setPage(1);}}><option value="">모든 방식</option>{catalog?.workStyles?.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label><span>업무 분야</span><select value={category} onChange={event => { setLoading(true); setCategory(event.target.value); setPage(1); }}><option value="">모든 업무 분야</option>{catalog?.categories.map(item => <option key={item} value={item}>{item}</option>)}</select></label></div>
      <div className="catalog-results-heading" role="status"><span>{loading ? "예제를 찾고 있어요…" : `${(catalog?.total || 0).toLocaleString("ko-KR")}개 결과`}</span>{(query || category || workStyle) && <button className="text-btn" onClick={() => { setLoading(true); setQuery(""); setCategory("");setWorkStyle(""); setPage(1); }}>필터 초기화</button>}</div>
      {error ? <div className="catalog-load-error" role="alert"><p>{error}</p><button className="btn secondary" onClick={() => setRetry(value => value + 1)}>다시 불러오기</button></div> : loading ? <div className="catalog-loading"><Icon name="loader" className="spin" size={20}/><span>필요한 예제 목록만 불러오고 있어요.</span></div> : catalog?.items.length ? <div className="catalog-grid">{catalog.items.map(project => <button className="catalog-card" key={project.id} onClick={() => setSelected(project.id)}>
        <div className="catalog-card-top"><span className="catalog-category">{project.category}</span><span className={`catalog-setup ${project.status === "ready" ? "ready" : ""}`}>{project.status === "ready" ? "모델 키 없이 실행" : "연결 설정 필요"}</span></div><h2>{project.title}</h2><p className="catalog-card-purpose">{project.description}</p>{project.uniqueBehavior!==project.description&&<p className="catalog-card-method"><strong>진행 방식 </strong>{project.uniqueBehavior}</p>}<div className="catalog-frameworks">{project.workStyles?.map(style=><span key={style}>{workStyleLabels[style as WorkStyle]??style}</span>)}</div><div className="catalog-node-types">{Array.from(new Set(project.nodeTypes)).slice(0,4).map(type => <span key={type}>{nodeNames[type as NodeType] || type}</span>)}{new Set(project.nodeTypes).size > 4 && <span>+{new Set(project.nodeTypes).size-4}</span>}</div><VerificationLabels verification={project.verification}/><footer><span>준비물·결과·실행 흐름 보기</span><Icon name="arrowRight" size={16}/></footer>
      </button>)}</div> : <EmptyState title="조건에 맞는 예제가 없어요" description="검색어를 줄이거나 다른 일하는 방식과 업무 분야를 선택해 보세요."/>}
      {catalog && !error && <nav className="catalog-pagination" aria-label="예제 페이지"><button className="text-btn" disabled={loading||page<=1} onClick={()=>{setLoading(true);setPage(1);}}>처음</button><button className="btn secondary" disabled={loading || page <= 1} onClick={() => { setLoading(true); setPage(value => value-1); }}><Icon name="chevronLeft" size={15}/>이전</button><span>{catalog.page} / {totalPages} 페이지</span><button className="btn secondary" disabled={loading || page >= totalPages} onClick={() => { setLoading(true); setPage(value => value+1); }}>다음<Icon name="chevronRight" size={15}/></button><button className="text-btn" disabled={loading||page>=totalPages} onClick={()=>{setLoading(true);setPage(totalPages);}}>마지막</button></nav>}
    </div>}
    {selected && <ProjectDetail key={selected} id={selected} demo={demo} resources={resources} onClose={() => setSelected(null)} onChoose={onChoose}/>}
  </section>;
}

