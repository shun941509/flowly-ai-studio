import {test} from "node:test";
import assert from "node:assert/strict";
import {bufferApiRequest} from "../server/http";
import {RESOURCE_FILE_MAX_BYTES,RESOURCE_REQUEST_MAX_BYTES} from "../domain/resource-contract";
test("bounded API buffer drains source even when downstream auth rejects",async()=>{
  const request=new Request("http://127.0.0.1/api/studio",{method:"POST",headers:{Origin:"https://attacker.example","Content-Type":"application/json"},body:'{"action":"unauthorized"}'});
  const buffered=await bufferApiRequest(request);
  assert.equal(request.bodyUsed,true);assert.equal(buffered.headers.get("origin"),"https://attacker.example");
  assert.equal(await buffered.text(),'{"action":"unauthorized"}');
});
test("API request bodies have a byte limit before parsing/authentication",async()=>{
  for(const [path,limit] of [["/api/studio",RESOURCE_REQUEST_MAX_BYTES],["/api/resource-files",RESOURCE_FILE_MAX_BYTES],["/api/export",350000]] as const){
    const accepted=await bufferApiRequest(new Request("http://127.0.0.1"+path,{method:"POST",body:"x".repeat(limit)}));
    assert.equal((await accepted.arrayBuffer()).byteLength,limit);
    await assert.rejects(()=>bufferApiRequest(new Request("http://127.0.0.1"+path,{method:"POST",body:"x".repeat(limit+1)})),/REQUEST_TOO_LARGE/);
  }
  // 한국어는 UTF-8 바이트로 계산한다. 글자 수만 세어 요청 제한을 우회하지 못한다.
  await assert.rejects(()=>bufferApiRequest(new Request("http://127.0.0.1/api/studio",{method:"POST",body:"한".repeat(Math.ceil(RESOURCE_REQUEST_MAX_BYTES/3))})),/REQUEST_TOO_LARGE/);
});
