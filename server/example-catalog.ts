import authored from "../domain/generated/workflow-designs.json";
import type { WorkflowDesign } from "../domain/workflow-design";
import { nodeRequiresModel } from "../domain/extended-config";
import { uid, nodeNames, type Identity, type Workflow } from "../app/lib/model";
import { compileDefinition } from "../domain/workflow";
import { allNodes } from "../domain/advanced-config";
import { assertDistinctExamples, hasExplicitAgent } from "../domain/example-publication";
import { EXAMPLE_TARGET, type ExampleProject, type ExampleSummary } from "../domain/example-types";
import { frameworkPacks } from "./generated/framework-packs";
import { catalogVerification } from "./generated/catalog-verification";
import { exampleConnections } from "./example-connections";
import { workflowWorkStyles, workStyleLabels } from "../domain/work-styles";

type PublishedDesign = Omit<WorkflowDesign,"scenarios"> & {designHash:string;topologyHash:string;executionHash:string};
const designs = (authored as PublishedDesign[]).toSorted((a,b)=> {
  const representativeA=a.id.startsWith("showcase-"),representativeB=b.id.startsWith("showcase-");
  return Number(representativeB)-Number(representativeA)||(representativeA&&representativeB?a.title.localeCompare(b.title,"ko"):0);
});
const designsById = new Map(designs.map(d=>[d.id,d]));
const date = "2026-10-22T00:00:00.000Z";
const verifiedIds = new Set(catalogVerification);
const distinct = assertDistinctExamples(designs);

export function getExample(id: string): ExampleProject | undefined {
  const design=designsById.get(id);
  if(design) {
    const workflow:Workflow={id:`example-${id}`,name:design.title,description:design.description,definition:compileDefinition(design.definition),updatedAt:date};
    const variants=frameworkPacks.filter(p=>p.projectId===id).map(({files:_files,...meta})=>{void _files;return meta;});
    const requiresModel=allNodes(workflow.definition).some(nodeRequiresModel),verified=verifiedIds.has(id),hasAgent=hasExplicitAgent(workflow.definition);
    const connections=exampleConnections({userId:"export-recipient",email:"",displayName:""},design.resources);
    const requirements=[...(requiresModel?["내보낸 폴더에 본인 모델 키와 모델명 설정","실제 모델 답변 품질은 별도 검증 필요"]:["모델 키 없이 로컬 실행 가능"]),...connections.map(c=>`${c.name}: 내보낸 .env의 ${c.endpointEnv}와 ${c.tokenEnv} 설정 필요. 서비스 연결·자격 증명은 포함되지 않습니다.`)];
    return {id,workStyles:workflowWorkStyles(workflow.definition),title:design.title,description:design.description,category:design.category,hasAgent,classification:hasAgent?"agent":"supporting",frameworks:["Flowly",...new Set(variants.map(v=>v.framework))],tags:[hasAgent?"AI Agent 예제":"계산·기존 보조 흐름",...(id.startsWith("showcase-")?["대표 예제"]:[])],nodeTypes:[...new Set(allNodes(workflow.definition).map(n=>n.type))],status:requiresModel||connections.length?"setup_required":"ready",kind:"workflow",uniqueBehavior:design.behavior,verification:{schema:true,node:verified,python:verified,live:false},inputExample:design.inputExample,expectedOutput:design.expectedOutput,requirements,workflow,resources:structuredClone(design.resources),variants,acceptance:design.acceptance,failureCases:design.failureCases,sourceLicense:"직접 작성한 합성 자료와 개별 실행 설계"};
  }
}

const summaries:ExampleSummary[]=designs.map(d=>{const project=getExample(d.id)!;const {workflow:_workflow,resources:_resources,variants:_variants,inputExample:_input,expectedOutput:_expected,requirements:_requirements,acceptance:_acceptance,failureCases:_failures,sourceLicense:_license,...summary}=project;void [_workflow,_resources,_variants,_input,_expected,_requirements,_acceptance,_failures,_license];return summary;});
const normalizeSearch=(text:string)=>text.normalize("NFKC").toLocaleLowerCase();
const searchable=(items:ExampleSummary[])=>items.map(s=>normalizeSearch(`${s.id} ${s.title} ${s.description} ${s.tags.join(" ")} ${s.uniqueBehavior} ${s.frameworks.join(" ")} ${s.nodeTypes.map(t=>nodeNames[t]).join(" ")}`));
const agentSummaries=summaries.filter(summary=>summary.hasAgent),supportingSummaries=summaries.filter(summary=>!summary.hasAgent);
const catalogStats={projects:agentSummaries.length,supporting:supportingSummaries.length,sourceGraphs:summaries.length,sourceTopologies:distinct.topologies,variants:frameworkPacks.length,target:EXAMPLE_TARGET,reviewed:0,remaining:Math.max(0,EXAMPLE_TARGET-agentSummaries.length),topologies:agentSummaries.length,verified:agentSummaries.filter(s=>s.verification.node&&s.verification.python).length};
export function listExamples(params:URLSearchParams) {
  const q=normalizeSearch((params.get("q")||"").slice(0,120).trim());
  const framework=params.get("framework"),category=params.get("category"),workStyle=params.get("workStyle");
  const view=params.get("view");
  const source=view==="supporting"?supportingSummaries:!view||view==="catalog"?agentSummaries:[];
  const index=searchable(source);
  const filtered=source.filter((s,i)=>(!framework||s.frameworks.includes(framework))&&(!category||s.category===category)&&(!workStyle||s.workStyles?.includes(workStyle))&&(!q||index[i].includes(q)));
  const integer=(value:string|null,fallback:number,max:number)=>value&&/^\d+$/.test(value)?Math.max(1,Math.min(max,Number(value))):fallback;
  const pageSize=integer(params.get("pageSize"),18,48),page=integer(params.get("page"),1,100000);
  const frameworks=[...new Set(source.flatMap(s=>s.frameworks))].sort(),categories=[...new Set(source.map(s=>s.category))].sort();
  return {items:filtered.slice((page-1)*pageSize,page*pageSize),total:filtered.length,page,pageSize,stats:catalogStats,frameworks,categories,workStyles:Object.entries(workStyleLabels).filter(([id])=>source.some(item=>item.workStyles?.includes(id))).map(([id,label])=>({id,label}))};
}

export function instantiateExample(project:ExampleProject,user:Identity) {
  const now=new Date().toISOString(),remap=new Map(project.resources.map(r=>[r.id,uid("res")]));
  const resources=project.resources.map(r=>({...r,id:remap.get(r.id)!,ownerId:user.userId,visibility:"private" as const,allowedEmails:[],sample:undefined,createdAt:now,updatedAt:now}));
  const workflow=structuredClone(project.workflow);workflow.id=uid("flow");workflow.updatedAt=now;
  for(const node of allNodes(workflow.definition)) {
    if(node.resourceId)node.resourceId=remap.get(node.resourceId)||node.resourceId;
    if(node.knowledge){node.knowledge.resourceIds=node.knowledge.resourceIds.map(id=>remap.get(id)||id); if(node.knowledge.evaluation)node.knowledge.evaluation=node.knowledge.evaluation.map(e=>({...e,resourceId:remap.get(e.resourceId)||e.resourceId}));}
    if(node.retrieval)node.retrieval.resourceIds=node.retrieval.resourceIds.map(id=>remap.get(id)||id);
    for(const tool of node.allowedTools||[])tool.resourceId=remap.get(tool.resourceId)||tool.resourceId;
  }
  return {workflow,resources};
}

export async function saveExample(db:D1Database,project:ExampleProject,user:Identity) {
  const copy=instantiateExample(project,user),now=copy.workflow.updatedAt;
  const statements=copy.resources.map(r=>db.prepare("INSERT INTO resources(id,owner_id,name,type,description,content,url,visibility,allowed_emails,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(r.id,user.userId,r.name,r.type,r.description,r.content,r.url,"private","[]",now,now));
  statements.push(db.prepare("INSERT INTO workflows(id,owner_id,name,description,definition,updated_at) VALUES(?,?,?,?,?,?)").bind(copy.workflow.id,user.userId,copy.workflow.name,copy.workflow.description,JSON.stringify(copy.workflow.definition),now));
  statements.push(db.prepare("INSERT INTO audit_events(id,owner_id,actor_id,action,target_type,target_id,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(uid("audit"),user.userId,user.userId,"example.instantiate","workflow",copy.workflow.id,JSON.stringify({exampleId:project.id}),now));
  await db.batch(statements);return copy;
}
