// 실행 환경이 명시적으로 선택할 모델·도구 어댑터의 공개 진입점. test를 live 연결 실패의 자동 대체로 사용하지 않는다.
export { TestModelAdapter, createTestToolCaller } from "./test";
export { OpenAIModelAdapter } from "./openai";
export { createMcpToolCaller, type McpConnection } from "./mcp";
