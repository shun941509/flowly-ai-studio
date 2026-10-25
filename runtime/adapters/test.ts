import type { Json, ModelAdapter, ModelReply, RuntimeDependencies, ToolDefinition } from "../types";

/** Deliberately deterministic and explicitly labelled. Never used as a live fallback. */
export class TestModelAdapter implements ModelAdapter {
  async next({ messages, tools, signal }: Parameters<ModelAdapter["next"]>[0]): Promise<ModelReply> {
    signal.throwIfAborted();
    const observation = messages.filter(m => m.role === "tool").at(-1);
    if (observation) return { kind: "answer", text: `[테스트 결과 · 실제 AI 답변 아님]\n도구가 반환한 결과: ${observation.content}`, usageTokens: 30 };
    let input: Record<string, Json> = {};
    try { input = JSON.parse(messages[0]?.content ?? "{}").input ?? {}; } catch { /* Plain messages are supported in adapter tests. */ }
    if (tools.length) {
      const args: Record<string, Json> = {};
      for (const [key, schema] of Object.entries(tools[0].inputSchema.properties ?? {})) {
        args[key] = schema.type === "string" ? String(input.text ?? "테스트 입력") : schema.type === "number" ? 1 : schema.type === "boolean" ? true : schema.type === "array" ? [] : {};
      }
      return { kind: "tool", toolName: tools[0].name, args, callId: "test-call", usageTokens: 20 };
    }
    return { kind: "answer", text: `[테스트 결과 · 실제 AI 답변 아님]\n입력: ${JSON.stringify(input)}`, usageTokens: 30 };
  }
}
export function createTestToolCaller(onCall?: (call: { tool: ToolDefinition; args: Record<string, Json>; idempotencyKey: string }) => void): RuntimeDependencies["callTool"] {
  return async (tool, args, { signal, idempotencyKey }) => {
    signal.throwIfAborted();
    if (!tool.connectionId.startsWith("test-")) throw new Error("테스트 연결만 사용할 수 있어요.");
    onCall?.({ tool: structuredClone(tool), args: structuredClone(args), idempotencyKey });
    return { mode: "test", externalCall: false, action: tool.effect === "write" ? "가상 변경 기록" : "가상 자료 조회", input: args, text: `테스트 자료: ${String(args.query ?? args.text ?? args.content ?? JSON.stringify(args))}` };
  };
}
