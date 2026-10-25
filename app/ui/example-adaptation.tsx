import type { Resource, Workflow } from "../lib/model";
import { allNodes } from "../../domain/advanced-config";
import { workStyleLabels, workflowWorkStyles } from "../../domain/work-styles";

export function ExampleAdaptation({workflow,resources}:{workflow:Workflow;resources:Resource[]}) {
  const nodes=allNodes(workflow.definition),agents=nodes.filter(node=>node.type==="agent"),forms=nodes.filter(node=>node.type==="form"),tools=nodes.filter(node=>node.allowedTools?.length);
  return <section className="catalog-adaptation"><h3>내 작업에 맞게 바꾸기</h3><div className="catalog-frameworks">{workflowWorkStyles(workflow.definition).map(style=><span key={style}>{workStyleLabels[style]}</span>)}</div><p>‘내 워크플로로 만들기’로 사본을 만든 뒤 목표·입력·역할·자료를 바꿀 수 있어요. 하위 작업도 시각 편집기로 열어 구성하세요. 이름을 바꾸는 것만으로 실제 도구나 계산 방식이 달라지지는 않아요.</p>
    <ol><li><strong>요청과 완료 조건</strong><p>무엇을 만들지 정하고 아래 완료 기준을 내 목적에 맞게 확인하세요. 조건·평가·사람 검토 블록에서 완료와 보류 경로를 구분해요.</p></li>
      <li><strong>입력</strong><p>{forms.length?forms.map(node=>`${node.title}: ${(node.form?.fields??[]).map(field=>`${field.label}(${field.key})`).join(", ")}`).join(" / "):"사용자 입력 블록에 전달할 질문이나 요청을 준비하세요."}</p></li>
      <li><strong>Agent 역할 {agents.length}개</strong><p>{agents.length?agents.map(node=>node.title).join(" · "):"보조 흐름이에요. 실제 Agent를 포함하면 Agent 다운로드를 사용할 수 있어요."}</p><p>각 Agent의 작업 지침·허용 도구·출력 형식을 바꾸고 다음 블록의 입력 연결을 확인하세요.</p></li>
      <li><strong>자료와 도구</strong><p>{resources.length?resources.map(resource=>`${resource.name} (${resource.type})`).join(" · "):"연결된 자료가 없어요. 필요한 자료를 도구 및 자료에서 등록한 뒤 선택하세요."}</p>{tools.length>0&&<p>연결을 바꿀 블록: {tools.map(node=>node.title).join(" · ")}. 새 도구의 입력·출력 항목이 다르면 매핑도 수정해야 해요.</p>}</li>
      <li><strong>실행 전 확인</strong><p>편집기 오류 안내와 내보내기 점검을 확인하세요. 프로그램 블록은 등록된 연산만 실행하며 회사 서비스나 임의 코드가 자동 생성되지는 않아요. 실제 키·주소·토큰은 내려받은 폴더의 .env에 직접 설정해요.</p></li></ol>
  </section>;
}
