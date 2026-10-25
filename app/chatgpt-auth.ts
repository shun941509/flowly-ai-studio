import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuthConfig } from "../server/auth/environment";
import { authenticateHeaders, type AuthUser } from "../server/auth/session";
import { safeReturnPath } from "../server/auth/config";

// Compatibility facade: existing workspace/resource routes keep their verified-user boundary.
export type ChatGPTUser = AuthUser;
export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  return authenticateHeaders(getAuthConfig(), new Headers(await headers()));
}
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
