import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Modal, FilePicker } from '../app/ui/common';
import { SearchableMultiSelect } from '../app/ui/searchable-multi-select';
import { reconcileTextDraft } from '../app/ui/control-fields';
import { ResourceNodeSettings } from '../app/ui/resource-node-settings';
import { blockGuides, blockGuideMarkdown } from '../domain/workflow-guide';
import { inspectorTabForMessage } from '../app/ui/editor-composition-context';
import { nodeNames, type FlowNode, type Resource } from '../app/lib/model';

test('unapplied JSON survives unrelated saved changes, but clean or applied drafts follow undo', () => {
  const unfinished = { base: '{"x":1}', text: '{"x":' };
  assert.equal(reconcileTextDraft(unfinished, '{"x":2}'), unfinished);
  assert.deepEqual(reconcileTextDraft({ base: 'one', text: 'one' }, 'two'), { base: 'two', text: 'two' });
  assert.deepEqual(reconcileTextDraft({ base: 'one', text: 'two' }, 'two'), { base: 'two', text: 'two' });
  assert.deepEqual(reconcileTextDraft({ base: 'two', text: 'two' }, 'one'), { base: 'one', text: 'one' });
});

test('modal size contract preserves old wide callers and provides separate example/compare sizes', () => {
  for (const size of ['confirm','standard','editor','guide','example','compare'] as const) {
    const props = { size, title: '창', onClose() {}, children: createElement('div', {className:'modal-body'}, '내용') };
    const html = renderToStaticMarkup(createElement(Modal, props));
    assert.match(html, new RegExp(`modal-size-${size}`)); assert.match(html, /role="dialog"/);
  }
  const oldProps = {wide:true,title:'기존 창',onClose(){},children:'내용'};
  assert.match(renderToStaticMarkup(createElement(Modal, oldProps)), /modal-size-editor/);
});

test('multi-selection exposes unavailable selections and preserves deselection at the limit', () => {
  const value = ['a','missing'];
  const html = renderToStaticMarkup(createElement(SearchableMultiSelect, {label:'도구',options:[{id:'a',label:'사용 중'},{id:'b',label:'새 도구'}],value,maxSelected:2,onChange(){}}));
  assert.ok(html.includes("2 / 2")); assert.match(html,/missing/); assert.match(html,/삭제 또는 권한 변경/);
  assert.match(html, /type="checkbox" checked=""/); assert.match(html,/type="checkbox" disabled=""/);
  assert.deepEqual(value,['a','missing']);
});

test('file picker retains native keyboard selection and displays exact file byte size', () => {
  const html = renderToStaticMarkup(createElement(FilePicker,{label:'수정본',accept:'.zip,.json',files:[{name:'긴 한글 파일.zip',size:12345}],error:'크기 확인',onFiles(){}}));
  assert.match(html,/type="file"/); assert.match(html,/파일 선택/); assert.match(html,/긴 한글 파일.zip/); assert.match(html,/12,345 bytes/); assert.match(html,/role="alert"/);
});

test('every registered block has a shared input/output guide and unsupported scopes remain explicit', () => {
  assert.deepEqual(new Set(blockGuides.map(item=>item.type)),new Set(Object.keys(nodeNames)));
  for(const item of blockGuides)for(const key of ['meaning','when','input','output','where','example','difference','support'] as const)assert.ok(item[key].length,item.type+':'+key);
  const markdown=blockGuideMarkdown(); assert.match(markdown,/정수 합계/); assert.match(markdown,/승인 대상/); assert.match(markdown,/OS|임의 코드/);
  assert.equal(inspectorTabForMessage('입력 매핑 경로를 확인하세요.'),'io');
  assert.equal(inspectorTabForMessage('MCP 자료를 확인하세요.'),'materials');
  assert.equal(inspectorTabForMessage('오류 경로를 연결하세요.'),'advanced');
});

test('packaged executable Skill remains instruction-only until an execution is explicitly selected', () => {
  const resource:Resource={id:'skill',name:'계산',type:'skill',description:'지침',content:'절차',url:'',ownerId:'alice',visibility:'private',allowedEmails:[],createdAt:'',updatedAt:'',details:{version:1,skill:{kind:'executable',executions:[{id:'compute',language:'python',entryFileId:'file',inputSchema:{type:'object'},outputSchema:{type:'object'},dependencies:[],timeoutMs:1000,maxOutputBytes:1000,effect:'read'}]}}};
  const node:FlowNode={id:'node',type:'skill',title:'지침',x:0,y:0,resourceId:'skill'};
  const html=renderToStaticMarkup(createElement(ResourceNodeSettings,{node,resources:[resource],onChange(){}}));
  assert.match(html,/value="" selected=""/); assert.match(html,/실행하지 않음/); assert.doesNotMatch(html,/코드 실행 고정 입력/); assert.equal(node.skillExecution,undefined);
  const selected=renderToStaticMarkup(createElement(ResourceNodeSettings,{node:{...node,skillExecution:{entryId:'compute',arguments:{},bindings:{}}},resources:[resource],onChange(){}}));
  assert.match(selected,/모든 Skill 코드는 실행 전에 승인/); assert.match(selected,/코드 실행 고정 입력/);
});
