import {test} from "node:test";
import assert from "node:assert/strict";
import {bufferApiRequest} from "../server/http";
test("bounded API buffer drains source even when downstream auth rejects",async()=>{
  const request=new Request("http://127.0.0.1/api/studio",{method:"POST",headers:{Origin:"https://attacker.example","Content-Type":"application/json"},body:'{"action":"unauthorized"}'});
  const buffered=await bufferApiRequest(request);
  assert.equal(request.bodyUsed,true);assert.equal(buffered.headers.get("origin"),"https://attacker.example");
  assert.equal(await buffered.text(),'{"action":"unauthorized"}');
});
test("API request bodies have a byte limit before parsing/authentication",async()=>{
  await assert.rejects(()=>bufferApiRequest(new Request("http://127.0.0.1/api/studio",{method:"POST",body:"x".repeat(350001)})),/REQUEST_TOO_LARGE/);
});
