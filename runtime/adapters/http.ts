import { RuntimeFault } from "../policy";

/** Bounded body reader: no provider error body is ever returned to callers/logs. */
export async function readBody(response: Response, maxBytes = 400000): Promise<string> {
  if (!response.body) throw new RuntimeFault("failed", "외부 서비스 응답이 비어 있어요.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder(); let bytes = 0; let body = "";
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new RuntimeFault("failed", "외부 서비스 응답이 허용 크기를 넘었어요.");
      body += decoder.decode(chunk.value, { stream: true });
    }
    return body + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}
export function safeEndpoint(endpoint: string): string {
  let url: URL;
  try {
    if (typeof endpoint !== "string" || !/^https?:\/\//i.test(endpoint) || /[\s\x00-\x1f\x7f\\]/u.test(endpoint)) throw new Error();
    url = new URL(endpoint);
  } catch { throw new RuntimeFault("failed", "연결 주소가 올바르지 않아요."); }
  // Internal DNS names, private IPs and custom ports are valid deployment choices.
  // Network access is controlled by the execution environment, not a host allowlist.
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || endpoint.split("/")[2]?.includes("@") || url.search || url.hash || url.port === "0") throw new RuntimeFault("failed", "인증 정보·쿼리·프래그먼트가 없는 HTTP 또는 HTTPS 연결 주소가 필요해요.");
  return url.href;
}
