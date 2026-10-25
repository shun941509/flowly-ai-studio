/** Authored synthetic problems. SDK/language variants are never extra projects. */
import core from './example-core.json';
import { extendedExampleSeeds } from './catalog';
import type { DataSchema } from '../runtime/types';
export type ExampleSeed = {
  id: string; title: string; category: string; pattern: 'rag' | 'team' | 'parallel' | 'agent' | 'review';
  problem: string; input: string; facts: string; output: string; rules: string[]; failures: string[];
  outputSchema?: DataSchema;
};
export const coreExampleSeeds: ExampleSeed[] = core as ExampleSeed[];
export const exampleSeeds: ExampleSeed[] = [...coreExampleSeeds, ...extendedExampleSeeds];
