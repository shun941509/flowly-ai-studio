/**
 * 첫 접속 로그인 페이지. 매 요청의 검증된 세션과 공개 가능한 인증 표시 설정만 Login에 전달한다.
 */
import { getChatGPTUser, chatGPTSignInPath } from "./chatgpt-auth";
import { Login } from "./ui/login";
import { getAuthConfig } from "../server/auth/environment";
import { authDisplay } from "../server/auth/config";
export const dynamic="force-dynamic";
export default async function Page(){const user=await getChatGPTUser();return <Login user={user} signInUrl={chatGPTSignInPath("/studio")} auth={authDisplay(getAuthConfig())}/>;}
