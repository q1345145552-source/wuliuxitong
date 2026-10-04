import type { HttpRequest } from "../../server";
import { realtimeHub, type RealtimeHub } from "./hub";
import { topicForWrite } from "./topics";

/**
 * 改数据的请求成功之后，告诉总机「哪一类变了」（server.ts 在每个 POST / DELETE 跑完后调）。
 * 只认成功的（2xx）、登录了的；失败的请求没改成任何东西，不推。
 */
export function publishAfterWrite(req: HttpRequest, statusCode: number, hub: RealtimeHub = realtimeHub): void {
  if (req.method !== "POST" && req.method !== "DELETE") return;
  if (statusCode < 200 || statusCode >= 300) return;
  if (!req.auth) return;
  // 删除前的「预览」（dryRun）只算不改，不推（Codex 复查 2026-10-05：打开删除确认框就让全公司页面重拉一遍）
  // 跟那两个删除接口同一种认法（它们是 `if (body.dryRun)`，真值就只预览）
  if ((req.body as { dryRun?: unknown } | undefined)?.dryRun) return;
  const topic = topicForWrite(req.path);
  if (!topic) return;
  const actor = { userId: req.auth.userId, role: req.auth.role, agentId: req.auth.agentId };
  let clientIds: string[] | undefined;
  if (topic === "chat" && (actor.role === "staff" || actor.role === "admin")) {
    // 员工这边的客服接口都带 clientId（回复 / 撤回 / 已读），只推给那一个客户。
    // 不需要再核这个客户是不是本公司的：总机按公司过滤，别家公司的人收不到。
    const raw = (req.body as { clientId?: unknown } | undefined)?.clientId;
    const clientId = typeof raw === "string" ? raw.trim() : "";
    if (clientId) clientIds = [clientId];
  }
  hub.publish({ companyId: req.auth.companyId, topic, actor, clientIds });
}
