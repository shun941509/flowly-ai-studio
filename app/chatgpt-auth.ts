/** 기존 화면이 쓰는 인증 함수 이름을 유지하는 호환 계층. 실제 신원 검증은 서버가 선택한 test/OIDC/Sites 어댑터에 위임한다. */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuthConfig } from "../server/auth/environment";
import { authenticateHeaders, type AuthUser } from "../server/auth/session";
import { safeReturnPath } from "../server/auth/config";

// Compatibility facade: existing workspace/resource routes keep their verified-user boundary.
export type ChatGPTUser = AuthUser;
/** 요청 헤더를 인증 어댑터에 전달한다. 헤더에 적힌 사용자 ID 자체를 신뢰하는 함수가 아니다. */
export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  return authenticateHeaders(getAuthConfig(), new Headers(await headers()));
}
/** 보호된 페이지 진입점: 검증된 사용자를 반환하거나 안전한 내부 경로를 담아 로그인으로 이동한다. */
export async function requireChatGPTUser(returnTo: string): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (user) return user;
  redirect(chatGPTSignInPath(returnTo));
}
export function chatGPTSignInPath(returnTo: string): string {
  return `/api/auth/signin?return_to=${encodeURIComponent(safeReturnPath(returnTo))}`;
}
export function chatGPTSignOutPath(returnTo = "/"): string {
  return `/api/auth/signout?return_to=${encodeURIComponent(safeReturnPath(returnTo))}`;
}
