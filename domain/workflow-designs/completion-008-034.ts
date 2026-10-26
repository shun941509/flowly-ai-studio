/**
 * 008~034 범위의 작성 모듈을 합치는 목록이다. 배열 등록만으로 검증 완료가 되지 않으며 실제 ZIP 실행 증거는 별도로 생성한다.
 * 노드/연결/자료는 내려받을 설계이며 scenarios의 응답·상태 기대값은 테스트 전용이다.
 */
import {completionResearchDesigns} from './completion-008-034-research';
import {completionControlDesigns} from './completion-008-034-control';
import {completionServiceDesigns} from './completion-008-034-services';
import {completionStateDesigns} from './completion-008-034-state';
import {completionReasoningDesigns} from './completion-008-034-reasoning';
export const completion008034Designs=[...completionResearchDesigns,...completionControlDesigns,...completionServiceDesigns,...completionStateDesigns,...completionReasoningDesigns].sort((a,b)=>a.id.localeCompare(b.id));
