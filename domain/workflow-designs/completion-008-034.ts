import {completionResearchDesigns} from './completion-008-034-research';
import {completionControlDesigns} from './completion-008-034-control';
import {completionServiceDesigns} from './completion-008-034-services';
import {completionStateDesigns} from './completion-008-034-state';
import {completionReasoningDesigns} from './completion-008-034-reasoning';
export const completion008034Designs=[...completionResearchDesigns,...completionControlDesigns,...completionServiceDesigns,...completionStateDesigns,...completionReasoningDesigns].sort((a,b)=>a.id.localeCompare(b.id));
