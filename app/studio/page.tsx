/**
 * 실제 워크스페이스의 서버 진입점. requireChatGPTUser가 세션을 검사한 뒤 클라이언트 Studio를 렌더링한다.
 */
import { requireChatGPTUser, chatGPTSignOutPath } from "../chatgpt-auth";
import { Studio } from "../ui/studio";
export const dynamic="force-dynamic";
export default async function StudioPage(){const user=await requireChatGPTUser("/studio");return <Studio user={user} signOutUrl={chatGPTSignOutPath("/")}/>;}
