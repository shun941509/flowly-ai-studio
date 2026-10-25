import type { Definition, FlowNode, NodeType } from "./model";

export const v5Templates=[
 {id:"file-text",title:"로컬 문서의 글 읽기",description:"inputs/의 파일을 확인하고 문서 본문과 출처를 추출해요.",tag:"파일 입력 · 문서 처리",category:"리서치",icon:"file",count:4},
 {id:"file-ocr",title:"이미지에서 문자 읽기",description:"로컬 OCR 엔진으로 이미지의 글을 읽어요. OCR 설치가 필요해요.",tag:"OCR",category:"리서치",icon:"search",count:4},
 {id:"table-export",title:"문서의 표를 CSV로 저장",description:"파일에서 첫 표를 꺼내 outputs/에 CSV 산출물을 만들어요.",tag:"표 추출 · 파일 출력",category:"업무 생산성",icon:"download",count:5},
 {id:"guard-evaluate",title:"민감정보를 가리고 결과 확인",description:"민감한 내용을 가린 뒤 규칙으로 평가하고 통과 여부에 따라 분기해요.",tag:"민감정보 필터 · 평가",category:"업무 생산성",icon:"shield",count:7},
 {id:"vector-answer",title:"문서의 의미를 찾아 답하기",description:"등록 자료를 실제 임베딩으로 검색하고 근거를 바탕으로 답해요.",tag:"벡터 검색",category:"리서치",icon:"search",count:4},
 {id:"web-stream",title:"웹에서 찾아 답변 이어 받기",description:"실제 웹 검색의 출처로 답하고 생성 중 응답을 부분 이벤트로 표시해요.",tag:"웹 검색 · 스트리밍",category:"리서치",icon:"globe",count:4},
 {id:"adaptive-plan",title:"결과를 보고 다음 작업 정하기",description:"등록된 작업 안에서 결과를 확인하며 최대 3라운드 계획해요.",tag:"적응형 작업 조정",category:"업무 생산성",icon:"workflow",count:3},
 {id:"scheduled-work",title:"일정 간격으로 요청 처리",description:"내보낸 폴더에서 트리거 도우미를 켜고 일정에 따라 실행해요.",tag:"자동 시작",category:"업무 생산성",icon:"play",count:3},
 {id:"memory-ttl",title:"하루 동안 요청 기억하기",description:"로컬 기억에 만료 시간을 두고 다음 실행에서 사용할 수 있게 해요.",tag:"기억 · 보관 기간",category:"업무 생산성",icon:"history",count:3},
 {id:"mcp-memory",title:"외부 기억 서비스 연결하기",description:"MCP 기억 도구를 직접 선택해야 사용할 수 있는 연결용 시작점이에요.",tag:"도구 선택 필요",category:"도구 활용",icon:"plug",count:3},
 {id:"compensation-work",title:"변경 작업과 보상 연결하기",description:"원래 변경과 별도 보상 도구를 선택하고 각각 승인해 실행하도록 구성해요.",tag:"도구 선택 필요",category:"도구 활용",icon:"undo",count:4},
];
const node=(id:string,type:NodeType,title:string,extra:Partial<FlowNode>={}):FlowNode=>({id,type,title,x:230,y:25,...extra});
const chain=(nodes:FlowNode[]):Definition=>({schemaVersion:5,nodes:nodes.map((n,i)=>({...n,y:25+i*190})),edges:nodes.slice(1).map((n,i)=>({id:`${nodes[i].id}-${n.id}`,source:nodes[i].id,target:n.id}))});
const input=()=>node("input","input","사용자 입력"),output=()=>node("output","output","답변 출력");
function fileNodes(filename:string,mode:"text"|"table"|"ocr"):FlowNode[]{return [
 node("form","form","읽을 파일",{description:`예: ${JSON.stringify({file:filename})}`,form:{fields:[{key:"file",label:"파일 이름",type:"file",required:true}]}}),
 node("file","file_input","파일 확인",{fileInput:{path:"file",maxBytes:10_000_000},inputBindings:{file:{nodeId:"form",path:"data.file"}}}),
 node("extract","document_extract","문서 내용 읽기",{documentExtract:{mode,filePath:"file",maxPages:100,language:"kor+eng"},inputBindings:{file:{nodeId:"file",path:"file"}}}),
];}
export function v5Template(kind:string):Definition|undefined{
 if(kind==="file-text")return chain([...fileNodes("sample.txt","text"),output()]);
 if(kind==="file-ocr")return chain([...fileNodes("sample.png","ocr"),output()]);
 if(kind==="table-export")return chain([...fileNodes("sample.csv","table"),node("export","file_output","첫 표를 CSV로 저장",{fileOutput:{format:"csv",filename:"table.csv",dataPath:"data"},inputBindings:{data:{nodeId:"extract",path:"tables.0.rows"}}}),output()]);
 if(kind==="guard-evaluate")return {schemaVersion:5,nodes:[input(),node("filter","guardrail","민감정보 가리기",{y:215,guardrail:{action:"mask",categories:["email","phone","resident_id","card","secret"]}}),node("evaluate","evaluate","내용 길이 확인",{y:405,evaluation:{mode:"rules",rules:[{kind:"min_length",value:"10"}],rubric:"",threshold:1}}),node("passed","transform","통과 여부를 글로 변환",{y:595,transform:{mode:"template",template:"{{evaluation.passed}}"},inputBindings:{evaluation:{nodeId:"evaluate",path:"evaluation"}}}),node("condition","condition","평가 기준 통과 여부",{y:785,condition:"true",inputBindings:{text:{nodeId:"passed",path:"text"},answer:{nodeId:"evaluate",path:"text"}}}),node("accepted","output","통과한 내용",{x:70,y:975,inputBindings:{text:{nodeId:"condition",path:"answer"}}}),node("needs-review","output","추가 확인할 내용",{x:390,y:975,inputBindings:{text:{nodeId:"condition",path:"answer"}}})],edges:[{id:"input-filter",source:"input",target:"filter"},{id:"filter-evaluate",source:"filter",target:"evaluate"},{id:"evaluate-passed",source:"evaluate",target:"passed"},{id:"passed-condition",source:"passed",target:"condition"},{id:"evaluate-condition",source:"evaluate",target:"condition"},{id:"accepted",source:"condition",target:"accepted",branch:"yes"},{id:"needs-review",source:"condition",target:"needs-review",branch:"no"}]};
 if(kind==="vector-answer"||kind==="web-stream")return chain([input(),node("search","retrieval",kind==="vector-answer"?"의미로 문서 검색":"웹 검색",{retrieval:{mode:kind==="vector-answer"?"vector":"web",resourceIds:kind==="vector-answer"?["sample-handbook"]:[],topK:3,chunkSize:700,...(kind==="vector-answer"?{indexKey:"team_handbook"}:{})}}),node("answer","ai","출처를 포함해 답하기",{prompt:"제공된 검색 근거로만 한국어로 답하고 출처를 포함하세요. 확인되지 않은 내용은 추측하지 마세요."}),{...output(),delivery:{stream:kind==="web-stream"}}]);
 if(kind==="adaptive-plan"){const task=(template:string)=>chain([input(),node("format","transform","요청 정리",{transform:{mode:"template",template}}),output()]);return chain([input(),node("plan","orchestrator","결과에 따라 다음 작업 선택",{prompt:"요청 확인 작업을 진행하고 필요하면 문장을 정리하세요. 충분한 결과가 있으면 종료하세요.",orchestration:{mode:"adaptive",maxRounds:3,maxTasks:2,tasks:[{id:"acknowledge",name:"요청 확인",definition:task("확인할 요청: {{text}}")},{id:"format",name:"문장 정리",definition:task("처리할 내용: {{text}}")}]}}),output()]);}
 if(kind==="scheduled-work")return chain([node("trigger","trigger","1시간 간격으로 시작",{trigger:{kind:"schedule",intervalSeconds:3600,startAt:"",eventType:"flowly.event"}}),node("format","transform","요청 접수",{transform:{mode:"template",template:"접수한 요청: {{text}}"}}),output()]);
 if(kind==="memory-ttl"||kind==="mcp-memory")return chain([input(),node("memory","memory",kind==="memory-ttl"?"하루 동안 요청 보관":"기억 서비스에 저장",{memory:{backend:kind==="memory-ttl"?"local":"mcp",action:"write",key:"last_request",valuePath:"text",ttlSeconds:86400},...(kind==="mcp-memory"?{allowedTools:[]}:{})}),output()]);
 if(kind==="compensation-work")return chain([input(),node("write","tool","원래 변경 도구 선택",{allowedTools:[],tool:{arguments:{},bindings:{}}}),node("compensate","compensate","별도 보상 도구 선택",{allowedTools:[],compensation:{sourceNodeId:"write",arguments:{},bindings:{}},inputBindings:{text:{nodeId:"write",path:"text"},result:{nodeId:"write",path:"result"}}}),output()]);
}
