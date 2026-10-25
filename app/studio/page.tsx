import { requireChatGPTUser, chatGPTSignOutPath } from "../chatgpt-auth";
import { Studio } from "../ui/studio";
export const dynamic="force-dynamic";
export default async function StudioPage(){const user=await requireChatGPTUser("/studio");return <Studio user={user} signOutUrl={chatGPTSignOutPath("/")}/>;}
