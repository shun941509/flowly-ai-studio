"""Loopback-only local control panel for exported Node.js/Python workflows."""
from __future__ import annotations
import argparse
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import threading
import time

HTML = r'''<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Flowly 로컬 실행</title>
<style nonce="NONCE">:root{font:15px/1.6 system-ui,sans-serif;color:#19252d;background:#f4f6f7}*{box-sizing:border-box}body{margin:0}header{padding:22px 30px;background:#152f3b;color:white;display:flex;align-items:center;gap:18px}h1{font-size:22px;margin:0}header p{margin:0;color:#d2e3e9;font-size:13px}main{max-width:1400px;margin:auto;padding:24px;display:grid;grid-template-columns:330px 1fr;gap:20px}section{border:1px solid #d6dfe4;border-radius:14px;background:white;padding:20px;margin-bottom:18px}h2{font-size:18px;margin:0 0 14px}h3{font-size:15px;margin:10px 0}label{display:block;margin:10px 0 5px;font-weight:600}input,select,textarea,button{font:inherit}input,select,textarea{width:100%;border:1px solid #b8c8d1;border-radius:7px;padding:9px;background:white}textarea{min-height:90px;resize:vertical}button{border:1px solid #bfd0d8;border-radius:7px;padding:8px 12px;cursor:pointer;background:#f8fafb;color:#1b3c4c;margin:4px 4px 4px 0}button.primary{background:#075e78;color:white;border-color:#075e78}button.danger{color:#a52c2c}button:disabled{opacity:.5;cursor:wait}.note{font-size:13px;color:#526672}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.row>*{flex:1}.row button{flex:initial}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 ui-monospace,monospace;background:#f3f6f8;padding:12px;border-radius:7px;max-height:450px;overflow:auto}#notice{position:sticky;top:0;background:#fff8db;color:#664500;padding:8px 30px;min-height:40px}table{width:100%;border-collapse:collapse;font-size:13px}td,th{border-bottom:1px solid #e0e6e9;padding:8px;text-align:left;overflow-wrap:anywhere}#graph{width:100%;height:430px;border:1px solid #dce4e9;border-radius:8px;background:#fafcfd}#graph text{font:13px system-ui,sans-serif;fill:#203341}details summary{cursor:pointer;font-weight:650}#runList{max-height:250px;overflow:auto}#jobList{max-height:320px;overflow:auto}.tag{font-size:12px;background:#e5f0f4;padding:2px 7px;border-radius:20px}a{color:#0d6383}input[type=checkbox]{width:auto}#filter{margin-bottom:8px}@media(max-width:800px){main{display:block;padding:12px}header{padding:18px;display:block}#notice{padding:8px 18px}#graph{height:330px}section{padding:15px}}
</style><header><div><h1>Flowly 로컬 실행</h1><p>내 기기에서 실행하고 상태를 확인합니다.</p></div><span class="tag">Node.js · Python</span></header><div id="notice" role="status">연결 준비 중</div><main>
<aside><section><h2>실행 환경</h2><label for="profile">프로필</label><select id="profile"></select><label><input id="production" type="checkbox"> 선택한 운영 환경에서 실행 허용</label><p class="note">키는 이 폴더의 .env 파일에 직접 입력하세요. 이 화면에는 키를 입력하거나 표시하지 않습니다.</p><button id="check">설정 확인</button><button id="probe">실제 연결 점검</button><p class="note">실제 연결 점검은 모델 API와 MCP 도구 목록을 조회하며 사용량이 발생할 수 있습니다.</p><details><summary>프로필 등록</summary><label for="profileName">이름 (영문·숫자)</label><input id="profileName" placeholder="development"><label for="envPath">환경 파일 상대경로</label><input id="envPath" value=".env"><label><input id="newProduction" type="checkbox"> 운영 환경</label><button id="saveProfile">프로필 저장</button></details></section>
<section><h2>작업 시작</h2><label for="input">요청 또는 입력 JSON</label><textarea id="input" placeholder="실행할 내용을 입력하세요."></textarea><label for="priority">우선순위</label><select id="priority"><option value="0">보통</option><option value="10">높음</option><option value="-10">낮음</option></select><button class="primary" id="enqueue">대기열에 추가</button><div class="row"><button id="startWorker">대기열 처리 시작</button><button class="danger" id="stopWorker">진행 작업 중지</button></div><p class="note">한 번에 한 작업을 처리합니다. 승인 대기와 실패는 자동 재시도하지 않습니다. 중지한 외부 변경의 결과가 불명확하면 해당 서비스에서 확인하세요.</p><p id="worker" class="note"></p></section>
<section><h2>보관과 평가</h2><label for="dataset">평가 사례 JSON 상대경로</label><input id="dataset" placeholder="evaluations/cases.json"><button id="evaluate">사례 평가 실행</button><p class="note">사례 평가는 선택한 프로필의 실제 실행기를 사용합니다. 외부 모델·도구가 있는 흐름은 실제 호출됩니다.</p><button id="backup">실행·산출물 백업</button><label for="backupId">복원할 백업 ID</label><input id="backupId"><button id="restore">빈 대상에 복원</button><label for="retention">보관 기간 (일)</label><input id="retention" type="number" min="1" max="3650" value="30"><button class="danger" id="prune">지난 기록 정리</button><p class="note">백업은 로컬 파일이며 암호화하지 않습니다. .env는 백업하지 않습니다. 진행·승인 대기 중인 실행은 정리하지 않습니다.</p></section></aside>
<div><section><h2 id="workflowName">워크플로</h2><p class="note">아래 상태는 내보낸 실행기의 저장 기록입니다. 자동 새로고침은 모델이나 도구를 호출하지 않습니다.</p><svg id="graph" role="img" aria-label="노드별 실행 상태"></svg><label for="filter">기록 검색</label><input id="filter" placeholder="노드 이름, 상태, 오류 검색"><div id="runList"></div></section>
<section><h2>대기열과 처리 이력</h2><p class="note">재개는 새 처리 항목으로 기록됩니다. 현재 상태는 실행 보기에서 확인하세요.</p><div id="jobList"></div></section><section><h2>선택한 실행</h2><div class="row"><input id="runId" aria-label="실행 ID" placeholder="run_..."><button id="loadRun">기록 보기</button><button id="resume">이어서 실행</button><button id="estimate">비용 추정</button></div><div id="decisions"></div><pre id="runDetails">실행을 선택하세요.</pre></section>
<section><h2>작업 결과</h2><pre id="result">아직 실행한 작업이 없습니다.</pre><details><summary>고급 운영 명령</summary><p class="note">청구 비교·평가 비교·단가 설정은 README의 JSON 명령 형식을 사용합니다. 비밀 값은 넣지 마세요.</p><textarea id="advanced" aria-label="운영 명령 JSON">{"action":"profiles.list"}</textarea><button id="sendAdvanced">명령 실행</button></details></section></div></main>
<script nonce="NONCE">
'use strict';let token=new URLSearchParams(location.hash.slice(1)).get('token')||sessionStorage.getItem('flowlyLocalToken')||'';if(token){sessionStorage.setItem('flowlyLocalToken',token);history.replaceState(null,'',location.pathname)}let definition={nodes:[],edges:[]},selected=null,busy=false;const reviewDrafts=new Map(),inputDrafts=new Map();
const $=id=>document.getElementById(id),show=(v)=>{$('result').textContent=JSON.stringify(v,null,2)},notice=t=>$('notice').textContent=t;
const labels={queued:'대기',running:'실행 중',succeeded:'완료',failed:'실패',cancelled:'중지',waiting_approval:'승인 대기',waiting_review:'검토 대기',waiting_input:'추가 입력 대기',unknown_outcome:'결과 확인 필요',unconfigured:'미설정',ready:'준비됨',skipped:'건너뜀',budget_exceeded:'한도 도달',expired:'기한 만료'};
const profile=()=>$('profile').value||'development';const context=()=>({profile:profile(),...($('production').checked?{confirmProduction:true}:{})});
async function request(action,params={}){const r=await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json','X-Flowly-Token':token},body:JSON.stringify({action,...params})});const v=await r.json();if(!r.ok||v.error)throw Error(v.error||'요청에 실패했어요.');return v}
async function perform(action,params={}){if(busy)return;busy=true;notice('처리 중…');try{const v=await request(action,params);show(v);notice('작업을 마쳤습니다.');await refresh();return v}catch(e){notice(e.message)}finally{busy=false}}
const button=(text,fn)=>{const b=document.createElement('button');b.textContent=text;b.onclick=fn;return b};
function draw(){const svg=$('graph');svg.replaceChildren();const nodes=definition.nodes||[];if(!nodes.length)return;const minx=Math.min(...nodes.map(n=>n.x)),miny=Math.min(...nodes.map(n=>n.y));const x=n=>n.x-minx+20,y=n=>n.y-miny+25;svg.setAttribute('viewBox',`0 0 ${Math.max(...nodes.map(x))+210} ${Math.max(...nodes.map(y))+75}`);const ns='http://www.w3.org/2000/svg';const make=(tag,attrs)=>{const e=document.createElementNS(ns,tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,String(v));return e};const states={};for(const e of selected?.events||[]){if(e.nodeId){if(e.type==='node_started')states[e.nodeId]='running';if(e.type==='node_completed')states[e.nodeId]='succeeded';if(e.type==='node_skipped')states[e.nodeId]='skipped';if(['failed','waiting_approval','waiting_review','waiting_input','budget_exceeded','expired','cancelled','unknown_outcome'].includes(e.type))states[e.nodeId]=e.type}}if(selected&&['waiting_approval','waiting_review','waiting_input','failed','budget_exceeded','expired','cancelled','unknown_outcome'].includes(selected.status))for(const id of Object.keys(states))if(states[id]==='running')states[id]=selected.status;for(const e of definition.edges||[]){const a=nodes.find(n=>n.id===e.source),b=nodes.find(n=>n.id===e.target);if(a&&b)svg.append(make('line',{x1:x(a)+90,y1:y(a)+45,x2:x(b)+90,y2:y(b),stroke:'#9bb2bf','stroke-width':2}))}for(const n of nodes){const g=make('g',{}),state=states[n.id]||'queued';g.append(make('rect',{x:x(n),y:y(n),width:185,height:55,rx:9,fill:state==='succeeded'?'#e1f5e9':state==='failed'?'#ffe6e6':state==='running'?'#fff1bd':'#edf2f5',stroke:'#9eb3bf'}));for(const[text,dy]of [[n.title||n.type,21],[labels[state]||state,41]]){const t=make('text',{x:x(n)+10,y:y(n)+dy});t.textContent=text;g.append(t)}g.addEventListener('click',()=>{$('runDetails').textContent=JSON.stringify((selected?.events||[]).filter(e=>e.nodeId===n.id),null,2)});svg.append(g)}}
function renderRuns(runs){$('runList').replaceChildren();for(const r of runs){if(!JSON.stringify(r).toLowerCase().includes($('filter').value.toLowerCase()))continue;const row=document.createElement('div');row.append(button(`${labels[r.status]||r.status} · ${r.id}`,()=>{$('runId').value=r.id;loadRun()}));$('runList').append(row)}}
function renderJobs(jobs){$('jobList').replaceChildren();for(const j of jobs){const row=document.createElement('div'),text=document.createElement('span');text.textContent=`${j.profile} · ${labels[j.status]||j.status} · 우선순위 ${j.priority} · ${j.id} `;row.append(text);if(j.runId)row.append(button('실행 보기',()=>{$('profile').value=j.profile;$('runId').value=j.runId;loadRun()}));if(j.status==='queued')row.append(button('대기 취소',()=>perform('jobs.cancel',{jobId:j.id})));$('jobList').append(row)}}
function drawInputRequests(){
  for(const r of selected?.inputRequests||[]){
    if(r.status!=='pending')continue;
    const box=document.createElement('fieldset'),legend=document.createElement('legend'),help=document.createElement('p'),controls=new Map();
    legend.textContent='추가 입력';help.textContent=(r.instructions||'필요한 정보를 입력하세요.')+' · 만료 '+r.expiresAt;
    box.append(legend,help);const draft=inputDrafts.get(r.id)||{};
    for(const f of r.fields||[]){
      const label=document.createElement('label'),control=document.createElement(f.type==='select'||f.type==='boolean'?'select':'input');
      label.textContent=f.label+(f.required?' (필수)':'');
      if(control.tagName==='SELECT'){
        const values=f.type==='boolean'?['true','false']:f.options||[];
        for(const value of ['',...values]){const option=document.createElement('option');option.value=value;option.textContent=value===''?'선택하세요':f.type==='boolean'?(value==='true'?'예':'아니요'):value;control.append(option)}
      }else{control.type=f.type==='number'?'number':f.type==='date'?'date':'text';if(f.type==='number')control.step='any';if(f.type==='file')control.placeholder='inputs 폴더 안의 상대 경로'}
      control.required=f.required;control.value=draft[f.key]??'';control.oninput=()=>{draft[f.key]=control.value;inputDrafts.set(r.id,draft)};
      label.append(control);box.append(label);controls.set(f.key,control);
    }
    const hint=document.createElement('p');hint.className='note';hint.textContent='저장 후 이어서 실행을 누르면 같은 실행 ID에서 계속합니다. 이미 완료된 단계는 반복하지 않습니다.';box.append(hint);
    box.append(button('추가 입력 저장',async()=>{
      const values={};
      for(const f of r.fields||[]){const control=controls.get(f.key);if(!control.reportValidity())return;if(!control.value.trim()){if(f.required)return notice('필수 항목을 입력하세요.');continue}const value=f.type==='number'?Number(control.value):f.type==='boolean'?control.value==='true':control.value;if(typeof value==='number'&&!Number.isFinite(value))return notice('유효한 숫자를 입력하세요.');values[f.key]=value}
      const result=await perform('runs.submit_input',{...context(),runId:selected.id,requestId:r.id,values});if(result){inputDrafts.delete(r.id);await loadRun()}
    }));$('decisions').append(box);
  }
}
async function loadRun(){try{selected=await request('runs.status',{profile:profile(),runId:$('runId').value});$('runDetails').textContent=JSON.stringify(selected,null,2);$('decisions').replaceChildren();for(const a of selected.approvals||[]){if(a.status!=='pending')continue;const p=document.createElement('p');p.textContent=`승인 대상: ${a.toolName} · ${a.id} · 만료 ${a.expiresAt}`;$('decisions').append(p,button('외부 변경 승인',()=>perform('runs.decision',{...context(),runId:selected.id,decision:'approve',decisionId:a.id})),button('거절',()=>perform('runs.decision',{...context(),runId:selected.id,decision:'deny',decisionId:a.id})))}for(const r of selected.reviews||[]){if(r.status!=='pending')continue;const p=document.createElement('p');p.textContent=`검토: ${r.instructions||r.id}`;const edit=document.createElement('textarea');edit.placeholder='수정할 입력 JSON (선택)';edit.value=reviewDrafts.get(r.id)||'';edit.oninput=()=>reviewDrafts.set(r.id,edit.value);$('decisions').append(p);if(r.allowEdit)$('decisions').append(edit);$('decisions').append(button('검토 수락',()=>{let edited;try{if(edit.value)edited=JSON.parse(edit.value)}catch{return notice('수정 입력은 JSON 객체로 입력하세요.')}perform('runs.decision',{...context(),runId:selected.id,decision:'accept',decisionId:r.id,...(edited?{editedInput:edited}:{})})}),button('검토 거절',()=>perform('runs.decision',{...context(),runId:selected.id,decision:'reject',decisionId:r.id})))}drawInputRequests();draw()}catch(e){notice(e.message)}}
async function refresh(){try{const v=await request('local.snapshot',{profile:profile()});definition=v.definition;$('workflowName').textContent=v.name;const old=profile();$('profile').replaceChildren();for(const p of v.profiles){const o=document.createElement('option');o.value=p.name;o.textContent=p.name+(p.production?' (운영)':'');$('profile').append(o)}if(v.profiles.some(p=>p.name===old))$('profile').value=old;renderRuns(v.runs);renderJobs(v.jobs);$('worker').textContent=v.worker.running?'대기열 처리 중':'대기열 처리기가 멈춰 있습니다.';draw();if(selected&&!document.activeElement?.closest('#decisions'))await loadRun();return true}catch(e){notice(e.message);return false}}
$('check').onclick=()=>perform('check',context());$('probe').onclick=()=>perform('probe',{...context(),target:'all',confirm:true});$('saveProfile').onclick=()=>perform('profiles.set',{name:$('profileName').value,env:$('envPath').value,production:$('newProduction').checked,confirmProduction:$('newProduction').checked});$('enqueue').onclick=()=>perform('jobs.enqueue',{...context(),input:$('input').value,priority:Number($('priority').value)});$('startWorker').onclick=()=>perform('local.worker.start');$('stopWorker').onclick=()=>perform('local.worker.stop');$('loadRun').onclick=loadRun;$('resume').onclick=()=>perform('runs.resume',{...context(),runId:$('runId').value});$('estimate').onclick=()=>perform('prices.estimate',{...context(),runId:$('runId').value});$('evaluate').onclick=()=>perform('evaluate',{...context(),dataset:$('dataset').value});$('backup').onclick=()=>perform('backup',{...context(),scopes:['state','outputs','reports']});$('restore').onclick=()=>perform('restore',{...context(),backupId:$('backupId').value,confirm:true});$('prune').onclick=()=>perform('prune',{...context(),scopes:['state','outputs','reports'],olderThanDays:Number($('retention').value),confirm:true});$('sendAdvanced').onclick=()=>{try{const v=JSON.parse($('advanced').value);if(!v||typeof v!=='object')throw Error();const{action,...args}=v;perform(action,args)}catch{notice('올바른 JSON 명령을 입력하세요.')}};$('profile').onchange=()=>{selected=null;$('runId').value='';$('decisions').replaceChildren();$('runDetails').textContent='실행을 선택하세요.';$('production').checked=false;refresh()};$('filter').oninput=refresh;
if(token){refresh().then(ok=>{if(ok)notice('내 기기의 실행 기록에 연결되었습니다.')});setInterval(()=>{if(!busy)refresh()},2500)}else notice('터미널에 표시된 토큰 포함 주소로 이 화면을 다시 여세요.');
</script></html>'''

ALLOWED = {"profiles.list", "profiles.set", "jobs.list", "jobs.enqueue", "jobs.cancel", "runs.list", "runs.status", "runs.decision", "runs.submit_input", "runs.resume", "check", "probe", "backup", "restore", "prune", "evaluate", "compare", "prices.set", "prices.estimate", "bills.import", "bills.compare"}

class Worker:
    def __init__(self, root, cancel_active=lambda: None):
        self.root = root
        self.process = None
        self.lock = threading.Lock()
        self.stopping = threading.Event()
        self.thread = None
        self.last_code = None
        self.cancel_active = cancel_active
    def status(self):
        return {"running": bool(self.thread and self.thread.is_alive()), "stopping": self.stopping.is_set(), "lastExitCode": self.last_code}
    def start(self):
        with self.lock:
            if self.thread and self.thread.is_alive(): return self.status()
            self.stopping.clear()
            self.thread = threading.Thread(target=self.loop, daemon=True)
            self.thread.start()
        return self.status()
    def loop(self):
        child_env = {k: os.environ[k] for k in ("PATH", "SystemRoot", "TEMP", "TMP", "PATHEXT", "VIRTUAL_ENV") if k in os.environ}
        while not self.stopping.is_set():
            try:
                # Provider credentials are read only by the runner from the selected env file.
                with self.lock:
                    if self.stopping.is_set(): break
                    self.process = subprocess.Popen([sys.executable, "-X", "utf8", str(self.root / "flowly_ops.py"), "worker", "--root", str(self.root), "--once"], cwd=self.root, env=child_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}))
                self.last_code = self.process.wait()
            except OSError:
                self.last_code = 1
                break
            finally:
                with self.lock: self.process = None
            if self.last_code: break
            self.stopping.wait(1)
    def stop(self):
        self.stopping.set()
        self.cancel_active()
        if self.thread: self.thread.join(timeout=5)
        return self.status()

def create_server(root, port, operations=None):
    root = Path(root).absolute()
    if operations is None:
        from flowly_ops import Operations
        operations = Operations(root)
    token, nonce = secrets.token_urlsafe(32), secrets.token_urlsafe(24)
    def cancel_active():
        for job in operations.dispatch({"action": "jobs.list"}).get("jobs", []):
            if job.get("status") == "running": operations.dispatch({"action": "jobs.cancel", "jobId": job["id"]})
    worker = Worker(root, cancel_active)
    dispatch_lock = threading.Lock()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def reply(self, code, value, html=False):
            data = value.encode("utf-8") if html else json.dumps(value, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "text/html; charset=utf-8" if html else "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", f"default-src 'none'; script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
            self.end_headers()
            self.wfile.write(data)
        def reject(self, code, value):
            # Deliver the error before discarding a bounded amount of unread body.
            # Closing with unread bytes can reset even small requests on Windows.
            self.close_connection = True
            self.reply(code, value)
            self.wfile.flush()
            try:
                self.connection.shutdown(socket.SHUT_WR)
                deadline, remaining = time.monotonic() + .1, 65536
                while remaining and time.monotonic() < deadline:
                    self.connection.settimeout(max(.001, deadline - time.monotonic()))
                    chunk = self.rfile.read1(min(8192, remaining))
                    if not chunk: break
                    remaining -= len(chunk)
            except OSError:
                pass
        def host_ok(self):
            return self.headers.get("Host") == f"127.0.0.1:{self.server.server_port}"
        def do_GET(self):
            if not self.host_ok(): return self.reply(403, {"error": "로컬 주소를 확인해 주세요."})
            if self.path != "/": return self.reply(404, {"error": "경로를 찾지 못했어요."})
            self.reply(200, HTML.replace("NONCE", nonce), True)
        def do_POST(self):
            self.connection.settimeout(10)
            origin = f"http://127.0.0.1:{self.server.server_port}"
            if not self.host_ok() or self.headers.get("Origin") != origin or not hmac.compare_digest(self.headers.get("X-Flowly-Token", ""), token): return self.reject(403, {"error": "로컬 실행 화면을 다시 열어 주세요. 접근 토큰이 일치하지 않아요."})
            if self.path != "/api": return self.reject(404, {"error": "경로를 찾지 못했어요."})
            if self.headers.get("Transfer-Encoding") or self.headers.get("Content-Type", "").split(";")[0] != "application/json": return self.reject(415, {"error": "JSON 요청이 필요해요."})
            try:
                length = int(self.headers.get("Content-Length", "-1"))
                if not 1 <= length <= 350000: return self.reject(413, {"error": "요청 크기가 너무 커요."})
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict) or not isinstance(body.get("action"), str): return self.reply(400, {"error": "작업 이름을 확인해 주세요."})
                action = body["action"]
                if action == "local.worker.start": value = worker.start()
                elif action == "local.worker.stop": value = worker.stop()
                elif action == "local.snapshot":
                    with dispatch_lock:
                        package_path = root / "workflow.json"
                        if package_path.stat().st_size > 8000000: raise ValueError()
                        manifest = json.loads(package_path.read_text(encoding="utf-8-sig"))
                        value = {"name": manifest["workflow"]["name"], "definition": manifest["workflow"]["definition"], **operations.dispatch({"action": "profiles.list"}), **operations.dispatch({"action": "jobs.list"}), **operations.dispatch({"action": "runs.list", "profile": body.get("profile", "development")}), "worker": worker.status()}
                elif action in ALLOWED:
                    with dispatch_lock: value = operations.dispatch(body)
                else: return self.reply(400, {"error": "지원하지 않는 운영 명령이에요."})
                self.reply(200, value)
            except (ValueError, TypeError, KeyError, TimeoutError): self.reply(400, {"error": "요청 내용과 파일 형식을 확인해 주세요."})
            except Exception as exc:
                # Only the operations module's safe application errors may reach the UI.
                message = str(exc) if type(exc).__module__ == "flowly_ops" else "작업을 처리하지 못했어요. 설정과 로컬 저장 경로를 확인해 주세요."
                self.reply(409, {"error": message})
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    server.local_token, server.worker = token, worker
    return server

def main():
    parser = argparse.ArgumentParser(description="Flowly 로컬 실행 화면")
    parser.add_argument("--root", default=".")
    parser.add_argument("--port", type=int, default=8790)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535: parser.error("포트는 1024~65535 범위예요.")
    try:
        server = create_server(args.root, args.port)
        stopped = threading.Event()
        def stop(*_): stopped.set()
        signal.signal(signal.SIGINT, stop)
        signal.signal(signal.SIGTERM, stop)
        with server:
            server.timeout = .25
            print(json.dumps({"status": "listening", "url": f"http://127.0.0.1:{server.server_port}/#token={server.local_token}"}), flush=True)
            try:
                while not stopped.is_set(): server.handle_request()
            finally: server.worker.stop()
    except Exception:
        print(json.dumps({"error": "로컬 실행 화면을 열지 못했어요. 내보낸 폴더와 Python 설치·포트를 확인해 주세요."}, ensure_ascii=False), file=sys.stderr)
        return 1
    return 0

if __name__ == "__main__": sys.exit(main())
