// Only the artifact harness imports this file. It is never in a product ZIP.
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
const deny=()=>{throw new Error("External network forbidden by catalog test");};
net.Socket.prototype.connect=deny;http.request=deny;https.request=deny;
const contract=JSON.parse(readFileSync("example-contract.json","utf8"));
const marker=`CATALOG_INPUT_${contract.id}`;
const evidence=`EVIDENCE:${contract.id}`;
const manifest=JSON.parse(readFileSync("workflow.json","utf8")),fixture=manifest.resources[0];
const dataSchema=manifest.workflow.definition.nodes.find(node=>node.type==="agent")?.outputSchema?.properties?.data;
function sample(schema,text) {
  if(schema.type==="object")return Object.fromEntries(Object.entries(schema.properties||{}).map(([key,value])=>[key,sample(value,text)]));
  if(schema.type==="array")return [];
  return schema.type==="number"?1:schema.type==="boolean"?false:text;
}
globalThis.fetch=async(input,init)=>{
  if(String(input)!=="https://api.openai.com/v1/responses")throw new Error("Unexpected URL");
  const body=JSON.parse(String(init?.body));
  if(body.tools?.length)throw new Error("Unexpected external tools");
  const message=body.input?.find(item=>item.role==="user");
  if(!message)throw new Error("User input missing");
  const payload=JSON.parse(message.content),mapped=JSON.stringify(payload.input);
  if(!mapped.includes(marker))throw new Error("Original input lost in graph mapping");
  // Read/retrieval stages supply fixture content/source; synthesis stages must
  // receive an observation emitted by an earlier test model call.
  if(!Object.values(payload.input).some(value=>typeof value==="string"&&(value.includes(fixture.content)||value.includes(fixture.id)))&&!mapped.includes(evidence))throw new Error("Fixture evidence lost in graph mapping");
  if(!payload.instruction?.includes(contract.problem))throw new Error("Project-specific instruction missing");
  let text=`TEST_ADAPTER ${marker} ${evidence}`;
  if(dataSchema)text=mapped.includes("CATALOG_BAD_SCHEMA")?'{"unexpected":"TEST_ADAPTER"}':JSON.stringify(sample(dataSchema,text));
  return Response.json({status:"completed",usage:{total_tokens:3},output:[{type:"message",content:[{type:"output_text",text}]}]});
};
