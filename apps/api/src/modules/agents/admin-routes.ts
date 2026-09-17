/* ==========================================================================
   超管「代理管理」+「返现单」接口（2026-09-16，B2）
   --------------------------------------------------------------------------
   需求：docs/交接文档-附件-代理账号确认单/final.md（不进 git）
     2.1 / 2.7 / 2.8 / 2.9 / 4.2 / 4.12 / 4.13 / 4.20 / 5.5 / 6.1 / 6.4

   ⚠️ 全部接口 requireRole(["admin"])，员工一律 403（4.6：代理和返现只有超管和代理自己能看）。
   ⚠️ 一律按 auth.companyId 过滤，查不到就 404（CLAUDE.md #27）。
   ⚠️ 给前端的字段逐个列出，不许 `...row`（CLAUDE.md #31）。
   ⚠️ **接口不许用 `/admin/agents` 本身**（2026-09-16 页面实测踩到）：那是「代理管理」页面的网址，
      浏览器请求先到 Next，Next 先匹配页面、页面没匹配上才走 next.config.ts 的 /admin/:path* 转发 ——
      同一个网址的接口永远到不了后端，拿回来的是页面 HTML，前端报 invalid response。
      所以列表、开代理用 /admin/agents/list、/admin/agents/create；scripts/test-agent-admin.ts 扫着这条。

   接口：
     GET  /admin/agents/list                代理列表（B1 客户管理「选归属」也读它，只用 id / name）
     POST /admin/agents/create              开代理（agents 行 + users(role=agent) 行，一次嵌套写入 = 一个事务）
     POST /admin/agents/update              改名字 / logo / 前缀 / 域名 / 三档代理价
     POST /admin/agents/login-status        停用 / 启用代理登录号（客户照常登录，2.7）
     POST /admin/agents/reset-password      重置代理密码（卡强度，2.9）
     GET  /admin/agents/rebates             返现单列表（按代理、按月、按状态筛）
     GET  /admin/agents/rebates/detail      返现单明细（4.20）
     POST /admin/agents/rebates/mark-paid   点「已返」（只改状态、时间、操作人，4.12 / 4.13）
     POST /admin/agents/rebates/undo-paid   撤回「已返」（2026-09-18 老板拍板：能撤回，但要写原因、留流水）
   ========================================================================== */

import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { BusinessError } from "../core/business-error";
import { fail, ok, requireRole } from "../core/http-utils";
import { logger } from "../core/logger";
import { clearLoginFailures } from "../core/rate-limit";
import { hashPassword } from "../auth/crypto-utils";
import { checkPasswordStrength } from "../auth/password-policy";
import { deleteImageFile, saveImageToDisk } from "../orders/image-storage";
import { parseWhrPriceInput, REPRICE_PLAN_STATUSES, type WhrPriceTriple } from "../whr-consolidation/long-term-price";
import { loadRebateStatusHistory, REBATE_UNDO_REASON_MAX, writeRebateStatusAudit } from "./rebate-audit";
import { toNum } from "../whr-consolidation/utils";
import {
  isValidMonth,
  normalizeAgentDomain,
  normalizeAgentSlug,
  toCents,
  validateAgentDomain,
  validateAgentLoginId,
  validateAgentLogo,
  validateAgentSlug,
} from "./agent-rules";

type Tx = any;

const PRICE_LABEL: Record<keyof WhrPriceTriple, string> = { normal: "普货", inspection: "商检货", sensitive: "敏感货" };
const fmtPrice = (n: number): string => String(Number(n.toFixed(2)));
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** GET /admin/agents/list 每一行。B1 只用 id / name —— 改字段名前先 grep apps/web */
export interface AdminAgentListItem {
  id: string;
  name: string;
  slug: string | null;
  customDomain: string | null;
  logoUrl: string | null;
  clientCount: number;
  loginId: string;
  loginStatus: "active" | "inactive";
  prices: WhrPriceTriple;
  createdAt: string;
  updatedAt: string;
}

/** Prisma 唯一约束冲突 → 人话 */
function uniqueConflictMessage(error: unknown): string | null {
  const e = error as { code?: string; meta?: { target?: unknown } };
  if (e?.code !== "P2002") return null;
  const target = JSON.stringify(e.meta?.target ?? "");
  if (target.includes("slug")) return "这个前缀已经被别的代理用了，换一个";
  if (target.includes("custom_domain") || target.includes("customDomain")) return "这个专属域名已经被别的代理用了";
  if (target.includes("id")) return "这个登录账号已经有人用了，换一个";
  return "有重复的数据（前缀、域名或登录账号），请检查后再保存";
}

/** 读三档价输入：兼容 { prices: {normal,...} } 和平铺 priceNormal 两种写法 */
function readPrices(body: Record<string, unknown>): WhrPriceTriple {
  const p = (body.prices ?? {}) as Record<string, unknown>;
  return parseWhrPriceInput({
    normal: p.normal ?? body.priceNormal,
    inspection: p.inspection ?? body.priceInspection,
    sensitive: p.sensitive ?? body.priceSensitive,
  });
}

function readLogo(body: Record<string, unknown>): { mime: string; base64: string } | null {
  const logo = body.logo as { mime?: unknown; base64?: unknown } | null | undefined;
  if (!logo || (logo.mime == null && logo.base64 == null)) return null;
  const issue = validateAgentLogo(logo);
  if (issue) throw new BusinessError(issue);
  return { mime: String(logo.mime), base64: String(logo.base64) };
}

/** 报错里最多点名几处，多了整条 400 会变成几千字（CLAUDE.md #21：截断要说清总数） */
const BELOW_LIST_MAX = 10;

/**
 * 调高代理价时，名下哪些客户**在跑的柜里**的单价会低于新代理价（4.2 附带规则 / 4.3）。
 * 只看**调高了的那几档**：没调高的档，客户价本来就不低于它（存价时拦过）。
 * ⚠️ 必须在已经 `SELECT ... FROM agents ... FOR UPDATE` 的事务里调 ——
 *    long-term-price.ts 改客户价时拿同一行的 FOR SHARE，两边排队，不会漏掉正在改的价。
 */
export async function findClientsBelowNewAgentPrice(
  tx: Tx,
  agentId: string,
  companyId: string,
  oldPrices: WhrPriceTriple,
  newPrices: WhrPriceTriple,
): Promise<string[]> {
  const raised = (["normal", "inspection", "sensitive"] as const).filter((k) => toCents(newPrices[k]) > toCents(oldPrices[k]));
  if (raised.length === 0 || !agentId || !companyId) return [];
  /**
   * ⚠️ 2026-09-18 改成查**在跑的柜里当场填的单价**，不再查 `client_whr_prices`。
   * 老板把价格改成「每个柜当场填」之后那张表就冻住了（没人写、写接口也关了），
   * 再拿它判「名下客户价有没有低于新代理价」等于这道闸是空的：
   * 9-18 之后新开的客户根本没有那一行，直接放行 → 代理价一调高，在跑的柜里客户价就低于代理价，
   * 付款照收、返现算成负数被记 0，湘泰每方少收差价（DeepSeek 第二轮复核第 1 条）。
   * 范围就是 `REPRICE_PLAN_STATUSES`（计划中 / 收货中 / 装柜中）—— 跟「哪些柜还能改单价」同一份名单，
   * 免得两处各写一份、改一处漏一处（Opus 第三轮复核第 11 条）。
   *
   * ⚠️ 别照字面理解成「已发运的柜不算」：柜子的 `shipped` 这个状态**全系统没有任何代码会写**
   * （唯一写柜状态的地方是 utils.ts 的 `syncPlanStatus`，它只写 collecting / loading / completed；
   *  发运接口改的是预报单的状态）。所以货已经发运的柜状态还是 `loading`，**照样算在这道闸里**，
   * 一直到每一票都泰国签收、柜子变成 `completed` 才离开。这是**故意偏保守**：
   * 柜子只要还没走完，客户就可能再往里报新单，新单按柜里的单价收钱，低于代理价就是每方少收。
   * （2026-09-18 只读查过生产：柜状态只有 collecting / loading / completed，没有 shipped。）
   */
  const rows: Array<{
    clientId: string;
    unitPriceNormal: unknown;
    unitPriceInspection: unknown;
    unitPriceSensitive: unknown;
    plan: { planNo: string } | null;
    client: { name: string } | null;
  }> = await tx.whrConsolidationPlanCustomer.findMany({
    where: {
      companyId,
      client: { agentId, role: "client", companyId },
      plan: { status: { in: REPRICE_PLAN_STATUSES } },
    },
    select: {
      clientId: true,
      unitPriceNormal: true,
      unitPriceInspection: true,
      unitPriceSensitive: true,
      plan: { select: { planNo: true } },
      client: { select: { name: true } },
    },
    orderBy: [{ clientId: "asc" }, { planId: "asc" }],
  });
  const out: string[] = [];
  for (const r of rows) {
    const current: WhrPriceTriple = { normal: toNum(r.unitPriceNormal), inspection: toNum(r.unitPriceInspection), sensitive: toNum(r.unitPriceSensitive) };
    const parts = raised
      .filter((k) => toCents(current[k]) < toCents(newPrices[k]))
      .map((k) => `${PRICE_LABEL[k]} ${fmtPrice(current[k])}（新代理价 ${fmtPrice(newPrices[k])}）`);
    if (parts.length > 0) {
      const who = r.client?.name && r.client.name !== r.clientId ? `${r.clientId}（${r.client.name}）` : r.clientId;
      const where = r.plan?.planNo ? `柜 ${r.plan.planNo}` : "在跑的柜";
      out.push(`${who} 在${where}：${parts.join("，")}`);
    }
  }
  return out;
}

export function registerAgentAdminRoutes(app: MinimalHttpApp): void {
  /* ────────────────────────── 列表 ────────────────────────── */
  app.get("/admin/agents/list", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const agents = await prisma.agent.findMany({
      where: { companyId: auth.companyId },
      select: {
        id: true, name: true, slug: true, customDomain: true, logoPath: true,
        priceNormal: true, priceInspection: true, priceSensitive: true, createdAt: true, updatedAt: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const ids = agents.map((a) => a.id);
    const users = ids.length === 0
      ? []
      : await prisma.user.findMany({
          where: { companyId: auth.companyId, agentId: { in: ids }, role: { in: ["agent", "client"] } },
          select: { id: true, role: true, status: true, agentId: true, createdAt: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });

    const items: AdminAgentListItem[] = agents.map((a) => {
      const mine = users.filter((u) => u.agentId === a.id);
      // 开代理时一个事务只建一个登录号；万一有多个取最早那个
      const login = mine.find((u) => u.role === "agent");
      return {
        id: a.id,
        name: a.name,
        slug: a.slug,
        customDomain: a.customDomain,
        logoUrl: a.logoPath,
        clientCount: mine.filter((u) => u.role === "client").length,
        loginId: login?.id ?? "",
        loginStatus: login?.status === "active" ? "active" : "inactive",
        prices: { normal: toNum(a.priceNormal), inspection: toNum(a.priceInspection), sensitive: toNum(a.priceSensitive) },
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
      };
    });
    ok(res, { items });
  });

  /* ────────────────────────── 开代理 ────────────────────────── */
  app.post("/admin/agents/create", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const name = str(body.name);
    if (!name) return fail(res, 400, "BAD_REQUEST", "请填代理名字");
    if (name.length > 50) return fail(res, 400, "BAD_REQUEST", "代理名字太长了（最多 50 个字）");

    const slug = normalizeAgentSlug(body.slug);
    const slugIssue = validateAgentSlug(slug);
    if (slugIssue) return fail(res, 400, "BAD_REQUEST", slugIssue);

    const customDomain = normalizeAgentDomain(body.customDomain);
    const domainIssue = validateAgentDomain(customDomain);
    if (domainIssue) return fail(res, 400, "BAD_REQUEST", domainIssue);

    const prices = readPrices(body); // 不合法抛 BusinessError → 400

    const loginId = str(body.loginId);
    const loginIssue = validateAgentLoginId(loginId);
    if (loginIssue) return fail(res, 400, "BAD_REQUEST", loginIssue);

    // 2.9：代理账号能看名下所有客户和返现，密码太简单一律拦
    const password = typeof body.password === "string" ? body.password : "";
    if (!password) return fail(res, 400, "BAD_REQUEST", "请填代理登录密码");
    const weak = checkPasswordStrength(password, undefined, loginId);
    if (weak) return fail(res, 400, "BAD_REQUEST", weak);

    const phone = str(body.phone).slice(0, 40);
    const logo = readLogo(body);

    // 早点给个好看的提示；真正说了算的是数据库唯一约束（下面 catch P2002）
    const [idTaken, slugTaken, domainTaken] = await Promise.all([
      prisma.user.findUnique({ where: { id: loginId }, select: { id: true } }),
      slug ? prisma.agent.findUnique({ where: { slug }, select: { id: true } }) : Promise.resolve(null),
      customDomain ? prisma.agent.findUnique({ where: { customDomain }, select: { id: true } }) : Promise.resolve(null),
    ]);
    if (idTaken) return fail(res, 400, "BAD_REQUEST", "这个登录账号已经有人用了，换一个");
    if (slugTaken) return fail(res, 400, "BAD_REQUEST", "这个前缀已经被别的代理用了，换一个");
    if (domainTaken) return fail(res, 400, "BAD_REQUEST", "这个专属域名已经被别的代理用了");

    let logoPath: string | null = null;
    if (logo) {
      try {
        logoPath = saveImageToDisk("agent_logo", logo.mime, logo.base64);
      } catch {
        return fail(res, 400, "BAD_REQUEST", "logo 保存失败，请重试");
      }
    }

    try {
      /**
       * ⚠️ 代理行和登录号必须同生同死：一次嵌套写入，Prisma 自动包在一个数据库事务里，
       * 登录号建不出来（比如账号撞了）代理行也回滚，不会留下「有代理没登录号」的脏数据。
       * 两行都是全新插入，没有「先读再判」，并发靠唯一约束兜（users.id 主键、agents.slug / custom_domain 唯一）。
       */
      const created = await prisma.agent.create({
        data: {
          companyId: auth.companyId,
          name,
          logoPath,
          slug,
          customDomain,
          priceNormal: prices.normal,
          priceInspection: prices.inspection,
          priceSensitive: prices.sensitive,
          users: {
            create: [{
              id: loginId,
              companyId: auth.companyId,
              role: "agent",
              name,
              phone,
              status: "active",
              warehouseIds: "[]",
              passwordHash: hashPassword(password),
            }],
          },
        },
        select: { id: true },
      });
      ok(res, { id: created.id, loginId });
    } catch (error) {
      if (logoPath) { try { deleteImageFile(logoPath); } catch { /* ignore */ } }
      const msg = uniqueConflictMessage(error);
      if (msg) return fail(res, 400, "BAD_REQUEST", msg);
      throw error;
    }
  });

  /* ────────────────────────── 编辑 ────────────────────────── */
  app.post("/admin/agents/update", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const id = str(body.id);
    if (!id) return fail(res, 400, "BAD_REQUEST", "缺少代理 id");
    const name = str(body.name);
    if (!name) return fail(res, 400, "BAD_REQUEST", "请填代理名字");
    if (name.length > 50) return fail(res, 400, "BAD_REQUEST", "代理名字太长了（最多 50 个字）");

    const slug = normalizeAgentSlug(body.slug);
    const slugIssue = validateAgentSlug(slug);
    if (slugIssue) return fail(res, 400, "BAD_REQUEST", slugIssue);
    const customDomain = normalizeAgentDomain(body.customDomain);
    const domainIssue = validateAgentDomain(customDomain);
    if (domainIssue) return fail(res, 400, "BAD_REQUEST", domainIssue);
    const prices = readPrices(body);
    const logo = readLogo(body);
    const removeLogo = body.removeLogo === true;

    const before = await prisma.agent.findFirst({ where: { id, companyId: auth.companyId }, select: { id: true, logoPath: true } });
    if (!before) return fail(res, 404, "NOT_FOUND", "代理不存在");

    let newLogoPath: string | null = null;
    if (logo) {
      try {
        newLogoPath = saveImageToDisk("agent_logo", logo.mime, logo.base64);
      } catch {
        return fail(res, 400, "BAD_REQUEST", "logo 保存失败，请重试");
      }
    }

    let oldLogoPath: string | null = null;
    try {
      await prisma.$transaction(
        async (tx: Tx) => {
          // 先锁代理行（long-term-price.ts 改客户价拿同一行 FOR SHARE），锁里重读旧价再判
          const lockedRows = await tx.$queryRaw`SELECT id, logo_path, price_normal, price_inspection, price_sensitive FROM agents WHERE id = ${id} AND company_id = ${auth.companyId} FOR UPDATE`;
          const row = (lockedRows as Array<{ logo_path: string | null; price_normal: unknown; price_inspection: unknown; price_sensitive: unknown }>)[0];
          if (!row) throw new BusinessError("代理不存在", 404, "NOT_FOUND");
          const oldPrices: WhrPriceTriple = { normal: toNum(row.price_normal), inspection: toNum(row.price_inspection), sensitive: toNum(row.price_sensitive) };

          const below = await findClientsBelowNewAgentPrice(tx, id, auth.companyId, oldPrices, prices);
          if (below.length > 0) {
            /**
             * ⚠️ 别再写「等这些柜发运完再调」：柜子的 `shipped` 状态没人写，发运完状态还是 `loading`，
             * 按那句话去等会一直等不到（Opus / DeepSeek 第三轮复核第 1 条）。真正的出口有两个：
             * 把柜里的单价改上去，或者等柜子走完（每一票都泰国签收 → 柜子变「已完成」）。
             */
            const shown = below.slice(0, BELOW_LIST_MAX);
            const more = below.length > shown.length ? `；……还有 ${below.length - shown.length} 处（共 ${below.length} 处）` : "";
            throw new BusinessError(
              `调不了：名下有 ${below.length} 处在跑的柜里，客户价比新代理价低。`
                + `请先到「集货拼柜(仓库版)」把这些柜里这位客户的单价改上去（柜详情里点「改单价」），`
                + `或者等这些柜走完（柜里每一票都泰国签收、柜子变成「已完成」）再调代理价 —— `
                + shown.join("；") + more,
            );
          }

          const logoPath = newLogoPath ?? (removeLogo ? null : row.logo_path);
          if (logoPath !== row.logo_path) oldLogoPath = row.logo_path;
          await tx.agent.update({
            where: { id },
            data: {
              name,
              slug,
              customDomain,
              logoPath,
              priceNormal: prices.normal,
              priceInspection: prices.inspection,
              priceSensitive: prices.sensitive,
            },
          });
          return true;
        },
        { timeout: 30_000, maxWait: 10_000 },
      );
    } catch (error) {
      if (newLogoPath) { try { deleteImageFile(newLogoPath); } catch { /* ignore */ } }
      const msg = uniqueConflictMessage(error);
      if (msg) return fail(res, 400, "BAD_REQUEST", msg);
      throw error;
    }
    if (oldLogoPath) { try { deleteImageFile(oldLogoPath); } catch { /* 旧图删不掉不影响保存 */ } }
    ok(res, { id, updated: true });
  });

  /* ────────────────────────── 停用 / 启用登录号 ────────────────────────── */
  app.post("/admin/agents/login-status", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = str(body.id);
    const status = str(body.status);
    if (!id) return fail(res, 400, "BAD_REQUEST", "缺少代理 id");
    if (status !== "active" && status !== "inactive") return fail(res, 400, "BAD_REQUEST", "状态只能是启用或停用");

    const agent = await prisma.agent.findFirst({ where: { id, companyId: auth.companyId }, select: { id: true } });
    if (!agent) return fail(res, 404, "NOT_FOUND", "代理不存在");

    /**
     * 2.7：只停代理自己的登录号（role=agent），名下客户（role=client）一个都不动，照常登录。
     * 直接写目标状态（不是「取反」）：两个人同时点「停用」结果一样，不会一停一启。
     * 停用当场生效：session-guard 每个请求都回查 users.status，不用等令牌过期。
     */
    const updated = await prisma.user.updateMany({
      where: { agentId: id, companyId: auth.companyId, role: "agent" },
      data: { status },
    });
    if (updated.count === 0) return fail(res, 404, "NOT_FOUND", "这个代理没有登录账号");
    ok(res, { id, loginStatus: status });
  });

  /* ────────────────────────── 重置密码 ────────────────────────── */
  app.post("/admin/agents/reset-password", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = str(body.id);
    const password = typeof body.password === "string" ? body.password : "";
    if (!id) return fail(res, 400, "BAD_REQUEST", "缺少代理 id");
    if (!password) return fail(res, 400, "BAD_REQUEST", "请填新密码");

    const login = await prisma.user.findFirst({
      where: { agentId: id, companyId: auth.companyId, role: "agent" },
      select: { id: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (!login) return fail(res, 404, "NOT_FOUND", "代理不存在或没有登录账号");

    const weak = checkPasswordStrength(password, undefined, login.id);
    if (weak) return fail(res, 400, "BAD_REQUEST", weak);

    // 换密码 = 换密码指纹，代理手上旧的登录令牌当场失效（session-guard）
    await prisma.user.update({ where: { id: login.id }, data: { passwordHash: hashPassword(password) } });
    // 被连错锁住时，重置完要能马上用新密码登（跟 /admin/users/set-password 同一口径）
    clearLoginFailures(login.id);
    ok(res, { id, loginId: login.id, updated: true });
  });

  /* ────────────────────────── 返现单列表 ────────────────────────── */
  app.get("/admin/agents/rebates", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const agentId = str(req.query.agentId);
    const month = str(req.query.month);
    const status = str(req.query.status);
    if (month && !isValidMonth(month)) return fail(res, 400, "BAD_REQUEST", "月份格式应为 2026-09 这种");
    if (status && status !== "unpaid" && status !== "paid") return fail(res, 400, "BAD_REQUEST", "状态只能是未返或已返");

    const rows = await prisma.agentRebateStatement.findMany({
      where: {
        companyId: auth.companyId,
        ...(agentId ? { agentId } : {}),
        ...(month ? { month } : {}),
        ...(status ? { status } : {}),
      },
      select: {
        id: true, agentId: true, month: true, lineCount: true, totalVolumeM3: true, totalRebate: true,
        status: true, generatedAt: true, paidAt: true, paidBy: true,
        agent: { select: { name: true } },
      },
      orderBy: [{ month: "desc" }, { agentId: "asc" }],
    });
    ok(res, {
      items: rows.map((r) => ({
        id: r.id,
        agentId: r.agentId,
        agentName: r.agent?.name ?? "",
        month: r.month,
        lineCount: r.lineCount,
        totalVolumeM3: toNum(r.totalVolumeM3),
        totalRebate: toNum(r.totalRebate),
        status: r.status === "paid" ? "paid" : "unpaid",
        generatedAt: r.generatedAt.toISOString(),
        paidAt: iso(r.paidAt),
        // 操作人只给超管看 —— 这一组接口本来就只有超管能进
        paidBy: r.paidBy,
      })),
    });
  });

  /* ────────────────────────── 返现单明细 ────────────────────────── */
  app.get("/admin/agents/rebates/detail", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const id = str(req.query.id);
    if (!id) return fail(res, 400, "BAD_REQUEST", "缺少返现单 id");

    const s = await prisma.agentRebateStatement.findFirst({
      where: { id, companyId: auth.companyId },
      select: {
        id: true, agentId: true, month: true, lineCount: true, totalVolumeM3: true, totalRebate: true,
        status: true, generatedAt: true, paidAt: true, paidBy: true,
        agent: { select: { name: true } },
      },
    });
    if (!s) return fail(res, 404, "NOT_FOUND", "返现单不存在");

    const lines = await prisma.agentRebateLine.findMany({
      where: { statementId: s.id, companyId: auth.companyId },
      orderBy: [{ thailandReceivedAt: "asc" }, { trackingNo: "asc" }],
    });
    // 「已返 / 撤回」的操作流水（2026-09-18）：明细弹窗里直接列出来，不用再多一个接口
    const history = await loadRebateStatusHistory(prisma, auth.companyId, s.id);
    ok(res, {
      history,
      statement: {
        id: s.id,
        agentId: s.agentId,
        agentName: s.agent?.name ?? "",
        month: s.month,
        lineCount: s.lineCount,
        totalVolumeM3: toNum(s.totalVolumeM3),
        totalRebate: toNum(s.totalRebate),
        status: s.status === "paid" ? "paid" : "unpaid",
        generatedAt: s.generatedAt.toISOString(),
        paidAt: iso(s.paidAt),
        paidBy: s.paidBy,
      },
      lines: lines.map((l) => ({
        id: l.id,
        prealertId: l.prealertId,
        trackingNo: l.trackingNo,
        planNo: l.planNo,
        clientId: l.clientId,
        mark: l.mark,
        productNames: l.productNames,
        volumes: { normal: toNum(l.volumeNormalM3), inspection: toNum(l.volumeInspectionM3), sensitive: toNum(l.volumeSensitiveM3) },
        clientPrices: { normal: toNum(l.clientPriceNormal), inspection: toNum(l.clientPriceInspection), sensitive: toNum(l.clientPriceSensitive) },
        agentPrices: { normal: toNum(l.agentPriceNormal), inspection: toNum(l.agentPriceInspection), sensitive: toNum(l.agentPriceSensitive) },
        rebateAmount: toNum(l.rebateAmount),
        prealertCreatedAt: l.prealertCreatedAt.toISOString(),
        signedAt: iso(l.signedAt),
        paidAt: iso(l.paidAt),
        loadedAt: iso(l.loadedAt),
        shippedAt: iso(l.shippedAt),
        thailandReceivedAt: l.thailandReceivedAt.toISOString(),
      })),
    });
  });

  /* ────────────────────────── 已返 ────────────────────────── */
  app.post("/admin/agents/rebates/mark-paid", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = str(body.id);
    if (!id) return fail(res, 400, "BAD_REQUEST", "缺少返现单 id");

    /**
     * 4.12 / 4.13：出了单就不改，「已返」**只改状态、时间、操作人**，金额和明细一个字不动。
     * 条件写在 where 里一句做完（status 还是 unpaid 才改），两个人同时点不会写两次时间。
     */
    const now = new Date();
    const result = await changeRebatePaidStatus(auth, id, "paid", now);
    if (result.notFound) return fail(res, 404, "NOT_FOUND", "返现单不存在");
    if (!result.changed) {
      // 已经是已返：别人刚点过，照实告诉前端，不报错
      return ok(res, { id, status: "paid", paidAt: iso(result.current.paidAt), alreadyPaid: true });
    }
    logger.info("返现单已标记已返", { id, by: auth.userId });
    ok(res, { id, status: "paid", paidAt: now.toISOString(), alreadyPaid: false });
  });

  /* ────────────────────────── 撤回已返 ────────────────────────── */
  /**
   * 2026-09-18 老板拍板：「能撤回，但是能看到记录。应该有流水的」。
   * 只回到「未返」、清掉已返时间和操作人 —— **金额、方数、明细一个字不动**（还是 4.12 / 4.13 的规矩：出了单就不改）。
   * 必须写一句原因，跟点「已返」一起记进 audit_logs（rebate-audit.ts），明细弹窗里能看到整条流水。
   * 撤回后代理端那张单也跟着变回「未返」（他本来就看得到状态）；流水是内部记录，代理端不下发。
   */
  app.post("/admin/agents/rebates/undo-paid", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = str(body.id);
    if (!id) return fail(res, 400, "BAD_REQUEST", "缺少返现单 id");
    const reason = str(body.reason); // str() 本身就去两头空格
    if (!reason) return fail(res, 400, "BAD_REQUEST", "撤回要写一句原因（比如「转错账号」），会记进操作记录");
    if (reason.length > REBATE_UNDO_REASON_MAX) {
      return fail(res, 400, "BAD_REQUEST", `原因最多 ${REBATE_UNDO_REASON_MAX} 个字`);
    }

    const result = await changeRebatePaidStatus(auth, id, "unpaid", null, reason);
    if (result.notFound) return fail(res, 404, "NOT_FOUND", "返现单不存在");
    if (!result.changed) {
      // 已经是未返（别人刚撤过）：照实说，不报错、也不再写一条流水
      return ok(res, { id, status: "unpaid", alreadyUnpaid: true });
    }
    logger.info("返现单撤回已返", { id, by: auth.userId });
    ok(res, { id, status: "unpaid", alreadyUnpaid: false });
  });
}

/**
 * 「已返」和「撤回已返」共用这一段：锁住这张单 → 锁后重新读 → 状态真要变才写 → 同一个事务里记流水。
 * ⚠️ 先锁再读（CLAUDE.md #28）：两个人同时点时，流水里记的「改之前是什么样」才是真的。
 */
async function changeRebatePaidStatus(
  auth: { companyId: string; userId: string; role: string },
  id: string,
  want: "paid" | "unpaid",
  paidAt: Date | null,
  reason?: string,
): Promise<
  | { notFound: true; changed: false; current: { status: string; paidAt: Date | null } }
  | { notFound: false; changed: boolean; current: { status: string; paidAt: Date | null } }
> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; company_id: string; status: string; paid_at: Date | null; paid_by: string | null }>>`
      SELECT id, company_id, status, paid_at, paid_by FROM agent_rebate_statements WHERE id = ${id} AND company_id = ${auth.companyId} FOR UPDATE`;
    const row = locked[0];
    if (!row) return { notFound: true as const, changed: false as const, current: { status: "", paidAt: null } };
    const current = { status: row.status, paidAt: row.paid_at ?? null };
    /**
     * 只认「未返 → 已返」和「已返 → 未返」这两步。今天 status 只有这两种值，
     * 但以后要是加了第三种（作废之类），别让这里把它静默改成已返（Opus 复核 2026-09-18 第 7 条）。
     */
    const from = want === "paid" ? "unpaid" : "paid";
    if (row.status !== from) return { notFound: false as const, changed: false as const, current };

    const statement = await tx.agentRebateStatement.findFirst({
      where: { id, companyId: auth.companyId },
      select: { month: true, agentId: true, totalRebate: true },
    });
    if (!statement) return { notFound: true as const, changed: false as const, current };

    const updated = await tx.agentRebateStatement.updateMany({
      where: { id, companyId: auth.companyId, status: row.status },
      data: { status: want, paidAt, paidBy: want === "paid" ? auth.userId : null },
    });
    if (updated.count === 0) return { notFound: false as const, changed: false as const, current };

    await writeRebateStatusAudit(tx, {
      companyId: auth.companyId,
      actorId: auth.userId,
      actorRole: auth.role,
      statementId: id,
      before: { status: row.status, paidAt: row.paid_at ?? null, paidBy: row.paid_by ?? null },
      after: { status: want, paidAt, paidBy: want === "paid" ? auth.userId : null },
      month: statement.month,
      agentId: statement.agentId,
      totalRebate: toNum(statement.totalRebate),
      reason,
    });
    return { notFound: false as const, changed: true as const, current };
  // 拿行锁的事务都显式给超时（库里另外 7 处同写法，默认 5s/2s 在远端库上偏紧）
  }, { timeout: 30000, maxWait: 10000 });
}
