/**
 * 화면 도움말과 내보낸 문서가 공유하는 용어 설명 및 그래프 기반 작업 순서 안내.
 * 설계와 정해진 규칙으로 문장을 만들며 모델 호출이나 실제 실행 결과를 만들지 않는다.
 */
import { nodeDescriptions, nodeNames, type Definition, type FlowNode, type NodeType } from '../app/lib/model';
import { childDefinitions, nodeRoutes } from './advanced-config';
import { effectiveBindings } from './data-contract';

export type GuideTerm={id:string;name:string;meaning:string;when:string;where:string;example:string;difference:string;support:string};
const term=(id:string,name:string,meaning:string,when:string,where:string,example:string,difference:string,support:string):GuideTerm=>({id,name,meaning,when,where,example,difference,support});
const special:GuideTerm[]=[
 term('workflow','워크플로','사람이 일하는 순서와 값 전달을 블록과 선으로 표현한 설계입니다.','여러 작업·조건·사람 확인을 한 흐름으로 묶을 때','워크플로 만들기','요청 → 조사 → 검토 → 결과','화면의 위치보다 선과 분기 설정이 실제 순서를 정합니다.','상위 그래프는 순환 없는 구조입니다. 반복은 반복·작업 조정 블록 안에서 한도를 정합니다.'),
 term('connection','연결된 서비스','MCP 도구를 제공하는 서버와 도구 목록의 정의입니다.','사내 프로그램과 연결할 때','도구 및 자료 → MCP, 로컬 실행 환경 → 연결 설정','검색 서비스 주소 환경 변수와 도구 이름 등록','공개 연결 정의와 실제 인증 자격 증명은 분리됩니다.','웹에 키·토큰을 입력하지 않습니다. 주소와 인증은 내려받은 실행 환경에 등록합니다.'),
 term('modes','미리보기·실행 프로젝트','미리보기는 설계 점검이고 실행 프로젝트는 내려받아 실제 작업하는 프로그램입니다.','구조 확인과 실제 실행을 구분할 때','편집기 미리보기·실행 프로젝트 내보내기','미리보기로 연결 검사 후 로컬에서 실제 모델 실행','미리보기의 성공은 실제 AI 작업 성공을 뜻하지 않습니다.','웹 모델 호출은 차단됩니다. 실서비스가 없는 테스트는 테스트 응답이라고 구분합니다.'),
 term('limits','실행 한도','모델 판단·도구 사용·토큰·활성 시간을 제한하는 설정입니다.','무한 반복이나 예상 밖의 사용량을 막을 때','Agent의 고급 설정·내보낸 실행기','도구 최대 3회, 모델 판단 최대 5회','대기 시간과 실제 작업 시간은 다릅니다.','전체 실행 한도와 Agent 한도를 함께 적용합니다. 한도 초과를 성공으로 표시하지 않습니다.'),
 term('sharing','공유 범위와 소유권','설계를 누가 보고 수정할지 정하는 권한입니다.','다른 사용자와 설계를 함께 사용할 때','내 워크플로 → 공유 설정, 공유 워크플로','팀원은 수정, 전체 로그인 사용자는 읽기','워크플로 공유와 MCP·Skill·Prompt·Document 권한은 별도입니다.','전체 수정은 금지됩니다. 수정자는 읽을 수 있고 삭제·권한 변경은 소유자만 할 수 있습니다. 이미 받은 오프라인 사본은 원격 회수되지 않습니다.'),
 term('agent','Agent','목표를 받고 허용된 도구와 관찰한 결과를 바탕으로 다음 행동을 정하는 AI입니다.','한 번 답하는 대신 자료 확인과 후속 행동이 필요할 때','Agent 블록의 작업 목표·허용 도구·실행 한도','규정 검색 → 근거 확인 → 답변','AI 답변 생성은 한 번 답하고, Agent는 한도 안에서 도구 사용을 반복할 수 있습니다.','실제 모델과 도구는 내려받은 실행기에서 사용합니다. 웹은 설계와 미리보기만 제공합니다.'),
 term('mcp','MCP','외부 프로그램의 도구를 정해진 형식으로 연결하는 방법입니다.','사내 검색·조회·등록 서비스를 사용할 때','도구 및 자료의 MCP 정의, 내려받은 환경의 .env','문서 검색 도구에 query를 보내 관련 문서를 받기','MCP 정의 공유는 사용자의 서비스 인증 정보 공유가 아닙니다.','Agent 허용 도구 또는 도구 실행 블록에서 선택합니다. 실제 주소와 토큰은 사용자 PC에 등록합니다.'),
 term('skill','Skill','작업 절차·참고 파일·선택적인 코드를 묶어 재사용하는 자료입니다.','같은 작업 방법을 반복하거나 검증 코드를 함께 전달할 때','도구 및 자료 → Skill의 지침 / 파일 패키지 / 명시적 실행 설정, 블록의 자료·도구 탭','작성 규칙과 참고 양식을 묶고, 필요할 때만 validate.py 실행 정의 선택','Prompt는 특정 요청이고 Skill은 재사용할 방법·파일의 묶음입니다. 본문은 SKILL.md 정본이며 같은 이름의 파일을 따로 첨부하지 않습니다.','지침형·패키지형·실행형을 구분합니다. 실행형이라도 블록에서 실행 ID를 선택하기 전에는 코드가 실행되지 않습니다. .py·.mjs만 지원하고 모든 코드 실행은 승인 대상입니다. 웹에서 실행하거나 외부 AI에 자동 설치하지 않습니다.'),
 term('prompt','Prompt','AI에 전달할 목표·역할·요청과 답변 조건이며, 필요한 값을 변수로 받을 수 있습니다.','작업 범위·결과 형식과 반복 사용할 입력을 정할 때','도구 및 자료 → Prompt 변수 설정, 자료 블록 → 변수 값·앞 단계 연결','{{question}}을 등록하고 data.question을 연결해 질문 넣기','자료는 근거이고 Prompt는 그 근거로 무엇을 할지 정하는 지시입니다. 변수 치환은 코드 실행이나 AI 호출이 아닙니다.','단일 {{이름}}만 치환하며 앞 단계 연결 → 직접 값 → 기본값 순서입니다. 필수·자료형·미선언 변수를 검사하고 선택 변수 누락은 빈 문자열로 처리합니다. 중첩 치환·표현식 실행은 하지 않습니다. 모델 호출은 내보낸 실행 환경에서 수행합니다.'),
 term('document','Document','검색하거나 답변의 근거로 사용할 본문·원본 파일·출처 정보입니다.','문서의 내용과 원본을 함께 관리하고 싶을 때','도구 및 자료 → Document의 본문·원본·추출 상태, 워크플로의 문서 처리·지식 관리 블록','매뉴얼 원본을 첨부하고 추출한 본문을 등록한 뒤 로컬 검색 색인 만들기','원본 업로드·텍스트 추출·검색 색인 생성은 각각 별도 작업입니다. Skill은 작업 절차이고 Document는 근거입니다.','첨부했다고 자동 추출·색인 완료가 되지 않습니다. 추출은 미요청·로컬 처리 대기·제공됨·실패로 구분하고 로컬 색인 상태도 별도로 관리합니다. 자료 권한과 워크플로 공유는 독립입니다.'),
 term('resource-files','자료 파일과 버전','자료에 첨부된 코드·참고 문서·원본과 저장 시점별 내용을 관리합니다.','다른 사람이 받을 파일과 변경 이력을 확인할 때','도구 및 자료 → 파일·버전 이력, 블록의 자료 본문 확인','매뉴얼 v2를 저장한 뒤 현재 자료를 내보내기','현재 자료 조회와 과거 버전 열람은 권한 범위가 다릅니다. 워크플로의 예전 사본이 자료 권한을 복구하지 않습니다.','파일 저장소가 미설정이면 업로드·다운로드가 미설정으로 표시됩니다. 서버는 현재 자료 권한을 검사하고 이전 버전은 소유자만 열람합니다. 권한 철회는 이미 내려받은 오프라인 파일을 원격 삭제하지 않습니다.'),
 term('skill-runtime','Skill 실행 환경','선택한 Skill 코드가 사용자 PC에서 실행되는 환경과 한도입니다.','내보낸 프로젝트에서 .py·.mjs 코드를 실행할 때','Skill 실행 정의·사용자 PC의 환경 확인·승인 화면','입력 JSON을 코드에 전달하고 출력 JSON을 다음 블록에 연결하기','실행 감독·시간 제한은 OS 보안 샌드박스가 아닙니다. read라고 선언해도 코드 부작용을 자동 판정하지 않으므로 항상 승인합니다.','Node.js·Python 내보내기 모두 Python 3.11 이상 감독 도우미가 필요합니다. JavaScript는 Node.js 22.13 이상과 내장·동봉 모듈만 지원합니다. Python 의존성은 사용자가 설치합니다. stdout·stderr 한도와 노드 JSON 입출력 200KB 한도는 별개입니다.'),
 term('rag','RAG','필요한 근거를 먼저 검색하고 그 내용을 AI에 전달해 답하는 구성입니다.','자료가 많거나 근거와 출처가 필요한 답변','문서 검색 → Agent 또는 AI 답변 생성 → 출력','매뉴얼에서 오류 코드 부분 검색 후 해결 방법 답변','문서 전체 전달과 달리 관련 조각을 고릅니다. 검색만으로 답변 품질이 보장되지는 않습니다.','등록 문서 단어 검색·벡터 검색과 로컬 색인 관리를 지원합니다. 벡터·웹 검색은 내보낸 환경의 모델 설정이 필요합니다.'),
 term('mapping','입출력 연결','앞 블록의 어떤 값을 다음 블록의 어느 입력으로 전달할지 정하는 연결입니다.','여러 결과 중 요약·숫자 등 필요한 값만 받을 때','블록 설정 → 입력 연결','검색 결과 text → 작성 Agent의 text','선은 실행 관계, 입력 연결은 실제로 전달할 값입니다.','필드와 형식을 검사합니다. 예시 값은 설명용이며 실제 응답이 아닙니다. 건너뛴 분기는 값을 만들지 않습니다.'),
 term('approval','승인','외부 변경의 대상과 정확한 내용을 사람이 확인하는 단계입니다.','등록·수정·삭제 같은 쓰기 도구를 실행하기 전','로컬 실행 화면 → 승인 대기','변경할 문서와 내용을 확인한 뒤 승인 또는 거절','사람 검토는 결과 검토, 도구 승인은 특정 외부 변경 허용입니다.','승인 후 같은 실행을 재개합니다. 인자가 바뀌면 다시 승인하며 이전 실행의 승인을 재사용하지 않습니다.'),
 term('resume','체크포인트와 재개','저장된 실행 상태에서 완료한 작업을 보존하며 이어가는 기능입니다.','보완 입력·승인 대기나 복구 가능한 중단 후','로컬 실행 화면 → 실행 기록 → 재개','보완 입력을 제출한 뒤 작성 단계부터 이어가기','새 실행은 처음부터 시작합니다. 설계 변경본에는 새 실행을 사용합니다.','읽기 재시도와 쓰기 재시도를 구분합니다. 외부 쓰기 결과가 불명확하면 자동 중복 실행하지 않습니다.'),
 term('export','AI 명령 프롬프트와 Agent 다운로드','설계를 Cowork·Codex나 로컬 실행 환경에 전달하는 방법입니다.','외부 AI에게 수정·검증·실행을 맡길 때','실행 프로젝트 내보내기','START_HERE.md를 먼저 읽고 설계대로 실행하도록 요청하기','프롬프트는 복사할 지시문, 다운로드는 실행기와 자료를 포함한 프로젝트입니다.','Agent 블록 없이도 다운로드할 수 있습니다. 키·토큰은 포함하지 않으며 임의 코드 수정이 자동으로 캔버스에 반영되지는 않습니다.'),
 term('schema','Schema·자료형','입출력 값의 모양과 필수 항목을 정한 약속입니다.','숫자·문장·목록을 정확히 전달할 때','입력 연결의 받을 형식·필수 입력, 고급 출력 형식','점수는 숫자, 근거는 목록으로 선언하기','출력 형식 선언은 값을 생성하는 설정이 아닙니다.','문자열·숫자·논리값·객체·목록과 필수 항목을 검사합니다. 빈 문자열과 항목 부재는 다르므로 빈 결과는 평가·조건으로 확인하세요.'),
 term('harness','Harness','Agent 실행을 감싸는 한도·도구·승인·기록·검증 장치입니다.','AI가 허용된 범위에서 일하는지 확인할 때','Agent 한도·오류 경로·검토·내보낸 실행기','도구 3회 한도와 승인·실행 기록을 적용하기','Agent는 판단을 수행하고 Harness는 실행 규칙을 관리합니다.','관찰 가능한 입력·출력·도구 호출·상태를 기록하며 내부 사고 원문을 요구하거나 저장하지 않습니다.'),
 term('cot','CoT·추론','문제를 나누어 검토하고 오류를 수정하는 모델의 문제 해결 방식입니다.','복잡한 판단을 검증 가능한 작은 작업으로 나눌 때','Agent 지침·평가·독립 검토 블록','초안 → 규칙 검사 → 독립 검토 → 수정','숨겨진 사고 원문과 공개할 근거·결정 요약은 다릅니다.','간단한 결정 설명과 결과를 기록합니다. 추론 원문이나 추론 토큰 생성량을 웹에서 보장하지 않습니다.'),
];
const examples:Partial<Record<NodeType,string>>={input:'회의 내용을 입력하기',output:'완성된 요약을 표시하기',parallel:'보안·비용 관점을 동시에 검토하기',condition:'점수가 80 이상이면 제출, 아니면 수정하기',agent_team:'작성 역할 다음에 독립 검토 역할 실행하기',orchestrator:'목표에 맞는 조사·작성 작업을 허용 목록에서 선택하기',subworkflow:'반복 사용하는 검토 절차를 하나의 블록으로 묶기',loop:'문서 목록의 각 문서를 요약하기',form:'실행 중 빠진 대상 날짜를 사용자에게 요청하기',memory:'다음 실행에서 사용할 선호 형식을 저장하기',review:'초안을 사람이 수락하거나 거절하기',tool:'정해진 query로 문서 검색 도구 한 개 호출하기',retrieval:'질문과 관련된 매뉴얼 조각을 찾기',transform:'숫자 점수를 다음 블록의 data.score로 전달하기',merge:'서로 다른 조사 결과를 하나로 모으기',evaluate:'필수 항목과 기준 점수 충족 여부 확인하기',knowledge:'문서 변경 후 새 색인 버전을 발행하기',candidate_search:'숫자 목표에 맞는 후보 계산식을 탐색·검증하기'};
export const guideTerms:GuideTerm[]=[...special,...(Object.keys(nodeNames) as NodeType[]).filter(id=>!special.some(item=>item.id===id)).map(id=>term(id,nodeNames[id],nodeDescriptions[id],`${nodeDescriptions[id].replace(/해요$/,'할 때')}`,`워크플로 만들기 → ${nodeNames[id]} 블록 설정`,examples[id]??`${nodeNames[id]}의 입력을 정하고 결과를 다음 블록에 연결하기`,id==='tool'?'도구 실행은 정해진 도구를 호출하며 Agent가 도구를 선택하는 방식과 다릅니다.':id==='parallel'?'나란히 놓는 것과 다릅니다. 병렬 작업 설정이 실제 동시 실행을 결정합니다.':'각 블록은 한 가지 역할을 맡고 입력 연결로 다른 역할과 조합합니다.',id==='candidate_search'?'현재 후보 탐색은 등록된 계산 문제의 제한된 ToT/GoT 탐색입니다. 임의 문제의 일반 추론 엔진은 아닙니다.':id==='memory'?'로컬 기억과 등록 MCP 기억을 지원합니다. 범위·보관 기간을 확인하세요.':id==='retrieval'?'등록 문서 검색과 내보낸 환경의 벡터·웹 검색을 지원합니다. RAG 안내도 확인하세요.':'설계와 검사는 웹에서, 실제 실행은 Node.js·Python 내보낸 환경에서 수행합니다. 노드별 설정·한도·추가 의존성은 내보낸 안내를 따르세요.'))];
/**
 * 블록 종류에 대응하는 공통 용어 항목을 선택한다.
 */
export const nodeGuideTerm=(node:FlowNode)=>node.type==='ai'?'prompt':node.type==='resource'?'document':node.type==='retrieval'?'rag':node.type;

/** Deterministic prose from the actual dependency graph; no model or generated execution result. */
/**
 * 선행 관계·분기·하위 작업을 바탕으로 설계의 실행 흐름을 설명한다.
 */
export function explainWorkflow(definition:Definition):string[]{
 const lines:string[]=[];
 const visit=(graph:Definition,prefix='')=>{
  const done=new Set<string>(),pending=[...graph.nodes];
  while(pending.length){const index=pending.findIndex(n=>graph.edges.filter(e=>e.target===n.id).every(e=>done.has(e.source)));const node=pending.splice(index<0?0:index,1)[0];done.add(node.id);
   const incoming=graph.edges.filter(e=>e.target===node.id),names=incoming.map(e=>{const source=graph.nodes.find(n=>n.id===e.source);const route=source&&nodeRoutes(source).find(r=>r.id===e.branch);return `${source?.title??e.source}${route?`의 ‘${route.label}’ 경로`:''}`;});
   lines.push(`${prefix}${node.title}: ${names.length?`${names.join(', ')} 이후`:'흐름 시작'}. ${nodeDescriptions[node.type]}`);
   for(const [field,binding] of Object.entries(effectiveBindings(graph,node)))lines.push(`${prefix}  ${graph.nodes.find(n=>n.id===binding.nodeId)?.title??binding.nodeId}의 ${binding.path} → ${node.title}의 ${field}.`);
   const routes=nodeRoutes(node);for(const route of routes){const targets=graph.edges.filter(e=>e.source===node.id&&e.branch===route.id).map(e=>graph.nodes.find(n=>n.id===e.target)?.title??e.target);lines.push(`${prefix}  ${route.label}: ${targets.join(', ')||'연결 필요'}.`);}
   if(node.parallel||node.team?.mode==='parallel')lines.push(`${prefix}  독립 작업을 설정한 동시 실행 수 안에서 진행하고 결과를 모읍니다.`);
   if(node.onError!=='branch'&&!['input','output'].includes(node.type))lines.push(`${prefix}  처리하지 못한 오류는 실행을 중단합니다.`);
   childDefinitions(node).forEach((child,index)=>visit(child,`${prefix}${node.title} / 하위 ${index+1} / `));
  }
 };visit(definition);return lines;
}
/**
 * 화면과 같은 용어 정보를 내려받는 프로젝트의 Markdown 설명으로 출력한다.
 */
export function guideMarkdown():string{return guideTerms.map(t=>`### ${t.name}\n\n${t.meaning}\n\n- 사용 상황: ${t.when}\n- 설정 위치: ${t.where}\n- 예시: ${t.example}\n- 차이: ${t.difference}\n- 현재 지원: ${t.support}`).join('\n\n');}

/** 블록별 입출력 설명의 공통 원본. 예시 데이터는 실제 실행 결과가 아니며 웹과 내보내기 문서가 함께 사용한다. */
export type BlockGuide = { type:NodeType; name:string; meaning:string; when:string; input:string; output:string; where:string; example:string; difference:string; support:string };
const blockContracts:Record<NodeType,[string,string,string,string]>={
 input:['사용자 질문 text','text','휴가 절차를 알려줘 → text','실행당 하나의 시작 블록입니다.'],
 form:['정의한 양식 필드','text·data','request 입력 → data.request','시작 입력과 보완 입력 대기를 구분합니다.'],
 trigger:['예약/서명된 이벤트 입력','text·data','정기 보고 요청 → 새 실행','최상위에서만 사용하며 내보낸 Python 도우미로 동작합니다.'],
 ai:['text와 연결한 자료','text·JSON 형식이면 data','검색 근거 → 요약','한 번의 답변 생성이며 Agent 도구 반복과 다릅니다.'],
 agent:['목표·text·허용 도구 결과','text·JSON 형식이면 data','검색 도구 조회 → 확인 → 답변','한도 안에서 허용한 도구만 선택합니다.'],
 output:['명시적으로 연결한 결과','선택한 최종 결과','Agent text → 사용자 답변','결과 출력은 데이터를 새로 생성하지 않습니다.'],
 resource:['자료 ID·선택 Prompt 변수 입력','자료 내용·첨부 메타데이터','Document → 다음 Agent의 근거','자료 접근권과 워크플로 공유는 별개입니다.'],
 skill:['Skill ID·선택 실행 입력','지침·선택 실행 결과','작성 규칙 → Agent 지침','명시한 실행 ID가 없으면 코드가 실행되지 않습니다. 모든 코드 실행은 승인 대상입니다.'],
 tool:['선택 도구의 고정 인자·연결 값','text·data(MCP 응답)','query → data.structuredContent','직접 지정한 도구 하나를 호출합니다. 웹에서 호출하지 않습니다.'],
 retrieval:['질문 text·선택 자료','text·문서 matches / 웹 sources','오류 코드 → 근거 조각','단어/벡터/웹 검색은 준비 환경이 다릅니다. 검색 결과만으로 정답을 보장하지 않습니다.'],
 knowledge:['문서·질문·세대/리비전 경로','text·색인 작업 결과','준비 → 평가 → 발행 → 검색','로컬 색인 상태와 웹 자료 저장 상태는 별개입니다.'],
 memory:['기억 key·선택 쓰기 값','기억 값·상태','선호 형식 저장 → 다음 실행 읽기','로컬 범위/TTL/버전 비교 또는 명시 MCP 계약을 사용합니다.'],
 transform:['text 또는 매핑한 객체','변환 모드의 text/data/선택 필드','JSON 읽기 → data.title','등록된 변환만 수행하며 임의 코드를 실행하지 않습니다.'],
 program:['고정 인자·앞 단계 경로','text·data','숫자 배열 → 합계 검산','등록 프로그램/Python 도구만 실행합니다. 도구별 패키지가 필요합니다.'],
 candidate_search:['items 배열·target','text·data.solved 및 후보 결과','양의 정수 항목 → 목표 합계 후보','현재 검증 범위는 정수 합계입니다. 범용 ToT/GoT 정답기는 아닙니다.'],
 merge:['여러 앞 단계 값','설정한 문장·목록·객체','병렬 요약 → 이름별 결과','합류 방식은 설정값이며 없는 입력은 별도로 처리해야 합니다.'],
 condition:['비교할 입력 경로 또는 text','선택 경로와 전달 값','amount >= 100 → yes/no','분기는 값 비교이며 AI 분류와 다릅니다.'],
 classify:['text·분류 기준','분류 결과·선택된 라벨 경로','요청 → 기술/일반 분류','내보낸 모델이 등록된 라벨 중 선택합니다.'],
 guardrail:['검사할 text','검사·마스킹 결과','이메일 포함 문장 → 가린 문장','규칙 탐지는 모든 민감정보를 보장하지 않습니다.'],
 evaluate:['검사할 결과·평가 기준','text·evaluation','글자 길이 확인 → evaluation.passed','규칙 평가와 모델 평가를 구분합니다.'],
 error:['오류 경로의 error·text','오류 안내 또는 지정 기본값','조회 실패 → 다음 행동 안내','오류 경로를 연결해야 합니다. 원래 실패를 성공한 외부 변경으로 바꾸지 않습니다.'],
 review:['검토할 결과','수락/거절·선택 수정 결과','초안 → 사람 확인','결과 검토이며 특정 도구 쓰기 승인을 대체하지 않습니다.'],
 file_input:['inputs/의 상대 파일명','file 메타데이터','report.pdf → file','사용자 PC 파일을 내보낸 환경에서 읽습니다.'],
 document_extract:['file 메타데이터','text·tables 등 추출 결과','PDF → 글 / CSV → 표','형식별 로컬 패키지와 OCR 환경이 필요합니다.'],
 file_output:['저장할 data/text','출력 파일 메타데이터','표 → outputs/result.csv','내보낸 환경에 파일을 만들며 웹으로 자동 전송하지 않습니다.'],
 compensate:['원래 변경의 결과·보상 인자','보상 도구 결과','적용 실패 확인 → 별도 복구 승인','보상은 새로운 승인 대상이며 트랜잭션 자동 롤백이 아닙니다.'],
 parallel:['모든 하위 작업에 보낼 입력','text·results·count','두 관점 분석 → 결과 수집','설정 동시 수와 전체 예산을 함께 적용합니다.'],
 agent_team:['역할별 입력·이전 결과','팀 결과 목록','작성 → 검토 또는 병렬 검토','순차 previous와 병렬 결과 전달을 구분합니다.'],
 orchestrator:['목표·등록 작업 틀·완료 조건','작업 산출물·완료 상태','근거 조사 → 구현 → 검사','등록된 작업과 한도 내에서 계획합니다. 임의 권한을 생성하지 않습니다.'],
 subworkflow:['하위 시작 블록에 전달할 값','하위 출력 블록의 값','공통 검증 흐름 재사용','별도 편집 복사본을 적용하며 자동으로 원본과 동기화하지 않습니다.'],
 loop:['반복할 목록 또는 상태','반복 결과 목록','문서 목록 → 각 문서 처리','반복 수·동시 실행·전체 한도를 제한합니다.']
};
export const blockGuides:BlockGuide[]=(Object.keys(nodeNames) as NodeType[]).map(type=>{const [input,output,example,support]=blockContracts[type];return {type,name:nodeNames[type],meaning:nodeDescriptions[type],when:nodeDescriptions[type],input,output,where:'워크플로 만들기 → '+nodeNames[type]+' → 기본 / 자료·도구 / 입출력 / 고급',example,difference:support,support};});
export function blockGuideMarkdown():string{return blockGuides.map(item=>'### '+item.name+'\n\n'+item.meaning+'\n\n- 입력: '+item.input+'\n- 결과: '+item.output+'\n- 예시: '+item.example+'\n- 설정: '+item.where+'\n- 지원 범위: '+item.support).join('\n\n');}
