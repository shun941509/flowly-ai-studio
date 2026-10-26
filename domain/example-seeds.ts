/**
 * 핵심 예제와 확장 카탈로그의 작성 원본을 합치는 진입점.
 * 표시용 시드와 실제 실행 설계/검증 증거는 별도로 관리되므로 시드 수를 실행 검증 수로 보고하지 않는다.
 */
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
