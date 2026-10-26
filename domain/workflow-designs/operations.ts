/**
 * 사내 자료 조회·변경 요청·검토 등 운영 업무의 예제다. MCP 정의와 허용 도구 계약을 명시하며 실제 주소와 자격 증명은 포함하지 않는다.
 * 노드/연결/자료는 내려받을 설계이며 scenarios의 응답·상태 기대값은 테스트 전용이다.
 */
import type { Definition, FlowNode, Resource } from "../../app/lib/model";
import type { WorkflowDesign, WorkflowScenario } from "../workflow-design";
import type { FormConfig, InputBinding } from "../../runtime/types";

const n=(id:string,type:FlowNode["type"],title:string,extra:Partial<FlowNode>={}):FlowNode=>({id,type,title,x:240,y:0,...extra});
const b=(nodeId:string,path="text"):InputBinding=>({nodeId,path});
const f=(key:string,type:FormConfig["fields"][number]["type"]="number")=>({key,label:key,type,required:true});
const form=(fields:FormConfig["fields"])=>n("input","form","실행 정보 입력",{form:{fields}});
const out=(id="output")=>n(id,"output","결과 확인");
const message=(id:string,text:string)=>n(id,"transform",text.slice(0,14),{transform:{mode:"template",template:text}});
const ai=(id:string,prompt:string,extra:Partial<FlowNode>={})=>n(id,"agent",prompt.slice(0,14),{prompt,allowedTools:[],limits:{maxTurns:2,maxTokens:2000,maxToolCalls:1,maxDurationMs:30000},...extra});
const review=(id="review")=>n(id,"review","담당자 확인",{review:{instructions:"입력과 결과를 확인하고 수락 또는 거절하세요. 외부 발송은 하지 않습니다.",allowEdit:true,timeoutMinutes:60}});
function graph(nodes:FlowNode[],links:[string,string,string?][]):Definition {
  const depths=new Map<string,number>();
  for(let i=0;i<nodes.length;i++)for(const node of nodes) {const incoming=links.filter(e=>e[1]===node.id);depths.set(node.id,incoming.length?1+Math.max(...incoming.map(e=>depths.get(e[0])??0)):0);}
  const lanes=new Map<number,number>();
  return {schemaVersion:5,nodes:nodes.map(node=>{const depth=depths.get(node.id)!,lane=lanes.get(depth)??0;lanes.set(depth,lane+1);return {...node,x:60+lane*250,y:30+depth*150};}),edges:links.map(([source,target,branch],i)=>({id:`e${i}`,source,target,...(branch?{branch}:{})}))};
}
function resource(id:string,content:string):Resource {return {id,ownerId:"flowly-examples",name:"합성 업무 자료",type:"document",description:"실계정과 무관한 합성 자료",content,url:"",visibility:"public",allowedEmails:[],sample:true,createdAt:"2026-10-23T00:00:00Z",updatedAt:"2026-10-23T00:00:00Z"};}
function design(id:string,title:string,behavior:string,definition:Definition,resources:Resource[],scenarios:WorkflowScenario[]):WorkflowDesign {
  return {id,title,category:"업무별 실행 설계",description:behavior,behavior,definition,resources,scenarios,inputExample:scenarios[0].input,expectedOutput:(scenarios[0].contains??[]).join(" / "),acceptance:[behavior,"분기 결과에 해당하는 노드만 실행한다.","입력 오류는 가짜 성공으로 변환하지 않는다."],failureCases:scenarios.slice(1).map(scenario=>scenario.name)};
}

const knowledge=resource("design-access-policy","접근 권한은 자료 소유자의 승인 후 부여합니다. 비밀번호는 문의에 쓰지 않습니다.");
const shipping=resource("design-shipments","S101: 집화 완료, 예정일 2026-10-25. 그 외 주문번호는 조회 자료에 없습니다.");
const grant=resource("design-grant-evidence","[근거 A] 합성 교육 사업 참여자는 40명이며 수료자는 32명입니다. 만족도는 조사하지 않았습니다.");

export const operationsWorkflowDesigns:WorkflowDesign[]=[
  design("knowledge-routing","문의 종류별 담당 경로","AI 분류 후 권한 문의는 정책 문서로, 장애 문의는 담당자 검토로, 알 수 없는 문의는 추가 질문으로 분기한다.",graph([
    n("input","input","문의 입력"),n("route","classify","문의 유형 분류",{prompt:"권한·장애·기타 문의를 분류하세요.",classification:{labels:[{id:"access",name:"권한",description:"접근 권한 요청"},{id:"incident",name:"장애",description:"서비스 중단"},{id:"other",name:"기타",description:"추가 확인 필요"}]}}),
    n("policy","resource","권한 정책 안내",{resourceId:knowledge.id}),out("policy_out"),message("incident_message","장애 담당자에게 전달할 문의를 검토합니다. 문의 원문: {{text}}"),review(),out("review_out"),message("rejected","전달 검토가 거절되었습니다."),out("rejected_out"),message("clarify","문의 대상과 증상을 더 알려 주세요."),out("clarify_out")
  ],[["input","route"],["route","policy","access"],["policy","policy_out"],["route","incident_message","incident"],["incident_message","review"],["review","review_out","yes"],["review","rejected","no"],["rejected","rejected_out"],["route","clarify","other"],["clarify","clarify_out"]]),[knowledge],[
    {name:"권한 정책만 실행",input:"접근 권한이 필요합니다",modelReplies:[{match:"권한·장애·기타",text:'{"label":"access","reason":"권한 요청"}'}],status:"succeeded",contains:["자료 소유자"],visited:["policy"],skipped:["review","clarify"]},
    {name:"장애 검토 거절",input:"서비스 중단",modelReplies:[{match:"권한·장애·기타",text:'{"label":"incident","reason":"장애"}'}],review:"reject",status:"succeeded",contains:["거절"],outputs:{incident_message:{text:"장애 담당자에게 전달할 문의를 검토합니다. 문의 원문: 서비스 중단"}},skipped:["policy","review_out"]},
    {name:"미분류 문의",input:"안녕하세요",modelReplies:[{match:"권한·장애·기타",text:'{"label":"other","reason":"대상 불명"}'}],status:"succeeded",contains:["더 알려"],skipped:["policy","review"]}
  ]),
  design("inventory-tool-agent","재고 기준선과 발주안 검토","현재 재고와 재주문 기준을 숫자로 직접 비교하고 부족할 때만 AI 발주안을 작성하여 사람에게 검토를 요청한다. 실제 발주는 하지 않는다.",graph([
    form([f("stock"),f("threshold"),f("item","text")]),n("low","condition","재고 부족 비교",{predicate:{path:"data.stock",operator:"lt",rightPath:"data.threshold"},inputBindings:{data:b("input","data"),text:b("input")}}),ai("draft","재고 부족 항목의 발주 검토안을 작성하세요."),review(),out("accepted"),message("rejected","발주안 검토 거절. 발주하지 않았습니다."),out("denied"),message("enough","재고 충분. 발주안을 만들지 않습니다."),out("output")
  ],[["input","low"],["low","draft","yes"],["draft","review"],["review","accepted","yes"],["review","rejected","no"],["rejected","denied"],["low","enough","no"],["enough","output"]]),[],[
    {name:"부족한 경우만 검토",input:'{"stock":3,"threshold":8,"item":"상자"}',modelReplies:[{match:"재고 부족 항목",text:"상자 부족분 5개 발주안",inputContains:["상자"]}],review:"accept",status:"succeeded",contains:["5개"],visited:["draft","review"],skipped:["enough"]},
    {name:"기준과 같으면 모델 호출 없음",input:'{"stock":8,"threshold":8,"item":"상자"}',status:"succeeded",contains:["재고 충분"],skipped:["draft","review"]},
    {name:"숫자 문자열 거절",input:'{"stock":"3","threshold":8,"item":"상자"}',status:"failed",skipped:[]}
  ]),
  design("shipment-lookup","배송 조회 결과의 존재 여부 분기","합성 배송 기록에서 구조화된 조회 결과를 받아 found 값을 검사하고, 없는 주문에는 배송일을 만들지 않고 확인 요청을 반환한다.",graph([
    form([f("orderId","text")]),n("records","resource","배송 기록 읽기",{resourceId:shipping.id}),ai("lookup","배송 기록에서 요청 주문을 조회하고 {found:boolean,status:string,eta:string} JSON으로 답하세요.",{inputBindings:{text:b("input"),context:b("records")},format:"JSON",outputSchema:{type:"object",properties:{text:{type:"string"},data:{type:"object",properties:{found:{type:"boolean"},status:{type:"string"},eta:{type:"string"}},required:["found","status","eta"]}},required:["data"]}}),n("exists","condition","조회 결과 확인",{inputBindings:{data:b("lookup","data"),text:b("lookup")},predicate:{path:"data.found",operator:"eq",value:true}}),{...message("found","상태: {{data.status}} / 예정일: {{data.eta}}"),inputBindings:{data:b("exists","data")}},message("missing","주문을 찾지 못했습니다. 주문번호를 확인해 주세요."),out()
  ],[["input","records"],["input","lookup"],["records","lookup"],["lookup","exists"],["exists","found","yes"],["exists","missing","no"],["found","output"],["missing","output"]]),[shipping],[
    {name:"존재하는 주문",input:'{"orderId":"S101"}',modelReplies:[{match:"배송 기록에서 요청",text:'{"found":true,"status":"집화 완료","eta":"2026-10-25"}',inputContains:["S101","집화 완료"]}],status:"succeeded",contains:["집화 완료","2026-10-25"],skipped:["missing"]},
    {name:"알 수 없는 주문",input:'{"orderId":"S999"}',modelReplies:[{match:"배송 기록에서 요청",text:'{"found":false,"status":"","eta":""}',inputContains:["S999","집화 완료"]}],status:"succeeded",contains:["찾지 못"],excludes:["2026-10-25"],skipped:["found"]}
  ]),
  design("ticket-intake","지원 접수 정보 최소화","문의에서 이메일·전화번호를 가린 뒤 AI가 정형 접수 항목을 추출한다. 출력 스키마를 검증하고 필요한 두 필드만 전달한다.",graph([
    n("input","input","문의 원문"),n("mask","guardrail","연락처 가리기",{guardrail:{action:"mask",categories:["email","phone"]}}),ai("extract","연락처가 제거된 문의에서 {summary:string,impact:string}만 추출하세요.",{format:"JSON",outputSchema:{type:"object",properties:{data:{type:"object",properties:{summary:{type:"string"},impact:{type:"string"}},required:["summary","impact"]}},required:["data"]}}),n("minimal","transform","접수 필드만 선택",{transform:{mode:"pick",fields:{summary:"data.summary",impact:"data.impact"}},inputBindings:{data:b("extract","data")}}),out()
  ],[["input","mask"],["mask","extract"],["extract","minimal"],["minimal","output"]]),[],[
    {name:"연락처 제거 후 정형화",input:"test@example.test 연락 바랍니다. 결제 버튼이 안 됩니다.",modelReplies:[{match:"연락처가 제거된 문의",text:'{"summary":"결제 버튼 오류","impact":"구매 불가"}',inputExcludes:["test@example.test"]}],status:"succeeded",contains:["결제 버튼 오류","구매 불가"],excludes:["test@example.test"]},
    {name:"필수 응답 필드 누락",input:"결제 오류",modelReplies:[{match:"연락처가 제거된 문의",text:'{"summary":"오류"}'}],status:"failed"}
  ]),
  design("handover-risks","이전 인계 기록과 변경점 비교","이전 기록이 없으면 최초 기록을 저장하고, 다음 실행에서는 지속 저장된 기록과 새 내용을 AI가 비교한 뒤 기록을 갱신한다.",graph([
    n("input","input","현재 인계 기록"),n("previous","memory","이전 기록 조회",{memory:{action:"read",key:"handover",defaultValue:""}}),n("has_previous","condition","이전 기록 존재",{inputBindings:{text:b("previous"),previous:b("previous","data"),found:b("previous","found")},predicate:{path:"found",operator:"eq",value:true}}),ai("compare","이전 인계 기록(previous)과 새 기록(text)의 변경점만 정리하세요.",{inputBindings:{text:b("has_previous"),previous:b("has_previous","previous")}}),message("initial","최초 인계 기록을 저장했습니다."),n("joined","merge","인계 안내 선택",{merge:{mode:"text"},inputBindings:{initial:b("initial"),comparison:b("compare")}}),n("save","memory","현재 기록 저장",{memory:{action:"write",key:"handover",valuePath:"current"},inputBindings:{text:b("joined"),current:b("input")}}),out()
  ],[["input","previous"],["previous","has_previous"],["has_previous","compare","yes"],["has_previous","initial","no"],["compare","joined"],["initial","joined"],["joined","save"],["input","save"],["save","output"]]),[],[
    {name:"최초 기록 저장",input:"보고서 담당은 민수",stateGroup:"handover",status:"succeeded",contains:["최초"],skipped:["compare"]},
    {name:"두 번째 실행에서 이전 기록 비교",input:"보고서 담당은 지수",stateGroup:"handover",modelReplies:[{match:"이전 인계 기록(previous)",text:"보고서 담당: 민수에서 지수로 변경",inputContains:["민수","지수"]}],status:"succeeded",contains:["민수에서 지수"],visited:["compare"],skipped:["initial"]}
  ]),
  design("experiment-stop","실험 관측값에 따른 중단 우선순위","측정값이 중단 기준 이상이면 즉시 중단 안내를 출력한다. 기준 미만이어도 기준선 측정이 없으면 검토 대기하며, 두 조건을 통과해야 계속 안내한다.",graph([
    form([f("measurement"),f("stopLimit"),f("baselineReady","boolean")]),n("stop","condition","중단 기준 비교",{predicate:{path:"data.measurement",operator:"gte",rightPath:"data.stopLimit"},inputBindings:{data:b("input","data"),text:b("input")}}),message("stopped","중단 기준에 도달했습니다. 다음 실험을 진행하지 마세요."),out("stop_out"),n("baseline","condition","기준선 확보 확인",{predicate:{path:"data.baselineReady",operator:"eq",value:true},inputBindings:{data:b("stop","data"),text:b("stop")}}),message("continue","계속 가능: 중단 기준 미만이고 기준선을 확보했습니다."),out("continue_out"),review(),message("approved","기준선 보완을 담당자가 확인했습니다. 새 측정으로 다시 판단하세요."),message("denied","기준선 검토가 거절되었습니다. 실험을 보류합니다."),out("review_out")
  ],[["input","stop"],["stop","stopped","yes"],["stopped","stop_out"],["stop","baseline","no"],["baseline","continue","yes"],["continue","continue_out"],["baseline","review","no"],["review","approved","yes"],["review","denied","no"],["approved","review_out"],["denied","review_out"]]),[],[
    {name:"경계값 즉시 중단",input:'{"measurement":5,"stopLimit":5,"baselineReady":false}',status:"succeeded",contains:["중단 기준에"],skipped:["baseline","review"]},
    {name:"기준선 미확보 거절",input:'{"measurement":4,"stopLimit":5,"baselineReady":false}',review:"reject",status:"succeeded",contains:["보류"],skipped:["continue"]},
    {name:"계속 가능",input:'{"measurement":4,"stopLimit":5,"baselineReady":true}',status:"succeeded",contains:["계속 가능"],skipped:["review","stopped"]}
  ]),
  design("warehouse-fefo","재고 목록의 기한 경과 격리","입력한 배치 목록을 최대 20개까지 반복하고 남은 일수를 직접 비교한다. 지난 재고는 격리, 유효한 재고만 출고 검토로 표시한다. 정렬이나 실제 출고는 하지 않는다.",graph([
    n("input","input","배치 JSON 목록"),n("parse","transform","목록 해석",{transform:{mode:"parse_json"}}),n("inspect","loop","배치별 기한 검사",{inputBindings:{items:b("parse","data")},loop:{itemsPath:"items",maxItems:20,concurrency:2,definition:graph([n("input","input","현재 배치"),n("expired","condition","기한 경과 여부",{predicate:{path:"item.daysLeft",operator:"lt",value:0},inputBindings:{item:b("input","item")}}),{...message("hold","{{item.batch}}: 격리"),inputBindings:{item:b("expired","item")}},{...message("eligible","{{item.batch}}: 출고 검토"),inputBindings:{item:b("expired","item")}},out()],[["input","expired"],["expired","hold","yes"],["expired","eligible","no"],["hold","output"],["eligible","output"]])}}),out()
  ],[["input","parse"],["parse","inspect"],["inspect","output"]]),[],[
    {name:"지난 배치와 당일 배치 구별",input:'[{"batch":"A","daysLeft":-1},{"batch":"B","daysLeft":0}]',status:"succeeded",contains:["A: 격리","B: 출고 검토"],outputs:{inspect:{count:2}}},
    {name:"목록이 아닌 객체 거절",input:'{"batch":"A","daysLeft":1}',status:"failed"}
  ]),
  design("grant-evidence","증빙 검색과 인용 누락 검토","검색 근거가 없으면 답변 생성을 건너뛰고 보완을 요청한다. 근거가 있으면 답변을 생성하고 인용 표기를 검사해 누락 시 사람에게 넘긴다.",graph([
    n("input","input","확인할 사업 주장"),n("search","retrieval","증빙 검색",{retrieval:{mode:"lexical",resourceIds:[grant.id],topK:2,chunkSize:400}}),n("evidence","condition","근거 존재",{predicate:{path:"count",operator:"gt",value:0},inputBindings:{text:b("search"),count:b("search","count"),question:b("input")}}),ai("answer","사업 주장에 대해 검색 근거만 사용하고 [근거 A]를 인용하세요.",{inputBindings:{text:b("evidence","question"),context:b("evidence")}}),n("citation","evaluate","인용 표시 확인",{evaluation:{mode:"rules",rules:[{kind:"contains",value:"[근거 A]"}],rubric:"",threshold:1}}),n("valid","condition","인용 검사 통과",{predicate:{path:"passed",operator:"eq",value:true},inputBindings:{text:b("citation"),passed:b("citation","evaluation.passed")}}),out("verified"),review(),out("accepted"),message("rejected","근거 검토 거절. 주장을 확정하지 않았습니다."),out("denied"),message("missing","증빙 자료를 추가해 주세요. 근거 없이 답하지 않습니다."),out("missing_out")
  ],[["input","search"],["input","evidence"],["search","evidence"],["evidence","answer","yes"],["evidence","missing","no"],["missing","missing_out"],["answer","citation"],["citation","valid"],["valid","verified","yes"],["valid","review","no"],["review","accepted","yes"],["review","rejected","no"],["rejected","denied"]]),[grant],[
    {name:"인용된 근거 답변",input:"교육 참여자",modelReplies:[{match:"사업 주장에 대해",text:"참여자는 40명입니다. [근거 A]",inputContains:["교육 참여자","수료자는 32명"]}],status:"succeeded",contains:["40명","[근거 A]"],skipped:["review","missing"]},
    {name:"검색 근거 없음",input:"zzzzzzzz",status:"succeeded",contains:["증빙 자료를 추가"],skipped:["answer","citation"]},
    {name:"인용 누락은 검토 대기",input:"교육 참여자",modelReplies:[{match:"사업 주장에 대해",text:"참여자는 40명입니다."}],status:"waiting_review",visited:["citation","valid"]}
  ]),
  design("personal-task-dependencies","이사 작업의 준비 여부별 분류","각 작업의 ready 값을 반복 검사하여 준비된 작업과 선행 작업이 남은 항목을 다른 출력 스키마로 모은다. AI가 순서를 추측하거나 실행하지 않는다.",graph([
    n("input","input","작업 목록 JSON"),n("parse","transform","작업 목록 해석",{transform:{mode:"parse_json"},onError:"branch"}),n("tasks","loop","준비 여부별 작업 분리",{inputBindings:{items:b("parse","data")},loop:{itemsPath:"items",maxItems:20,concurrency:1,definition:graph([n("input","input","현재 작업"),n("ready","condition","선행 작업 완료",{predicate:{path:"item.ready",operator:"eq",value:true},inputBindings:{item:b("input","item")}}),n("do","transform","실행 가능 항목",{inputBindings:{item:b("ready","item")},transform:{mode:"pick",fields:{readyTask:"item.name"}}}),n("wait","transform","대기 항목",{inputBindings:{item:b("ready","item")},transform:{mode:"pick",fields:{waitingTask:"item.name",dependency:"item.dependsOn"}}}),out()],[["input","ready"],["ready","do","yes"],["ready","wait","no"],["do","output"],["wait","output"]])}}),n("collect","transform","결과와 처리 건수",{transform:{mode:"pick",fields:{items:"results",count:"count"}},inputBindings:{results:b("tasks","results"),count:b("tasks","count")}}),out(),n("invalid","error","입력 형식 오류",{error:{template:"작업 목록을 JSON 배열로 입력해 주세요: {{error.message}}"},inputBindings:{error:b("parse","error")}}),out("invalid_out")
  ],[["input","parse"],["parse","tasks","success"],["tasks","collect"],["collect","output"],["parse","invalid","error"],["invalid","invalid_out"]]),[],[
    {name:"준비와 대기 분리",input:'[{"name":"상자 구매","ready":true,"dependsOn":""},{"name":"포장","ready":false,"dependsOn":"상자 구매"}]',status:"succeeded",contains:["readyTask","waitingTask","포장"],outputs:{tasks:{count:2}},skipped:["invalid"]},
    {name:"JSON 오류 경로",input:"작업 목록",status:"succeeded",contains:["JSON 배열"],visited:["invalid"],skipped:["tasks","collect"]}
  ])
];
