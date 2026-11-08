/* ==========================================================================
   超管「代理管理 → 代理申请」审批（2026-11-08，老板：「财务提交，物流审批」）
   --------------------------------------------------------------------------
   GET  /admin/agents/applications/list?status=pending|approved|rejected|all   列表（带各状态张数，页签上标待审数）
   POST /admin/agents/applications/approve   通过：当场开代理号（字段、校验跟 /admin/agents/create 完全一样）
   POST /admin/agents/applications/reject    驳回：必须写原因

   ⚠️ 规矩跟代理管理一样：requireRole(["admin"])，员工 / 客户 / 代理一律 403；一律按 auth.companyId 过滤，查不到 404（CLAUDE.md #27）；
      接口不许用 /admin/agents 本身（那是页面网址，见 admin-routes.ts 文件头）。
   ⚠️ 通过：「改申请状态 + 建代理 + 建登录号 + 记开出来的号」在**同一个事务**里 ——
      先 SELECT … FOR UPDATE 锁住这张申请、锁里重读状态（不是 pending 就 409），再带条件把 pending 改成 approved（改到的必须正好 1 行），再建号；任何一步失败整个回滚：
      申请还是 pending、不留代理行和用户行、logo 文件删掉。两个超管同时点通过 / 一个通过一个驳回，后到的那个
      等前一个提交完再判断，条件不成立 → 409（CLAUDE.md #28：判断在锁里做，不靠事务外读到的状态）。
   ⚠️ 老板 2026-11-08 定的三条：已经是客户的另开代理号、客户号不动；密码超管审批时设好线下告诉对方；
      通过后对方要在海外仓财务系统用新代理号授权登录一次才绑上（这里不自动绑、不碰授权流程）。
   ========================================================================== */

import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { BusinessError } from "../core/business-error";
import { fail, ok, requireRole } from "../core/http-utils";
import { deleteImageFile, saveImageToDisk } from "../orders/image-storage";
import { agentCreateData, agentCreateTakenMessage, parseAgentCreateBody, uniqueConflictMessage } from "./admin-routes";

type Tx = any;

const STATUSES = ["pending", "approved", "rejected"] as const;
type ApplicationStatus = (typeof STATUSES)[number];
const ALREADY_HANDLED = "这张申请已经处理过了";
const NOT_FOUND = "申请不存在";
const REJECT_REASON_MAX = 200;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** 列表一行（只给超管）。逐个字段列，不许 ...row（CLAUDE.md #31） */
export interface AdminAgentApplicationItem {
  id: string;
  status: ApplicationStatus;
  warehouseId: number;
  warehouseName: string;
  submittedBy: string;
  agentName: string;
  contactName: string;
  contactPhone: string;
  loginId: string;
  remark: string | null;
  createdAt: string;
  reviewedAt: string | null;
  reviewedById: string | null;
  /** 处理人名字（超管内部看）；处理人账号被删了是 null */
  reviewedByName: string | null;
  rejectReason: string | null;
  approvedAgentId: string | null;
  approvedLoginId: string | null;
}

function statusOf(raw: string): ApplicationStatus {
  return (STATUSES as readonly string[]).includes(raw) ? (raw as ApplicationStatus) : "pending";
}

export function registerAgentApplicationAdminRoutes(app: MinimalHttpApp): void {
  /* ────────────────────────── 列表 ────────────────────────── */
  app.get("/admin/agents/applications/list", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const raw = typeof req.query.status === "string" && req.query.status ? req.query.status : "all";
    if (raw !== "all" && !(STATUSES as readonly string[]).includes(raw)) {
      return fail(res, 400, "BAD_REQUEST", "状态只能是 pending、approved、rejected 或 all");
    }

    // 申请很少，一次全给（不分页、不截断，CLAUDE.md #21）
    const [rows, grouped] = await Promise.all([
      prisma.agentApplication.findMany({
        where: { companyId: auth.companyId, ...(raw === "all" ? {} : { status: raw }) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          id: true, status: true, warehouseId: true, warehouseName: true, submitterName: true, agentName: true,
          contactName: true, contactPhone: true, loginId: true, remark: true, createdAt: true, reviewedAt: true,
          reviewedById: true, rejectReason: true, approvedAgentId: true, approvedLoginId: true,
        },
      }),
      raw === "all" ? Promise.resolve(null) : prisma.agentApplication.groupBy({ by: ["status"], where: { companyId: auth.companyId }, _count: { _all: true } }),
    ]);

    const reviewerIds = [...new Set(rows.map((r) => r.reviewedById).filter((v): v is string => !!v))];
    const reviewers = reviewerIds.length === 0
      ? []
      : await prisma.user.findMany({ where: { id: { in: reviewerIds }, companyId: auth.companyId }, select: { id: true, name: true } });
    const reviewerName = new Map(reviewers.map((reviewer) => [reviewer.id, reviewer.name]));

    // 「全部」时张数就从这一批行里数（跟列表是同一个快照）；只看某一种时另外按状态数
    const counts: Record<ApplicationStatus, number> = { pending: 0, approved: 0, rejected: 0 };
    if (raw === "all") {
      for (const r of rows) counts[statusOf(r.status)] += 1;
    } else {
      for (const g of grouped ?? []) {
        if ((STATUSES as readonly string[]).includes(g.status)) counts[g.status as ApplicationStatus] = g._count._all;
      }
    }

    const items: AdminAgentApplicationItem[] = rows.map((r) => ({
      id: r.id,
      status: statusOf(r.status),
      warehouseId: r.warehouseId,
      warehouseName: r.warehouseName,
      submittedBy: r.submitterName,
      agentName: r.agentName,
      contactName: r.contactName,
      contactPhone: r.contactPhone,
      loginId: r.loginId,
      remark: r.remark,
      createdAt: r.createdAt.toISOString(),
      reviewedAt: iso(r.reviewedAt),
      reviewedById: r.reviewedById,
      reviewedByName: r.reviewedById ? reviewerName.get(r.reviewedById) ?? null : null,
      rejectReason: r.rejectReason,
      approvedAgentId: r.approvedAgentId,
      approvedLoginId: r.approvedLoginId,
    }));
    ok(res, { items, counts });
  });

  /* ────────────────────────── 通过：当场开代理号 ────────────────────────── */
  app.post("/admin/agents/applications/approve", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const applicationId = str(body.applicationId);
    if (!applicationId) return fail(res, 400, "BAD_REQUEST", "缺少申请编号");

    // 跟 /admin/agents/create 同一份校验（名字、后缀、域名、四档价、账号、密码强度、电话、logo）
    const parsed = parseAgentCreateBody(body);
    if (!parsed.ok) return fail(res, 400, "BAD_REQUEST", parsed.message);
    const input = parsed.input;

    // 早点给个好看的提示；真正说了算的在下面事务里（带条件更新 + 唯一约束）
    const before = await prisma.agentApplication.findFirst({
      where: { id: applicationId, companyId: auth.companyId },
      select: { status: true },
    });
    if (!before) return fail(res, 404, "NOT_FOUND", NOT_FOUND);
    if (before.status !== "pending") return fail(res, 409, "VALIDATION_ERROR", ALREADY_HANDLED);
    const taken = await agentCreateTakenMessage(input);
    if (taken) {
      // 两个超管用同一个预填账号点通过：先到的已经开出了这个账号。后到的这里要说「已经处理过了」，不是「账号被占」（Codex 审查）
      const now = await prisma.agentApplication.findFirst({ where: { id: applicationId, companyId: auth.companyId }, select: { status: true } });
      if (now && now.status !== "pending") return fail(res, 409, "VALIDATION_ERROR", ALREADY_HANDLED);
      return fail(res, 400, "BAD_REQUEST", taken);
    }

    let logoPath: string | null = null;
    if (input.logo) {
      try {
        logoPath = saveImageToDisk("agent_logo", input.logo.mime, input.logo.base64);
      } catch {
        return fail(res, 400, "BAD_REQUEST", "logo 保存失败，请重试");
      }
    }

    let agentId: string;
    try {
      agentId = await prisma.$transaction(
        async (tx: Tx) => {
          // ① 先锁住这张申请、锁里重读再判（CLAUDE.md #28）：两个超管同时点，后到的等前一个提交完，醒来读到的已经不是 pending
          const locked = (await tx.$queryRaw`SELECT status FROM agent_applications WHERE id = ${applicationId} AND company_id = ${auth.companyId} FOR UPDATE`) as Array<{ status: string }>;
          if (!locked[0]) throw new BusinessError(NOT_FOUND, 404, "NOT_FOUND");
          if (locked[0].status !== "pending") throw new BusinessError(ALREADY_HANDLED, 409, "VALIDATION_ERROR");
          const now = new Date();
          // ② 改状态：照旧带上 pending 条件（双保险），改到的必须正好 1 行
          const claimed = await tx.agentApplication.updateMany({
            where: { id: applicationId, companyId: auth.companyId, status: "pending" },
            data: { status: "approved", pendingWarehouseId: null, reviewedById: auth.userId, reviewedAt: now },
          });
          if (claimed.count !== 1) throw new BusinessError(ALREADY_HANDLED, 409, "VALIDATION_ERROR");
          // ③ 建代理 + 登录号（一次嵌套写入；账号 / 后缀 / 域名撞了抛 P2002 → 整个事务回滚，申请还是 pending）
          const created = await tx.agent.create({ data: agentCreateData(auth.companyId, input, logoPath), select: { id: true } });
          // ④ 记下开出来的代理和实际登录账号（照样带公司条件，CLAUDE.md #27）
          const recorded = await tx.agentApplication.updateMany({
            where: { id: applicationId, companyId: auth.companyId },
            data: { approvedAgentId: created.id, approvedLoginId: input.loginId },
          });
          if (recorded.count !== 1) throw new BusinessError(NOT_FOUND, 404, "NOT_FOUND");
          return created.id as string;
        },
        // 等锁 + 干活一共不超过 20 秒：比网页那边 30 秒的超时短，不会出现「网页说超时了、后台其实开好了」
        { timeout: 15_000, maxWait: 5_000 },
      );
    } catch (error) {
      // 只有事务没成才删 logo（事务提交了 logo 就被代理行用着）
      if (logoPath) { try { deleteImageFile(logoPath); } catch { /* ignore */ } }
      const msg = uniqueConflictMessage(error);
      if (msg) return fail(res, 400, "BAD_REQUEST", msg);
      throw error; // 404 / 409 那个 BusinessError 由 server.ts 统一转成响应
    }
    ok(res, { id: applicationId, status: "approved", agentId, loginId: input.loginId });
  });

  /* ────────────────────────── 驳回 ────────────────────────── */
  app.post("/admin/agents/applications/reject", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const applicationId = str(body.applicationId);
    if (!applicationId) return fail(res, 400, "BAD_REQUEST", "缺少申请编号");
    const reason = typeof body.reason === "string" ? body.reason.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim() : "";
    if (!reason) return fail(res, 400, "BAD_REQUEST", "请填驳回原因");
    if (reason.length > REJECT_REASON_MAX) return fail(res, 400, "BAD_REQUEST", `驳回原因太长了（最多 ${REJECT_REASON_MAX} 个字）`);

    // 带条件一条 UPDATE：只有还是 pending 的才改得动，清掉在审标记后这个仓可以再交
    const updated = await prisma.agentApplication.updateMany({
      where: { id: applicationId, companyId: auth.companyId, status: "pending" },
      data: { status: "rejected", pendingWarehouseId: null, rejectReason: reason, reviewedById: auth.userId, reviewedAt: new Date() },
    });
    if (updated.count !== 1) {
      const exists = await prisma.agentApplication.findFirst({ where: { id: applicationId, companyId: auth.companyId }, select: { id: true } });
      return exists ? fail(res, 409, "VALIDATION_ERROR", ALREADY_HANDLED) : fail(res, 404, "NOT_FOUND", NOT_FOUND);
    }
    ok(res, { id: applicationId, status: "rejected" });
  });
}
