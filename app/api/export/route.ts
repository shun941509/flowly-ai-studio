import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { getAuthConfig } from "../../../server/auth/environment";
import { buildExportManifest, ExportPackageError, readExportRequest } from "../../../server/export-package";
import { buildCopyPrompt } from "../../../server/export-ai-documents";
import { buildExecutableExportPackage } from "../../../server/export-assets";
import { requireResources } from "../../../server/repositories/resources";
import { HistoryError, WorkflowHistoryRepository } from "../../../server/repositories/workflow-history";

export const dynamic = "force-dynamic";
const respond = (error: string, status: number) => Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return respond("로그인 후 이용해 주세요.", 401);
  try {
    const input = await readExportRequest(request, getAuthConfig());
    const { language, kind } = input;
    if (!env.DB) return respond("자료 저장소가 미설정이에요. 관리자에게 확인해 주세요.", 503);
    const history = new WorkflowHistoryRepository(env.DB);
    const published = input.workflowId && input.versionId ? await history.getVersion(user, input.workflowId, input.versionId) : undefined;
    const workflow = published ? { id: published.workflowId, name: published.name, description: published.description, definition: published.definition, updatedAt: published.createdAt } : input.workflow;
    const options: Parameters<typeof buildExecutableExportPackage>[0] = {
      user, workflow, connections: [], language, kind,
      resolveResources: async (identity, ids) => {
        try { return await requireResources(identity, ids); }
        catch (error) {
          if (error instanceof Error && /접근 권한|공유가 철회/.test(error.message)) throw new ExportPackageError("접근 권한이 없거나 공유가 철회된 자료예요. 자료 소유자에게 확인해 주세요.", 403);
          throw new ExportPackageError("자료 저장소에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.", 503);
        }
      },
    };
    const result = kind === "prompt" ? buildCopyPrompt(await buildExportManifest(options)) : await buildExecutableExportPackage(options);
    await history.recordAudit(user, "workflow.export", "workflow", published?.workflowId || String((workflow as {id?:string})?.id || "workflow").slice(0,100), { ...(published ? { version: published.number } : {}), fields: ["kind", "language", "definition", "resources", "connections"] });
    if (typeof result === "string") return Response.json({ kind: "prompt", text: result, language }, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    const bytes = result;
    return new Response(bytes.slice().buffer as ArrayBuffer, { headers: {
      "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="flowly-${kind === "agent" ? "agent" : "project"}-${language}.zip"`,
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) {
    if (error instanceof HistoryError) return respond(error.message, error.status);
    if (error instanceof ExportPackageError) return respond(error.message, error.status);
    if (error instanceof SyntaxError) return respond("요청 형식을 확인해 주세요.", 400);
    return respond("실행 프로젝트를 만들지 못했어요. 연결 설정을 확인하거나 잠시 후 다시 시도해 주세요.", 503);
  }
}
