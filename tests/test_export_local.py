"""Real loopback control-panel HTTP boundary; operations are explicit test doubles."""
import http.client
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location("flowly_local",ROOT/"export-runtime"/"flowly_local.py")
local=importlib.util.module_from_spec(spec);spec.loader.exec_module(local)
ops_spec=importlib.util.spec_from_file_location("flowly_ops",ROOT/"export-runtime"/"flowly_ops.py")
operations=importlib.util.module_from_spec(ops_spec);ops_spec.loader.exec_module(operations)

class FakeOperations:
    def __init__(self):self.calls=[]
    def dispatch(self,request):
        self.calls.append(request)
        return {"profiles.list":{"profiles":[{"name":"default","env":".env","state":".flowly-profiles/default/runs","production":False}]},"jobs.list":{"jobs":[]},"runs.list":{"runs":[]},"check":{"status":"ready"}}.get(request["action"],{"ok":True})

class LocalTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix="flowly-local-");self.root=Path(self.temp.name)
        (self.root/"workflow.json").write_text(json.dumps({"workflow":{"name":"로컬 테스트","definition":{"nodes":[],"edges":[]}}}),encoding="utf-8")
        self.ops=FakeOperations();self.server=local.create_server(self.root,0,self.ops)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.origin="http://127.0.0.1:"+str(self.server.server_port)
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join();self.temp.cleanup()
    def request(self,action="check",headers=None,path="/api",body=None):
        h={"Origin":self.origin,"X-Flowly-Token":self.server.local_token,"Content-Type":"application/json"};h.update(headers or {})
        c=http.client.HTTPConnection("127.0.0.1",self.server.server_port,timeout=5)
        c.request("POST",path,body if body is not None else json.dumps({"action":action}),h)
        r=c.getresponse();value=r.read();c.close();return r.status,json.loads(value)
    def test_snapshot_is_local_read_only_and_does_not_execute(self):
        status,value=self.request("local.snapshot");self.assertEqual(status,200);self.assertEqual(value["name"],"로컬 테스트")
        self.assertEqual([c["action"] for c in self.ops.calls],["profiles.list","jobs.list","runs.list"])
    def test_requires_exact_host_origin_and_ephemeral_token(self):
        for header in ({"Origin":"https://evil.example"},{"Origin":"null"},{"Origin":""},{"X-Flowly-Token":"wrong"},{"Host":"attacker.example"},{"Host":"localhost:"+str(self.server.server_port)}):self.assertEqual(self.request(headers=header)[0],403)
        self.assertEqual(self.ops.calls,[])
        self.assertEqual(self.request()[0],200)
    def test_rejected_headers_preserve_status_when_small_body_arrives_later(self):
        raw=json.dumps({"action":"check"}).encode()
        for path,extra,expected in (("/api",{"X-Flowly-Token":"wrong"},403),("/wrong",{},404),("/api",{"Content-Type":"text/plain"},415),("/api",{"Content-Length":"350001"},413)):
            with self.subTest(status=expected):
                headers={"Origin":self.origin,"X-Flowly-Token":self.server.local_token,"Content-Type":"application/json","Content-Length":str(len(raw)),**extra}
                c=http.client.HTTPConnection("127.0.0.1",self.server.server_port,timeout=3)
                try:
                    c.putrequest("POST",path)
                    for key,value in headers.items():c.putheader(key,value)
                    c.endheaders()
                    # Header/body packets need not arrive together. The rejection
                    # must remain readable rather than becoming a TCP reset.
                    time.sleep(.02)
                    c.send(raw)
                    response=c.getresponse()
                    self.assertEqual(response.status,expected)
                    self.assertIn("error",json.loads(response.read()))
                finally:c.close()
        self.assertEqual(self.ops.calls,[])
    def test_oversize_rejection_does_not_wait_for_declared_body(self):
        c=http.client.HTTPConnection("127.0.0.1",self.server.server_port,timeout=2)
        try:
            started=time.monotonic()
            c.request("POST","/api",b"",{"Origin":self.origin,"X-Flowly-Token":self.server.local_token,"Content-Type":"application/json","Content-Length":"350001"})
            response=c.getresponse()
            self.assertEqual(response.status,413)
            self.assertIn("error",json.loads(response.read()))
            self.assertLess(time.monotonic()-started,1)
        finally:c.close()
        self.assertEqual(self.ops.calls,[])
    def test_unknown_commands_oversize_malformed_and_file_paths_are_rejected(self):
        self.assertEqual(self.request("shell.exec")[0],400)
        self.assertEqual(self.request(path="/.env")[0],404)
        self.assertEqual(self.request(headers={"Content-Type":"text/plain"})[0],415)
        self.assertEqual(self.request(body="{")[0],400)
        # Reject the declared length before reading the body. Sending a whole
        # rejected body can produce a Windows TCP reset while the server closes.
        self.assertEqual(self.request(body="",headers={"Content-Length":"350001"})[0],413)
        try:
            self.assertEqual(self.request(body="x"*350001)[0],413)
        except (ConnectionAbortedError,ConnectionResetError,BrokenPipeError):
            pass
        self.assertEqual(self.ops.calls,[])
    def test_page_has_csp_no_token_embedding_no_external_resources(self):
        c=http.client.HTTPConnection("127.0.0.1",self.server.server_port);c.request("GET","/");r=c.getresponse();html=r.read().decode();c.close()
        self.assertEqual(r.status,200);self.assertIn("frame-ancestors 'none'",r.getheader("Content-Security-Policy"));self.assertIn("no-store",r.getheader("Cache-Control"))
        self.assertNotIn(self.server.local_token,html);self.assertNotIn('src="http',html);self.assertIn("textContent",html)
    def test_provider_error_body_never_reaches_ui(self):
        def failed(_):raise RuntimeError("sk-private-provider-response")
        self.ops.dispatch=failed
        code,value=self.request();self.assertEqual(code,409);self.assertNotIn("sk-private",json.dumps(value))

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for browser script parsing")
    def test_browser_script_parses_including_review_decision_callback(self):
        script=re.search(r'<script nonce="NONCE">(.*?)</script>',local.HTML,re.S).group(1)
        path=self.root/"local-ui.js";path.write_text(script,encoding="utf-8")
        result=subprocess.run([shutil.which("node"),"--check",str(path)],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for local UI field execution")
    def test_supplementary_form_submits_numbers_and_false_without_running(self):
        script=re.search(r'<script nonce="NONCE">(.*?)</script>',local.HTML,re.S).group(1)
        bootstrap=r'''
const assert=require('node:assert/strict');
class Element{constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.value='';}append(...items){this.children.push(...items)}replaceChildren(...items){this.children=items}reportValidity(){return true}}
const elements=new Map();global.document={getElementById(id){if(!elements.has(id))elements.set(id,new Element('div'));return elements.get(id)},createElement(tag){return new Element(tag)}};
global.location={hash:'',pathname:'/'};global.sessionStorage={getItem(){return null},setItem(){}};global.history={replaceState(){}};
global.fetch=()=>{throw Error('network forbidden')};global.setInterval=()=>{};
'''
        assertions=r'''
(async()=>{
 const sent=[];perform=async(action,args)=>{sent.push({action,args});return {status:'queued'}};loadRun=async()=>{};
 selected={id:'run_a',inputRequests:[{id:'input_a',status:'pending',expiresAt:'2099',fields:[
 {key:'count',type:'number',label:'수량',required:true},{key:'accepted',type:'boolean',label:'확인',required:true},
 {key:'note',type:'text',label:'추가',required:false}]}]};
 drawInputRequests();const box=elements.get('decisions').children[0],controls=box.children.filter(x=>x.tagName==='LABEL').map(x=>x.children[0]);
 controls[0].value='0';controls[1].value='false';
 await box.children.find(x=>x.tagName==='BUTTON').onclick();
 assert.equal(sent.length,1);assert.equal(sent[0].action,'runs.submit_input');
 assert.deepEqual(sent[0].args.values,{count:0,accepted:false});assert.equal(sent[0].args.runId,'run_a');
 assert.equal(sent[0].args.requestId,'input_a');
})().catch(e=>{console.error(e);process.exitCode=1});
'''
        path=self.root/"typed-local-ui.js";path.write_text(bootstrap+script+assertions,encoding="utf-8")
        result=subprocess.run([shutil.which("node"),str(path)],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)

    def test_default_snapshot_with_real_operations_uses_development_profile(self):
        package={"format":"flowly-executable-export","version":1,"language":"python","owner":{"userId":"alice","email":"alice@example.test","displayName":"Alice"},"workflow":{"id":"flow","name":"실제 운영 상태","definition":{"schemaVersion":5,"nodes":[],"edges":[]}},"resources":[],"connections":[],"limits":{"maxTurns":8,"maxToolCalls":12,"maxTokens":8000,"maxDurationMs":120000}}
        (self.root/"workflow.json").write_text(json.dumps(package),encoding="utf-8")
        real_ops=operations.Operations(self.root)
        self.ops.dispatch=real_ops.dispatch
        status,value=self.request("local.snapshot")
        self.assertEqual(status,200,value);self.assertEqual(value["profiles"][0]["name"],"development")
        self.assertEqual(value["jobs"],[]);self.assertEqual(value["runs"],[])

if __name__=="__main__":unittest.main()
