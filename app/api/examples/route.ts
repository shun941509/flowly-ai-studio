import { env } from "cloudflare:workers";
import { strToU8, zipSync } from "fflate";
import { getChatGPTUser } from "../../chatgpt-auth";
import { getAuthConfig } from "../../../server/auth/environment";
import { sameOriginMutation } from "../../../server/auth/session";
import { getExample, listExamples, saveExample } from "../../../server/example-catalog";
import { frameworkPacks } from "../../../server/generated/framework-packs";
import { buildExampleExport, buildExamplePrompt } from "../../../server/example-export";
import { ExportPackageError } from "../../../server/export-package";

export const dynamic="force-dynamic";
const respond=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"no-store"}});
export async function GET(request:Request) {
  if(!await getChatGPTUser())return respond({error:"로그인 후 예제 프로젝트를 이용해 주세요."},401);
  const params=new URL(request.url).searchParams,id=params.get("id");
  if(id) {const project=getExample(id);return project?respond({project}):respond({error:"예제 프로젝트를 찾을 수 없어요."},404);}
  if(params.get("view") && !["catalog","supporting"].includes(params.get("view")!))return respond({error:"공통 흐름을 재사용하는 업무 사례는 예제 프로젝트로 제공하지 않습니다."},410);
  return respond(listExamples(params));
}
export async function POST(request:Request) {
  const user=await getChatGPTUser();if(!user)return respond({error:"로그인 후 이용해 주세요."},401);
  if(!sameOriginMutation(getAuthConfig(),request))return respond({error:"허용되지 않은 요청이에요."},403);
  if(request.headers.get("content-type")?.split(";")[0].trim()!=="application/json")return respond({error:"JSON 요청이 필요해요."},415);
  if(Number(request.headers.get("content-length"))>4096)return respond({error:"요청이 너무 커요."},413);
  try {
    // worker/index.ts has already drained this body with a 350 KB / 10 s cap.
    const raw=await request.text();if(new TextEncoder().encode(raw).byteLength>4096)return respond({error:"요청이 너무 커요."},413);
    const body:unknown=JSON.parse(raw);if(!body||typeof body!=="object"||Array.isArray(body))return respond({error:"요청 형식을 확인해 주세요."},400);
    const data=body as Record<string,unknown>;
    if(data.action==="instantiate") {
      if(typeof data.id!=="string")return respond({error:"예제 ID가 필요해요."},400);
      const project=getExample(data.id);if(!project)return respond({error:"예제 프로젝트를 찾을 수 없어요."},404);
      if(!env.DB)return respond({error:"저장소 연결이 아직 설정되지 않았어요."},503);
      return respond(await saveExample(env.DB,project,user),201);
    }
    if(data.action==="download-project") {
      if(typeof data.id!=="string"||(data.language!=="node"&&data.language!=="python"))return respond({error:"예제와 실행 언어를 선택해 주세요."},400);
      const kind=data.kind??"runtime";
      if(kind!=="runtime"&&kind!=="agent"&&kind!=="prompt")return respond({error:"내보낼 항목을 다시 선택해 주세요."},400);
      const project=getExample(data.id);if(!project)return respond({error:"예제 프로젝트를 찾을 수 없어요."},404);
      if(kind==="prompt")return respond({kind,text:await buildExamplePrompt(project,user,data.language),language:data.language});
      const bytes=await buildExampleExport(project,user,data.language,kind);
      return new Response(bytes,{headers:{"Content-Type":"application/zip","Content-Disposition":`attachment; filename="flowly-${project.id}-${kind}-${data.language}.zip"`,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
    }
    if(data.action==="download") {
      const pack=frameworkPacks.find(p=>p.id===data.variantId);if(!pack||!getExample(pack.projectId))return respond({error:"실행 패키지를 찾을 수 없어요."},404);
      const files=Object.fromEntries(Object.entries(pack.files).map(([name,content])=>[name,strToU8(content)]));
      const bytes=zipSync(files,{level:6});
      return new Response(bytes,{headers:{"Content-Type":"application/zip","Content-Disposition":`attachment; filename="flowly-${pack.id}.zip"`,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
    }
    return respond({error:"지원하지 않는 작업이에요."},400);
  } catch(error) {
    if(error instanceof ExportPackageError)return respond({error:error.message},error.status);
    if(error instanceof SyntaxError)return respond({error:"요청 형식을 확인해 주세요."},400);
    console.error("Example package request failed");return respond({error:"예제를 처리하지 못했어요. 잠시 후 다시 시도해 주세요."},500);
  }
}
