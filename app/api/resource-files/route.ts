/** 첨부 바이트는 별도 API에서 처리한다. 세션/현재 자료 권한을 통과한 사용자만 원본을 받으며 웹에서 파일 코드를 실행하지 않는다. */
import { getChatGPTUser } from "../../chatgpt-auth";
import { sameOriginMutation } from "../../../server/auth/session";
import { getAuthConfig } from "../../../server/auth/environment";
import { resourceFilesForEnvironment } from "../../../server/resource-file-environment";
import { HistoryError } from "../../../server/repositories/errors";
import { RESOURCE_FILE_MAX_BYTES } from "../../../domain/resource-contract";
export const dynamic="force-dynamic";
const respond=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"no-store"}});
const failure=(error:unknown)=>respond({error:error instanceof HistoryError?error.message:"첨부를 처리하지 못했어요. 저장소와 파일을 확인해 주세요."},error instanceof HistoryError?error.status:500);
export async function GET(request:Request){const user=await getChatGPTUser();if(!user)return respond({error:"로그인 후 이용해 주세요."},401);try{const repo=resourceFilesForEnvironment(),id=new URL(request.url).searchParams.get("id");if(!id)return respond({storage:repo.status()});const {file,bytes}=await repo.read(user,id);return new Response(bytes.slice().buffer as ArrayBuffer,{headers:{"Content-Type":file.mimeType,"Content-Disposition":`attachment; filename="resource-file"; filename*=UTF-8''${encodeURIComponent(file.path.split("/").at(-1)!)}`,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});}catch(error){return failure(error);}}
export async function POST(request:Request){const user=await getChatGPTUser();if(!user)return respond({error:"로그인 후 이용해 주세요."},401);if(!sameOriginMutation(getAuthConfig(),request))return respond({error:"허용되지 않은 요청이에요."},403);try{const url=new URL(request.url),bytes=new Uint8Array(await request.arrayBuffer());if(bytes.byteLength>RESOURCE_FILE_MAX_BYTES)return respond({error:"첨부 파일은 5MB 이하여야 해요."},413);return respond({file:await resourceFilesForEnvironment().upload(user,url.searchParams.get("path"),url.searchParams.get("mimeType")??request.headers.get("content-type"),bytes)},201);}catch(error){return failure(error);}}
