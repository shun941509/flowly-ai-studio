import { getChatGPTUser, chatGPTSignInPath } from "./chatgpt-auth";
import { Login } from "./ui/login";
import { getAuthConfig } from "../server/auth/environment";
import { authDisplay } from "../server/auth/config";
export const dynamic="force-dynamic";
export default async function Page(){const user=await getChatGPTUser();return <Login user={user} signInUrl={chatGPTSignInPath("/studio")} auth={authDisplay(getAuthConfig())}/>;}
