import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { checkHold } from "./client";
import { finance2HoldsConfig } from "./config";
import { evaluateRelease, flushHoldLogs, formatListTime, listLabel, loadCandidates, motherOf, noticeFor } from "./gate";
import { readHoldState, writeHoldLogs } from "./store";
import { isSyncRunning, syncHoldList } from "./sync";

/**
 * 放货页上的「扣货名单」那一块用的三个接口（管理员、员工都能用）：
 *   GET  /admin/finance2-holds/status    名单几点的、有没有提示、我最近被拦的几票（带「重新核对」）
 *   POST /admin/finance2-holds/recheck   重新核对：{ trackingNo } —— 实时问财务系统2（约定 5.2、5.3 第 4 条）
 *   POST /admin/finance2-holds/refresh   立即去取一次整份名单（只给管理员）
 * 不返回金额（名单里本来也没有）；客户只显示唛头。
 */

export const FINANCE2_HOLD_PATHS = {
  status: "/admin/finance2-holds/status",
  recheck: "/admin/finance2-holds/recheck",
  refresh: "/admin/finance2-holds/refresh",
} as const;

/** 「我最近被拦的」看多久以内的 */
const RECENT_MS = 2 * 60 * 60 * 1000;

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

export function registerFinance2HoldRoutes(app: MinimalHttpApp): void {
  app.get(FINANCE2_HOLD_PATHS.status, async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;
    const cfg = finance2HoldsConfig();
    if (!cfg) {
      ok(res, { mode: "off" });
      return;
    }
    const now = new Date();
    const state = await readHoldState();
    // 我最近被拦的：按运单号去重，再按现在的名单重新判断一次，已经能放的不列
    const logs = await prisma.finance2HoldLog.findMany({
      where: { operatorId: auth.userId, kind: { in: ["block", "observe"] }, createdAt: { gte: new Date(now.getTime() - RECENT_MS) } },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { trackingNo: true, entry: true, createdAt: true, kind: true },
    });
    const seen = new Map<string, { entry: string | null; at: Date; observed: boolean }>();
    for (const l of logs) if (l.trackingNo && !seen.has(l.trackingNo)) seen.set(l.trackingNo, { entry: l.entry, at: l.createdAt, observed: l.kind === "observe" });
    let recent: Array<{ trackingNo: string; motherTrackingNo: string; customerMark: string; entry: string | null; at: string; observed: boolean }> = [];
    if (seen.size > 0) {
      const ships = await prisma.shipment.findMany({ where: { trackingNo: { in: [...seen.keys()] }, companyId: auth.companyId }, select: { id: true } });
      const verdict = await evaluateRelease(prisma, await loadCandidates(prisma, ships.map((s) => s.id)), now);
      recent = verdict.held.map((h) => {
        const s = seen.get(h.trackingNo)!;
        return { ...h, entry: s.entry, at: s.at.toISOString(), observed: s.observed };
      });
    }
    ok(res, {
      mode: cfg.mode,
      listGeneratedAt: iso(state.generatedAt),
      listLabel: state.generatedAt ? listLabel(state.generatedAt) : null,
      fetchedAt: iso(state.fetchedAt),
      lastError: state.lastError,
      lastErrorAt: iso(state.lastErrorAt),
      lastErrorLabel: state.lastErrorAt ? formatListTime(state.lastErrorAt) : null,
      notice: noticeFor(state.generatedAt, now),
      recent,
    });
  });

  app.post(FINANCE2_HOLD_PATHS.recheck, async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;
    const cfg = finance2HoldsConfig();
    if (!cfg) {
      fail(res, 409, "BAD_REQUEST", "扣货拦截没开，不用核对");
      return;
    }
    const trackingNo = typeof (req.body as { trackingNo?: unknown } | undefined)?.trackingNo === "string"
      ? (req.body as { trackingNo: string }).trackingNo.trim()
      : "";
    if (!trackingNo || trackingNo.length > 128) {
      fail(res, 400, "BAD_REQUEST", "请给运单号");
      return;
    }
    const ship = await prisma.shipment.findFirst({ where: { trackingNo, companyId: auth.companyId }, select: { id: true } });
    if (!ship) {
      fail(res, 404, "NOT_FOUND", "没有这张运单");
      return;
    }
    const [cand] = await loadCandidates(prisma, [ship.id]);
    const before = await evaluateRelease(prisma, [cand]);
    const state = await readHoldState();
    const mark = cand.customerMark;
    const mother = motherOf(cand);
    if (!mark || before.held.length === 0) {
      ok(res, { trackingNo, blocked: false, message: "这票现在不在扣货名单上，可以放货。", listLabel: state.generatedAt ? listLabel(state.generatedAt) : null });
      return;
    }
    const logBase = { kind: "recheck" as const, customerMark: mark, waybillNo: mother, trackingNo, listGeneratedAt: state.generatedAt, operatorId: auth.userId };
    const fallback = state.generatedAt ? listLabel(state.generatedAt) : "按本地名单";

    // 先只问唛头：财务说不扣了 = 这家所有的货都能放；还扣的话再带上这票问一次（老板可能单放了这一票）
    const byMark = await checkHold(cfg, mark, null);
    if (byMark.kind !== "ok") {
      await writeHoldLogs([{ ...logBase, result: "连不上财务系统，继续拦", detail: byMark.reason }]);
      ok(res, { trackingNo, blocked: true, unreachable: true, message: `连不上财务系统，${fallback}继续拦。过一会儿再点一次，或者直接联系财务。` });
      return;
    }
    if (!byMark.value.blocked) {
      await prisma.finance2HoldClear.create({ data: { customerMark: mark, waybillNo: null, operatorId: auth.userId, clearedAt: byMark.value.checkedAt ?? new Date() } });
      await writeHoldLogs([{ ...logBase, result: "财务说这家不扣了，可以放" }]);
      ok(res, { trackingNo, blocked: false, message: `财务系统说 ${mark} 现在不扣货了，这家的货都可以放。请再操作一次（柜子推进时没跟着推的，到尾端派送直接出车）。` });
      return;
    }
    const byWaybill = await checkHold(cfg, mark, mother);
    if (byWaybill.kind !== "ok") {
      await writeHoldLogs([{ ...logBase, result: "唛头还在扣；问单票时连不上，继续拦", detail: byWaybill.reason }]);
      ok(res, { trackingNo, blocked: true, unreachable: true, message: `财务系统说 ${mark} 还在扣货；问这一票时没连上，${fallback}继续拦。` });
      return;
    }
    if (!byWaybill.value.blocked) {
      await prisma.finance2HoldClear.create({ data: { customerMark: mark, waybillNo: mother, operatorId: auth.userId, clearedAt: byWaybill.value.checkedAt ?? new Date() } });
      await writeHoldLogs([{ ...logBase, result: "这家还在扣，这一票可以放" }]);
      ok(res, { trackingNo, blocked: false, message: `财务系统说 ${mark} 还在扣货，但运单 ${mother} 这一票可以放（连同它的子运单）。请再操作一次（柜子推进时没跟着推的，到尾端派送直接出车）。` });
      return;
    }
    await writeHoldLogs([{ ...logBase, result: "财务说还在扣，继续拦" }]);
    ok(res, { trackingNo, blocked: true, message: `财务系统说 ${mark} 还在扣货（刚刚核对的），不能放。请联系财务。` });
  });

  app.post(FINANCE2_HOLD_PATHS.refresh, async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    // 定时任务正在取（可能在等重试，最长两分多钟）：不跟着等，直接说
    if (isSyncRunning()) { fail(res, 409, "BAD_REQUEST", "正在取名单（定时任务在跑），过一两分钟再看"); return; }
    // 按钮上等不了三次重试（最长 2 分半），只试一次
    const outcome = await syncHoldList({ retryDelaysMs: [] });
    await flushHoldLogs();
    if (outcome.kind === "off") { fail(res, 409, "BAD_REQUEST", "扣货拦截没开"); return; }
    if (outcome.kind === "failed") { fail(res, 502, "BAD_REQUEST", `没取到名单，保留上一份：${outcome.reason}`); return; }
    ok(res, outcome);
  });
}
