/**
 * 개별 작성 모듈을 공개 설계 배열로 합치는 진입점이다. 빌드·예제 목록·내보내기 검증이 이 배열을 공유한다.
 * 노드/연결/자료는 내려받을 설계이며 scenarios의 응답·상태 기대값은 테스트 전용이다.
 */
import { integratedAnalyticsDesigns } from "./integrated-analytics";
import { completion035068Designs } from "./completion-035-068";
import { completion008034Designs } from "./completion-008-034";
import { completion069To100Designs } from "./completion-069-100";
import { codeDbToolDesigns } from "./code-db-tools";
import { ragLifecycleDesigns } from "./rag-lifecycle";
import { dynamicAgentDesigns } from "./dynamic-agents";
import { candidateSearchDesigns } from "./candidate-search";
import { p2DataVerificationDesigns } from "./p2-data-verification";
import { p4IntegratedDesigns } from "./p4-integrated-team";
import { dataWorkflowDesigns } from "./data";
import { collaborationWorkflowDesigns } from "./collaboration";
import { operationsWorkflowDesigns } from "./operations";
import { systemsWorkflowDesigns } from "./systems-expansion";
import { businessWorkflowDesigns } from "./business-expansion";
import { agenticExpansionWorkflowDesigns } from "./agentic-expansion";
import { reliabilityWorkflowDesigns } from "./reliability-expansion";
import { representativeCollaborationDesigns } from "./representative-collaboration";
import { representativeControlDesigns } from "./representative-control";
import { representativeRetrievalDesigns } from "./representative-retrieval";
import { integratedToolDesigns } from "./integrated-tools";
export const workflowDesigns = [...completion008034Designs, ...completion035068Designs, ...completion069To100Designs, ...integratedAnalyticsDesigns, ...codeDbToolDesigns, ...integratedToolDesigns, ...ragLifecycleDesigns, ...dynamicAgentDesigns, ...candidateSearchDesigns, ...p1CheckpointDesigns, ...p2DataVerificationDesigns, ...p4IntegratedDesigns, ...dataWorkflowDesigns, ...collaborationWorkflowDesigns, ...operationsWorkflowDesigns, ...systemsWorkflowDesigns, ...businessWorkflowDesigns, ...agenticExpansionWorkflowDesigns, ...reliabilityWorkflowDesigns, ...representativeCollaborationDesigns, ...representativeRetrievalDesigns, ...representativeControlDesigns];
import { p1CheckpointDesigns } from "./p1-checkpoint-recovery";
