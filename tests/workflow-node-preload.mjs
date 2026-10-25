import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import {readFileSync,appendFileSync} from "node:fs";
import fs from "node:fs";
import {syncBuiltinESMExports} from "node:module";
// Record unexpected filesystem error codes without paths, file contents or secrets.
// Preserve the original rejection; diagnostics must never retry or hide a failure.
for(const name of ["open","readFile","writeFile","rename","unlink","mkdir"]) {
  const original=fs.promises[name];
  fs.promises[name]=async function(...args) {
    try{return await original.apply(this,args);}catch(error) {
      if(typeof error?.code==="string"&&/^[A-Z0-9_]+$/.test(error.code)&&!["ENOENT","EEXIST"].includes(error.code)) {
        try{appendFileSync(".filesystem-errors.jsonl",JSON.stringify({at:new Date().toISOString(),operation:name,code:error.code,syscall:typeof error.syscall==="string"&&/^[a-z_]+$/.test(error.syscall)?error.syscall:undefined})+"\n");}catch{}
      }
      throw error;
    }
  };
}
syncBuiltinESMExports();
const deny=()=>{throw new Error("External network blocked in workflow scenario tests");};
net.Socket.prototype.connect=deny;http.request=deny;https.request=deny;
const scenario=JSON.parse(readFileSync(".scenario.json","utf8"));
const manifest=JSON.parse(readFileSync("workflow.json","utf8"));
const lines=path=>{try{return readFileSync(path,"utf8").trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));}catch(error){if(error.code==="ENOENT")return [];throw error;}};
const log=(path,entry)=>appendFileSync(path,JSON.stringify(entry)+"\n");
const canonical=value=>value&&typeof value==="object"?Array.isArray(value)?value.map(canonical):Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const boundaryFetch=async(url,init)=>{
  const body=JSON.parse(String(init?.body));
  if(String(url)==="https://api.openai.com/v1/embeddings") {
    const data=body.input.map((text,index)=>{const reply=scenario.embeddingReplies?.find(r=>r.text===text);if(!reply)throw new Error("Unexpected embedding input");return {index,embedding:reply.vector};});
    log(".embedding-calls.jsonl",{texts:body.input});
    return Response.json({data,model:body.model,usage:{total_tokens:2}});
  }
  if(String(url)!=="https://api.openai.com/v1/responses") {
    if(!manifest.connections.some(c=>c.endpoint===String(url)))throw new Error("Unexpected external URL");
    if(body.method==="initialize")return Response.json({jsonrpc:"2.0",id:body.id,result:{protocolVersion:"2025-11-25",capabilities:{tools:{}}}});
    if(body.method==="notifications/initialized")return new Response(null,{status:202});
    if(body.method!=="tools/call")throw new Error("Unexpected MCP method");
    const {name,arguments:args}=body.params;
    const reply=scenario.toolReplies?.find(r=>r.name===name&&JSON.stringify(canonical(r.args))===JSON.stringify(canonical(args)));
    if(!reply)throw new Error("Unexpected MCP arguments");
    const count=lines(".tool-calls.jsonl").filter(c=>c.name===name&&JSON.stringify(canonical(c.args))===JSON.stringify(canonical(args))).length;
    if(count>=(reply.count??1))throw new Error("MCP call repeated beyond explicit test allowance");
    log(".tool-calls.jsonl",{name,args});
    const localResult=reply.localOperation?JSON.parse(execFileSync("python",["-I","-X","utf8",fileURLToPath(new URL("./p4-local-tools.py",import.meta.url))],{input:JSON.stringify({operation:reply.localOperation,arguments:args,scenario:scenario.name}),encoding:"utf8",timeout:15000,windowsHide:true})):undefined;
    if(reply.error==="disconnect")throw Object.assign(new Error("Test-only disconnected MCP response"),{fixtureFault:true});
    return Response.json({jsonrpc:"2.0",id:body.id,result:reply.error==="tool_error"?{isError:true,content:[{type:"text",text:"Test tool error"}]}:(localResult??reply.result)});
  }
  const payload=JSON.parse(body.input.find(m=>m.role==="user").content);
  const previous=lines(".model-calls.jsonl");
  const reply=scenario.modelReplies?.find(r=>JSON.stringify(payload).includes(r.match)&&(!r.occurrence||r.occurrence===previous.filter(c=>c.match===r.match).length+1));
  if(!reply)throw new Error(`Unexpected model step: ${payload.instruction}`);
  const input=JSON.stringify(payload.input);
  for(const required of reply.inputContains||[])if(!input.includes(required))throw new Error(`Missing model input: ${required}`);
  for(const excluded of reply.inputExcludes||[])if(input.includes(excluded))throw new Error(`Disallowed model input: ${excluded}`);
  const observations=JSON.stringify(body.input.filter(m=>m.type==="function_call_output"));
  for(const required of reply.observationContains??[])if(!observations.includes(required))throw new Error("Missing actual tool observation: "+required);
  const allowed=body.tools?.map(t=>t.name).sort()??[];
  if(JSON.stringify(allowed)!==JSON.stringify([...(reply.allowedTools??[])].sort()))throw new Error("Unexpected allowed model tools");
  const occurrence=previous.filter(c=>c.match===reply.match).length+1;
  log(".model-calls.jsonl",{match:reply.match,occurrence});
  log(".model-timing.jsonl",{match:reply.match,occurrence,phase:"start",at:Date.now()});
  if(reply.delayMs)await new Promise(r=>setTimeout(r,reply.delayMs));
  log(".model-timing.jsonl",{match:reply.match,occurrence,phase:"end",at:Date.now()});
  const output=reply.toolCall?[{type:"function_call",name:reply.toolCall.name,arguments:JSON.stringify(reply.toolCall.args),call_id:reply.toolCall.callId??`${reply.match}-${occurrence}`}]:[{type:"message",content:[{type:"output_text",text:reply.text}]}];
  return Response.json({status:"completed",usage:{total_tokens:3},output});
};
globalThis.fetch=async(...args)=>{try{return await boundaryFetch(...args);}catch(error){if(!error.fixtureFault)log(".boundary-errors.jsonl",{message:String(error.message)});throw error;}};
