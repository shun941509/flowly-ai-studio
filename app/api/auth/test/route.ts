import { getAuthConfig } from "../../../../server/auth/environment";
import { testLogin, testLoginPage } from "../../../../server/auth/http";

export const dynamic = "force-dynamic";
export function GET(request: Request) { return testLoginPage(getAuthConfig(), request); }
export function POST(request: Request) { return testLogin(getAuthConfig(), request); }
