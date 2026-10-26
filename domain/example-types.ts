/**
 * 예제 카탈로그의 메타데이터와 분류에 쓰는 공유 타입 및 목표 수.
 * 목표 값은 기획 기준이며 실제 작성·게시·검증 완료 개수는 생성 자료와 감사 결과에서 계산한다.
 */
import type { Resource, Workflow, NodeType } from "../app/lib/model";

export type FrameworkVariant = {
  id: string; framework: string; language: string; kind: "native" | "platform";
  projectId: string; title: string; description: string; entrypoint: string;
  verification: { static: boolean; offline: boolean; live: boolean };
};
export type ExampleSummary = {
  kind?: "workflow" | "case";
  hasAgent?: boolean; classification?: "agent" | "supporting";
  workStyles?: string[];
  id: string; title: string; description: string; category: string;
  frameworks: string[]; tags: string[]; nodeTypes: NodeType[];
  status: "ready" | "setup_required"; uniqueBehavior: string;
  verification: { schema: boolean; node: boolean; python: boolean; live: boolean };
};
export type ExampleProject = ExampleSummary & {
  inputExample: string; expectedOutput: string; requirements: string[];
  workflow: Workflow; resources: Resource[]; variants: FrameworkVariant[];
  acceptance: string[]; failureCases: string[]; sourceLicense: string;
};
export const EXAMPLE_TARGET = 3200;
