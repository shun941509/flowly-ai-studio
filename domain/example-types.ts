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
