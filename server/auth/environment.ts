import { env } from "cloudflare:workers";
import { parseAuthConfig } from "./config";

export function getAuthConfig() {
  return parseAuthConfig(env as unknown as Record<string, unknown>);
}
