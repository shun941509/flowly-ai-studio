import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Definition } from '../app/lib/model';
import { initialCanvasView, readCanvasView, NodeInspector } from '../app/ui/canvas';
import { readPanelLayout, Workbench } from '../app/ui/workbench';

const graph = (): Definition => ({ schemaVersion: 5, nodes: [
  { id: 'start', type: 'input', title: '입력', x: 100, y: 100 },
  { id: 'agent', type: 'agent', title: '검토', x: 100, y: 300 },
  { id: 'end', type: 'output', title: '결과', x: 100, y: 500 },
], edges: [{ id: 'a', source: 'start', target: 'agent' }, { id: 'b', source: 'agent', target: 'end' }] });

test('large examples open at a readable scale around their entry without changing positions', () => {
  const definition = graph();
  definition.nodes[0].x = 2400;
  definition.nodes[0].y = 1800;
  definition.nodes[1].x = -2400;
  definition.nodes[2].y = 6000;
  definition.nodes.reverse();
  const before = structuredClone(definition), view = initialCanvasView(definition, 540, 480);
  const entry = definition.nodes.find(node => node.id === 'start')!;
  assert.ok(view.zoom >= .65);
  assert.equal(view.x + (entry.x + 119) * view.zoom, 270);
  assert.equal(view.y + entry.y * view.zoom, 100);
  assert.deepEqual(definition, before);
});

test('small examples initially fit and stored zoom/pan are validated without resetting them', () => {
  const view = initialCanvasView(graph(), 900, 850);
  assert.equal(view.zoom, 1);
  for (const node of graph().nodes) {
    assert.ok(view.x + node.x >= 0 && view.x + node.x + 238 <= 900);
    assert.ok(view.y + node.y >= 0 && view.y + node.y + 112 <= 850);
  }
  const saved = { x: -1200.5, y: 450.25, zoom: .37 };
  assert.deepEqual(readCanvasView(JSON.stringify(saved)), saved);
  for (const invalid of [null, 'null', '[]', '{}', '{broken', '{"x":0,"y":0,"zoom":0}', '{"x":"0","y":0,"zoom":1}', '{"x":0,"y":0,"zoom":5}']) assert.equal(readCanvasView(invalid), undefined);
});

test('saved pane sizes apply only to the same visible panel set', () => {
  const layout = { palette: 23, canvas: 45, inspector: 32 }, text = JSON.stringify(layout);
  assert.deepEqual(readPanelLayout(text, ['palette', 'canvas', 'inspector']), layout);
  assert.equal(readPanelLayout(text, ['canvas', 'inspector']), undefined);
  for (const invalid of ['null', '[]', '{broken', '{"canvas":50,"inspector":20}', '{"canvas":-10,"inspector":110}', '{"other":50,"inspector":50}', '{"canvas":"50","inspector":50}']) assert.equal(readPanelLayout(invalid, ['canvas', 'inspector']), undefined);
  assert.deepEqual(readPanelLayout('{"canvas":100}', ['canvas']), { canvas: 100 });
});

test('read-only workbench has canvas and inspector without reserving a palette panel', () => {
  const html = renderToStaticMarkup(createElement(Workbench, {
    storageKey: 'test:main', palette: false, inspector: createElement('aside', null, '설정'),
  }, createElement('main', null, '설계')));
  assert.doesNotMatch(html, /palette-panel|블록 목록 접기/);
  assert.match(html, /canvas-panel/);
  assert.match(html, /inspector-panel/);
  assert.match(html, /설정 패널 너비 조절/);
});

test('simultaneous main and nested workbenches have distinct accessible panel IDs', () => {
  const pane = () => createElement(Workbench, { storageKey: 'test:nested', inspector: createElement('aside', null, '설정') }, createElement('main', null, '설계'));
  const html = renderToStaticMarkup(createElement('div', null, pane(), pane()));
  const ids = [...html.matchAll(/data-panel="true"[^>]*id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, 4);
  assert.equal(new Set(ids).size, 4);
});

test('read-only inspector keeps guide and close outside its disabled fieldset', () => {
  const definition = graph(), noop = () => {};
  const html = renderToStaticMarkup(createElement(NodeInspector, {
    node: definition.nodes[1], resources: [], definition, workflows: [], workflowId: 'test', readOnly: true,
    onChange: noop, onDelete: noop, onDuplicate: noop, onClose: noop, onSettings: noop,
  }));
  const fieldset = html.indexOf('<fieldset class="inspector-fields" disabled=""');
  assert.ok(fieldset > 0);
  assert.ok(html.indexOf('설정 닫기') < fieldset);
  assert.ok(html.indexOf('guide-help') > 0 && html.indexOf('guide-help') < fieldset);
  assert.match(html, /조회 전용 설계/);
  assert.match(html, /button disabled=""[^>]*>[\s\S]*?복제/);
});
