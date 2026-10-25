/** Drain incoming API bodies before handing them to the framework. Some local
 * Workers proxies abort the next keep-alive request if an early auth/CSRF guard
 * responds while the prior request is still streaming. Bound memory and time. */
export async function bufferApiRequest(request:Request):Promise<Request> {
  if(!new URL(request.url).pathname.startsWith("/api/") || ["GET","HEAD"].includes(request.method) || !request.body)return request;
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];
  let size=0,timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("REQUEST_TIMEOUT")),10000);});
  try {
    for(;;) {
      const chunk=await Promise.race([reader.read(),deadline]);if(chunk.done)break;
      size+=chunk.value.byteLength;if(size>350000)throw new Error("REQUEST_TOO_LARGE");
      chunks.push(chunk.value);
    }
    const body=new Uint8Array(size);let offset=0;
    for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
    return new Request(request,{body});
  } finally {if(timer)clearTimeout(timer);await reader.cancel().catch(()=>{});}
}
