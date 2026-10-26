import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TOOL_CANDIDATES, getToolCandidate } from '../domain/tool-catalog';
import { PythonToolPicker } from '../app/ui/python-tools';

test('source support audit covers current 195 registered candidates and is reproducible without executing algorithms', () => {
  assert.equal(TOOL_CANDIDATES.length, 195);
  for (const tool of TOOL_CANDIDATES) {
    assert.equal(tool.support?.verification, 'source_audited', tool.id);
    assert.ok(tool.support.outputFields.length > 0, tool.id);
    assert.match(tool.support.sourceFingerprint, /^[a-f0-9]{64}$/);
    assert.ok(tool.support.outputDescription.length > 8 && tool.support.limitation.length > 8, tool.id);
  }
  const check = spawnSync(process.env.FLOWLY_PYTHON ?? 'python', ['scripts/audit-python-tool-support.py', '--check'], {encoding:'utf8'});
  assert.equal(check.status, 0, check.error?.message ?? (check.stderr || check.stdout));
  assert.match(check.stdout, /algorithm executions: 0; external API calls: 0/);
});

test('broad tool names retain actual limited outputs and shared algorithm declarations', () => {
  assert.deepEqual(getToolCandidate('hybrid_search')?.support?.outputFields, ['results']);
  assert.deepEqual(getToolCandidate('classification')?.support?.sharedImplementationIds, ['logistic_regression']);
  assert.deepEqual(getToolCandidate('computer_use')?.support?.sharedImplementationIds, ['rpa']);
  assert.match(getToolCandidate('object_detection')!.support!.limitation, /의미 클래스/);
  assert.match(getToolCandidate('model_drift')!.support!.limitation, /정답률.*직접 측정하지/);
  assert.match(getToolCandidate('ann')!.support!.limitation, /근사 검색이 아닙니다/);
});

test('tool help exposes result contract and limitation without reporting installation or live-model success', () => {
  const html = renderToStaticMarkup(createElement(PythonToolPicker, {value:'computer_use',onChange(){}}));
  assert.match(html, /받을 결과/); assert.match(html,/현재 지원 범위/); assert.match(html,/네트워크를 끈 격리 HTML/);
  assert.match(html,/observations, mode, networkAllowed, externalApplicationAccess/);
  assert.match(html,/실행 성공이나 모델 품질 검증 결과가 아닙니다/);
});
