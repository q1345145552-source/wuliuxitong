/* ==========================================================================
   给财务系统2 的只读接口（2026-11-19，第 7 期物流这一边）
   --------------------------------------------------------------------------
   约定：财务系统2 项目 docs/物流系统接口约定.md（第二版）第 1、2 节；本仓库核对 docs/finance2-对接-核对.md。

   铁规矩（改这个文件前逐条看）：
   1. 只读。查库全在 readOnlySnapshot（数据库只读事务）里；不往任何表写东西。「改过」靠迁移里的触发器记，这里只读那张表。
   2. 密钥只认指纹（api-key.ts），不打日志；不对一律 401，不说是哪一种不对。没配齐 503。
   3. 只看 FINANCE2_COMPANY_ID 那一家。
   4. 返回的字段在 views.ts 逐个列，不许 `...row`；金额体积重量尺寸是字符串，时间带 Z，null 不省略。
   5. 响应不走 ok() 那层 `{code, data}` 外壳：约定 2.8 定的是 `{serverTime, items, nextCursor, hasMore}`，
      出错是 `{error, message}`（server.ts 只给带 code 的响应体盖章，这里的不受影响）。
   6. 原来给海外仓财务系统的 /integrations/finance/v1/… 一个字不动。
   ========================================================================== */

import type { HttpRequest, HttpResponse, MinimalHttpApp } from "../../server";
import { logger } from "../core/logger";
import { bearerKeyMatchesAny } from "./api-key";
import { finance2Config, type Finance2Config } from "./config";
import { capToHorizon, dbNow, latestChangeOf, listChanges, listNumbers, loadWaybills, motherNoOf, readOnlySnapshot, stableHorizon } from "./load";
import {
  FINANCE2_AGENT_CHANGES_PATH,
  FINANCE2_AGENTS_PATH,
  FINANCE2_CHANGES_PATH,
  FINANCE2_CUSTOMERS_PATH,
  FINANCE2_NUMBERS_PATH,
  FINANCE2_WAYBILL_ITEM_ROUTE,
  finance2WaybillNoFromPath,
} from "./paths";
import { decodeCursor, encodeCursor, mapAgent, mapCustomer, parseZonedTime } from "./views";

const LIMIT_DEFAULT = 200;
const LIMIT_MAX = 500;

/** 出错也带 serverTime（约定 1.3「每个响应都带」）。用本机时钟：密钥不对、数据库不可用时不为了取时间再去查库（Codex 第二次审查第 5 条） */
function sendError(res: HttpResponse, status: number, error: string, message: string): void {
  res.status(status).json({ serverTime: new Date().toISOString(), error, message });
}

/** 开关（配齐没有）→ 密钥。都过才给配置 */
function requireFinance2(req: HttpRequest, res: HttpResponse): Finance2Config | null {
  const cfg = finance2Config();
  if (!cfg) { sendError(res, 503, "disabled", "财务系统2 对接没有打开"); return null; }
  if (!bearerKeyMatchesAny(req.headers.authorization, cfg.fingerprints)) {
    // 只记路径，不记请求头
    logger.warn("财务系统2 接口：密钥不对", { path: req.path });
    sendError(res, 401, "unauthorized", "密钥不对");
    return null;
  }
  return cfg;
}

/** limit：没传给默认；传了必须是 1～500 的整数，否则 400 */
function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined) return LIMIT_DEFAULT;
  if (!/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= LIMIT_MAX ? n : null;
}

/** 多查一条看有没有下一页 */
function page<T>(rows: T[], limit: number): { items: T[]; hasMore: boolean } {
  return rows.length > limit ? { items: rows.slice(0, limit), hasMore: true } : { items: rows, hasMore: false };
}

export function registerFinance2Routes(app: MinimalHttpApp): void {
  /* ===== 2.1 取 since 之后新增或改过的运单（含取消、删除） ===== */
  app.get(FINANCE2_CHANGES_PATH, async (req, res) => {
    const cfg = requireFinance2(req, res);
    if (!cfg) return;
    const since = parseZonedTime(req.query.since);
    if (!since) { sendError(res, 400, "bad_request", "since 必须是带时区的时间，比如 2026-11-18T07:05:00.000Z"); return; }
    const limit = parseLimit(req.query.limit);
    if (limit === null) { sendError(res, 400, "bad_request", `limit 要是 1～${LIMIT_MAX} 的整数`); return; }
    let cursor: { t: Date; w: string } | null = null;
    if (req.query.cursor !== undefined) {
      const c = decodeCursor(req.query.cursor, ["t", "w"]);
      const t = c ? parseZonedTime(c.t) : null;
      if (!c || !t) { sendError(res, 400, "bad_request", "cursor 不对，请原样带回上一页给的 nextCursor"); return; }
      cursor = { t, w: c.w };
    }

    const body = await readOnlySnapshot(async (tx) => {
      // serverTime 先取：这一刻以后提交的改动时间一定不早于它往回 10 分钟（财务下一轮从这里往回拉）
      const serverTime = await dbNow(tx);
      const horizon = await stableHorizon(tx);
      const { items: rows, hasMore } = page(await listChanges(tx, cfg.companyId, since, cursor, limit + 1, horizon), limit);
      const items = await loadWaybills(tx, cfg.companyId, rows);
      const last = rows[rows.length - 1];
      return {
        serverTime: serverTime.toISOString(),
        items,
        nextCursor: hasMore && last ? encodeCursor({ t: last.changedAt.toISOString(), w: last.waybillNo }) : null,
        hasMore,
      };
    });
    res.status(200).json(body);
  });

  /* ===== 2.1 列运单号和最后改动时间（对账） ===== */
  app.get(FINANCE2_NUMBERS_PATH, async (req, res) => {
    const cfg = requireFinance2(req, res);
    if (!cfg) return;
    const from = parseZonedTime(req.query.createdFrom);
    if (!from) { sendError(res, 400, "bad_request", "createdFrom 必须是带时区的时间"); return; }
    let to: Date | null = null;
    if (req.query.createdTo !== undefined) {
      to = parseZonedTime(req.query.createdTo);
      if (!to || to <= from) { sendError(res, 400, "bad_request", "createdTo 必须是带时区的时间，并且晚于 createdFrom"); return; }
    }
    const limit = parseLimit(req.query.limit);
    if (limit === null) { sendError(res, 400, "bad_request", `limit 要是 1～${LIMIT_MAX} 的整数`); return; }
    let cursor: { c: Date; w: string } | null = null;
    if (req.query.cursor !== undefined) {
      const c = decodeCursor(req.query.cursor, ["c", "w"]);
      const t = c ? parseZonedTime(c.c) : null;
      if (!c || !t) { sendError(res, 400, "bad_request", "cursor 不对，请原样带回上一页给的 nextCursor"); return; }
      cursor = { c: t, w: c.w };
    }

    const body = await readOnlySnapshot(async (tx) => {
      const serverTime = await dbNow(tx);
      const horizon = await stableHorizon(tx);
      const { items: rows, hasMore } = page(await listNumbers(tx, cfg.companyId, from, to, cursor, limit + 1), limit);
      const last = rows[rows.length - 1];
      return {
        serverTime: serverTime.toISOString(),
        items: rows.map((r) => ({ waybillNo: r.waybillNo, changedAt: capToHorizon(r.changedAt, horizon).toISOString(), deletedAt: null })),
        nextCursor: hasMore && last ? encodeCursor({ c: last.createdAt.toISOString(), w: last.waybillNo }) : null,
        hasMore,
      };
    });
    res.status(200).json(body);
  });

  /* ===== 2.1 取一票（母运单号；传子运单号也认，返回它所属的那一票）。删掉的给删除记录，从来没有过的 404 ===== */
  app.get(FINANCE2_WAYBILL_ITEM_ROUTE, async (req, res) => {
    const cfg = requireFinance2(req, res);
    if (!cfg) return;
    const no = finance2WaybillNoFromPath(req.path);
    if (!no) { sendError(res, 400, "bad_request", "运单号不对"); return; }

    const body = await readOnlySnapshot(async (tx) => {
      const serverTime = await dbNow(tx);
      const waybillNo = (await motherNoOf(tx, cfg.companyId, no)) ?? no;
      const horizon = await stableHorizon(tx);
      const latest = await latestChangeOf(tx, cfg.companyId, waybillNo);
      // 还没稳定的改动（见 stableHorizon）：changedAt 报成稳定线前 1 毫秒，以后稳定下来的版本一定比它新
      const changedAt = latest ? capToHorizon(latest.changedAt, horizon) : null;
      const deletedAt = latest?.deletedAt && changedAt && latest.deletedAt > changedAt ? changedAt : latest?.deletedAt ?? null;
      const [item] = await loadWaybills(tx, cfg.companyId, [{ waybillNo, changedAt, deletedAt }]);
      // 母运单不在、改动记录里也从来没有这个号 = 从来没有过
      if (item.deletedAt !== null && !latest) return null;
      return { serverTime: serverTime.toISOString(), item };
    });
    if (!body) { sendError(res, 404, "not_found", "没有这个运单号"); return; }
    res.status(200).json(body);
  });

  /* ===== 2.7 全部客户（整份，分页，按唛头排） ===== */
  app.get(FINANCE2_CUSTOMERS_PATH, async (req, res) => {
    const cfg = requireFinance2(req, res);
    if (!cfg) return;
    const limit = parseLimit(req.query.limit);
    if (limit === null) { sendError(res, 400, "bad_request", `limit 要是 1～${LIMIT_MAX} 的整数`); return; }
    let after: string | null = null;
    if (req.query.cursor !== undefined) {
      const c = decodeCursor(req.query.cursor, ["m"]);
      if (!c) { sendError(res, 400, "bad_request", "cursor 不对，请原样带回上一页给的 nextCursor"); return; }
      after = c.m;
    }
    const body = await readOnlySnapshot(async (tx) => {
      const serverTime = await dbNow(tx);
      const users = await tx.user.findMany({
        where: { companyId: cfg.companyId, role: "client", ...(after !== null ? { id: { gt: after } } : {}) },
        orderBy: { id: "asc" },
        take: limit + 1,
        select: { id: true, name: true, agentId: true, status: true },
      });
      const { items, hasMore } = page(users, limit);
      const last = items[items.length - 1];
      return {
        serverTime: serverTime.toISOString(),
        items: items.map(mapCustomer),
        nextCursor: hasMore && last ? encodeCursor({ m: last.id }) : null,
        hasMore,
      };
    });
    res.status(200).json(body);
  });

  /* ===== 约定以外多给的：客户换代理的记录（2026-11-19 起由触发器记，按时间排） ===== */
  app.get(FINANCE2_AGENT_CHANGES_PATH, async (req, res) => {
    const cfg = requireFinance2(req, res);
    if (!cfg) return;
    const since = parseZonedTime(req.query.since);
    if (!since) { sendError(res, 400, "bad_request", "since 必须是带时区的时间"); return; }
    const limit = parseLimit(req.query.limit);
    if (limit === null) { sendError(res, 400, "bad_request", `limit 要是 1～${LIMIT_MAX} 的整数`); return; }
    let afterId: bigint | null = null;
    if (req.query.cursor !== undefined) {
      const c = decodeCursor(req.query.cursor, ["i"]);
      if (!c || !/^\d{1,18}$/.test(c.i)) { sendError(res, 400, "bad_request", "cursor 不对，请原样带回上一页给的 nextCursor"); return; }
      afterId = BigInt(c.i);
    }
    const body = await readOnlySnapshot(async (tx) => {
      const serverTime = await dbNow(tx);
      const rows = await tx.finance2CustomerAgentChange.findMany({
        where: { companyId: cfg.companyId, changedAt: { gt: since }, ...(afterId !== null ? { id: { gt: afterId } } : {}) },
        orderBy: { id: "asc" },
        take: limit + 1,
        select: { id: true, customerMark: true, fromAgentId: true, toAgentId: true, changedAt: true },
      });
      const { items, hasMore } = page(rows, limit);
      const last = items[items.length - 1];
      return {
        serverTime: serverTime.toISOString(),
        items: items.map((r) => ({ customerMark: r.customerMark, fromAgentId: r.fromAgentId, toAgentId: r.toAgentId, changedAt: r.changedAt.toISOString() })),
        nextCursor: hasMore && last ? encodeCursor({ i: last.id.toString() }) : null,
        hasMore,
      };
    });
    res.status(200).json(body);
  });

  /* ===== 2.7 全部代理（很少，整份给） ===== */
  app.get(FINANCE2_AGENTS_PATH, async (req, res) => {
    const cfg = requireFinance2(req, res);
    if (!cfg) return;
    const body = await readOnlySnapshot(async (tx) => {
      const serverTime = await dbNow(tx);
      const agents = await tx.agent.findMany({ where: { companyId: cfg.companyId }, orderBy: { id: "asc" }, select: { id: true, name: true } });
      return { serverTime: serverTime.toISOString(), items: agents.map(mapAgent) };
    });
    res.status(200).json(body);
  });
}
