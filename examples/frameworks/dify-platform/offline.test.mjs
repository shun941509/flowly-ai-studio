import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { runTicket, parseResult, validateBase } from './client.mjs';

test('OFFLINE: DSL 시작·모델·출력 연결과 두 API 클라이언트의 실제 로컬 HTTP 계약', async () => {
  const dsl = JSON.parse(readFileSync(new URL('./workflow.yml', import.meta.url), 'utf8'));
  assert.equal(dsl.kind, 'app'); assert.equal(dsl.app.mode, 'workflow');
  assert.deepEqual(dsl.workflow.graph.nodes.map(n => n.data.type), ['start', 'llm', 'end']);
  assert.equal(dsl.workflow.graph.edges.length, 2);
  const received = [];
  const result = { category: 'billing', urgency: 'normal', summary: '영수증 다운로드 실패 문의' };
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ workflow_run_id: 'offline-run', data: { status: 'succeeded', outputs: { result: JSON.stringify(result) } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    assert.deepEqual((await runTicket('영수증 다운로드 오류', { base, key: 'offline-fixture-key', user: 'offline-user' })).result, result);
    const code = "import json; from client import run_ticket; print(json.dumps(run_ticket('receipt error', {'base': '" + base + "', 'key':'offline-fixture-key','user':'offline-user'})))";
    const python = spawn('python', ['-X', 'utf8', '-c', code], { cwd: new URL('.', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; python.stdout.on('data', b => stdout += b); python.stderr.on('data', b => stderr += b);
    const exit = await new Promise((resolve, reject) => { python.on('error', reject); python.on('close', resolve); });
    assert.equal(exit, 0, stderr); assert.deepEqual(JSON.parse(stdout).result, result);
    assert.equal(received.length, 2);
    for (const request of received) { assert.equal(request.path, '/v1/workflows/run'); assert.equal(request.auth, 'Bearer offline-fixture-key'); assert.equal(request.body.response_mode, 'blocking'); assert.equal(request.body.user, 'offline-user'); }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('실패 상태·잘못된 출력·평문 원격 주소를 거절한다', () => {
  assert.throws(() => parseResult({ data: { status: 'failed', outputs: { result: {} } } }));
  assert.throws(() => parseResult({ data: { status: 'succeeded', outputs: { result: { category: 'invented' } } } }));
  assert.throws(() => validateBase('http://example.com/v1'));
  assert.throws(() => validateBase('https://user:password@example.com/v1'));
});
