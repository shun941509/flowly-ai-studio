/** API 요청 본문을 라우팅 전에 제한된 크기와 시간 안에 버퍼링한다. 개별 라우트의 인증·입력 형식 검사를 대체하지 않는다. */
import { RESOURCE_FILE_MAX_BYTES, RESOURCE_REQUEST_MAX_BYTES } from "../domain/resource-contract";
/** 화면·라우트에서 안내한 첨부/자료 크기와 실제 요청 버퍼 제한을 일치시킨다. */
export function apiRequestByteLimit(pathname:string){return pathname==="/api/resource-files"?RESOURCE_FILE_MAX_BYTES:pathname==="/api/studio"?RESOURCE_REQUEST_MAX_BYTES:350000;}
/** Drain incoming API bodies before handing them to the framework. Some local
 * Workers proxies abort the next keep-alive request if an early auth/CSRF guard
 * responds while the prior request is still streaming. Bound memory and time. */
/** 본문을 끝까지 읽어 인증 거절 시 로컬 프록시의 연결이 꼬이는 것을 방지한다. GET/HEAD와 API 외 경로는 그대로 통과한다. */
export async function bufferApiRequest(request:Request):Promise<Request> {
  if(!new URL(request.url).pathname.startsWith("/api/") || ["GET","HEAD"].includes(request.method) || !request.body)return request;
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];
  const pathname=new URL(request.url).pathname;
  const limit=apiRequestByteLimit(pathname);
  let size=0,timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("REQUEST_TIMEOUT")),10000);});
  try {
    for(;;) {
      const chunk=await Promise.race([reader.read(),deadline]);if(chunk.done)break;
      size+=chunk.value.byteLength;if(size>limit)throw new Error("REQUEST_TOO_LARGE");
      chunks.push(chunk.value);
    }
    const body=new Uint8Array(size);let offset=0;
    for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
    return new Request(request,{body});
  } finally {if(timer)clearTimeout(timer);await reader.cancel().catch(()=>{});}
}
