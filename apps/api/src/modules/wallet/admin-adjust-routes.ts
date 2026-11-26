/* ==========================================================================
   客户余额：管理员加 / 减 / 冲掉，员工和管理员按客户看流水（2026-11-27，财务系统2 ADR 0191 第 2 轮）
   --------------------------------------------------------------------------
   老板定：客户线下转钱，管理员在后台手动给客户加金额，「加了就算数」，系统不再核对；
   现有「集货余额」就是客户唯一的「余额」（集货拼柜当场扣，财务系统2 的运费账单也从这里扣）。
   方案第五节：加错了只能整笔冲掉（不能改数、不能冲一部分、一笔只能冲一次，必须写原因，不够冲照冲成负数）；
   把钱退给客户用「减金额」（必须写原因，不能减成负数）；只有管理员能加减冲，员工只能看。

   防重复（这一轮最要紧的一处）：
     弹窗每打开一次，页面生成一个一次性提交编号（submitKey）。后端事务第一句拿这个编号的排队锁（咨询锁 83093 + 编号哈希，
     lockWalletAdjustSubmit），锁里查这个编号办过没有：办过 → 不再动钱，内容一样原样回第一次的结果（duplicate），不一样 409；
     没办过才动钱，并在同一个事务里把编号写进 wallet_adjustments（submit_key / reverse_submit_key 都是唯一的，兜底）。
     冲掉还要锁住那张调整单再看「冲过没有」：两个管理员各点各的（编号不同），只有先到的那个冲得掉。
   钱一律走 wallet/consolidation-balance.ts 的 adminTopup / adminDeduct / adminReverseTopup（锁和读同一句、Decimal、锁里判断）。
   锁序：提交编号排队锁 →（冲掉：调整单行）→ 钱包行，跟集货「单据 → 钱包」同向。

   客户看得到：流水的备注（= 管理员写的备注 / 原因）在 /client/wallet/ledger 照旧抹柜号、去掉开头的「管理员」。
   操作人（谁加的、谁冲的）只给管理员看（core/operator-visibility.ts）。水单图不进列表，单独接口取，只给管理员。
   推送：这几个接口路径带 /wallet/，server.ts 自动推「wallet」；请求里带 clientId，publish.ts 只推给这一个客户。
   ========================================================================== */
import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { canSeeOperatorIdentity, hideOperatorInRemark, operatorNameForDisplay } from "../core/operator-visibility";
import {
  ADMIN_ADJUST_REF_TYPE,
  adminDeduct,
  adminReverseTopup,
  adminTopup,
  CONSOLIDATION_CURRENCY,
  InsufficientBalanceError,
} from "./consolidation-balance";

type Tx = Prisma.TransactionClient;

/** 咨询锁的号段：接着 finance2-balance/ops.ts 那一把（REQUEST_LOCK_KEY）往下排 */
const SUBMIT_LOCK_KEY = 83093;
/** 一次性提交编号：页面用 crypto.randomUUID() 生成，这里只认字母数字 - _，16～64 位 */
const SUBMIT_KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** 金额：大于 0、最多两位小数，整数部分最多 12 位（库里 Decimal(14,2)） */
const AMOUNT_RE = /^(0|[1-9]\d{0,11})(\.\d{1,2})?$/;
const TEXT_MAX = 200;
/** 水单图：照 /client/wallet/recharge 那套（client-compliance/routes.ts）——只认图片 data URL 和站内 /images/，8MB 以内 */
const PROOF_MAX = 8 * 1024 * 1024;
const PAGE_SIZE_MAX = 500;

/**
 * 同一个提交编号排队（事务结束自动放）。必须是事务第一句、手里还没有别的锁。
 * scripts/test-lock-order.ts 的 LOCK_HELPERS 登记了它（advisory_wallet_adjust_submit），第 10 项会来核锁真的在。
 */
export async function lockWalletAdjustSubmit(tx: Tx, submitKey: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SUBMIT_LOCK_KEY}::int, hashtext(${submitKey}))`;
}

/** 金额：字符串或数字都收，一律按字符串核格式（不经过浮点算）；不合格给 null */
export function parseAdjustAmount(raw: unknown): Prisma.Decimal | null {
  const s = typeof raw === "string" ? raw.trim() : typeof raw === "number" && Number.isFinite(raw) ? String(raw) : null;
  if (s === null || !AMOUNT_RE.test(s)) return null;
  const d = new Prisma.Decimal(s);
  return d.gt(0) ? d : null;
}

/** 备注 / 原因：去首尾空白；超长、带控制字符（换行除外）给 false */
export function parseAdjustText(raw: unknown): { ok: true; text: string } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, text: "" };
  if (typeof raw !== "string") return { ok: false };
  const t = raw.trim();
  if (t.length > TEXT_MAX || /[\x00-\x09\x0b-\x1f\x7f]/.test(t)) return { ok: false };
  return { ok: true, text: t };
}

/** 水单图格式（防在管理员页面里执行脚本，同客户充值凭证那道闸）。空 = 没传 */
export function proofImageIssue(proof: string): string | null {
  if (!proof) return null;
  const isDataImage = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/=\s]+$/.test(proof);
  // 站内路径：只许一段文件名，不许 .. / 以点开头（2026-11-27 审查）
  const isLocalPath = /^\/images\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(proof) && !proof.includes("..");
  if (!isDataImage && !isLocalPath) return "水单格式不对，请重新上传图片";
  if (proof.length > PROOF_MAX) return "水单图片过大，请压缩后再上传";
  return null;
}

function newAdjustmentId(): string {
  return `adj_${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
}

/**
 * 调整单要读的列。⚠️ 不读 proof_image（水单原图，最大 8MB）：要知道「有没有水单」「水单跟这次传的一样不一样」，
 * 一律在库里算（proofFacts），不把整列读出来（CLAUDE.md 第 3 条，2026-11-27 审查）。
 */
const ADJ_SELECT = {
  id: true,
  kind: true,
  clientId: true,
  amount: true,
  remark: true,
  submitKey: true,
  ledgerId: true,
  balanceAfter: true,
  createdAt: true,
  reversedAt: true,
  reverseReason: true,
  reverseSubmitKey: true,
  reverseBalanceAfter: true,
} satisfies Prisma.WalletAdjustmentSelect;
type AdjRow = Prisma.WalletAdjustmentGetPayload<{ select: typeof ADJ_SELECT }>;

/** 在库里比水单：这一张有没有水单、跟这次传来的（空串当没传）是不是同一张。不把原图读出来 */
async function proofFacts(db: Tx | typeof prisma, adjustmentId: string, given: string): Promise<{ hasProof: boolean; sameProof: boolean }> {
  const rows = await db.$queryRaw<Array<{ has_proof: boolean; same_proof: boolean }>>`
    SELECT proof_image IS NOT NULL AS has_proof, proof_image IS NOT DISTINCT FROM ${given || null}::text AS same_proof
    FROM wallet_adjustments WHERE id = ${adjustmentId}
  `;
  return { hasProof: !!rows[0]?.has_proof, sameProof: !!rows[0]?.same_proof };
}

/** 加 / 减办完回给页面的（逐个字段列，不带水单图） */
function adjustReply(a: AdjRow, hasProof: boolean, duplicate: boolean) {
  return {
    adjustment: {
      id: a.id,
      kind: a.kind,
      clientId: a.clientId,
      amount: Number(a.amount),
      remark: a.remark ?? "",
      hasProof,
      createdAt: a.createdAt.toISOString(),
    },
    balanceAfter: Number(a.balanceAfter),
    duplicate,
  };
}

/**
 * 这几个事务里的等待都要有头（2026-11-27 审查第 4 条）：等锁（提交编号排队锁、调整单行锁、钱包行锁）最多 LOCK_WAIT，
 * 单条语句最多 STATEMENT_MAX；到点数据库自己撒手、事务回滚、接口回 503「系统忙」，连接还回连接池。
 * Prisma 的事务时限到点不一定能打断正在等锁的那一句 SQL，所以用数据库自己的 lock_timeout / statement_timeout。
 * 管理员页面拿到 503 会提示「不确定办成没有」、用同一个提交编号原样重试，不会加两遍。
 */
const ADMIN_TX = { maxWait: 3_000, timeout: 12_000 } as const;
async function limitWaits(tx: Tx): Promise<void> {
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
  await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '8s'");
}

/** 等锁 / 语句超时、事务时限到了：回 503 让人过一会儿原样再点（钱没动） */
export function isBusyError(error: unknown): boolean {
  const e = error as { code?: string; message?: string; meta?: { code?: unknown } } | null;
  const text = `${e?.code ?? ""} ${JSON.stringify(e?.meta ?? {})} ${e?.message ?? ""}`;
  return /55P03|57014|P2024|P2028|lock timeout|statement timeout|canceling statement|Transaction already closed|expired transaction/i.test(text);
}

type CreateOutcome =
  | { kind: "done"; row: AdjRow; hasProof: boolean; duplicate: boolean }
  | { kind: "conflict" }
  | { kind: "noClient" }
  | { kind: "insufficient"; have: number; need: number }
  | { kind: "busy" };

/** 加金额 / 减金额：一个事务办完（见文件头「防重复」） */
async function runCreate(
  auth: { companyId: string; userId: string; name: string },
  input: { kind: "topup" | "deduction"; clientId: string; amount: Prisma.Decimal; remark: string; proofImage: string; submitKey: string },
): Promise<CreateOutcome> {
  /** 这个编号办过没有：办过的内容跟这次一样 → 原样回（duplicate）；不一样 → 冲突。还要看这个编号有没有被拿去冲掉过（不许一号两用） */
  const lookupDuplicate = async (db: Tx | typeof prisma): Promise<CreateOutcome | null> => {
    const usedForReverse = await db.walletAdjustment.findUnique({ where: { reverseSubmitKey: input.submitKey }, select: { id: true } });
    if (usedForReverse) return { kind: "conflict" };
    const seen = await db.walletAdjustment.findUnique({ where: { submitKey: input.submitKey }, select: { ...ADJ_SELECT, companyId: true } });
    if (!seen) return null;
    const proof = await proofFacts(db, seen.id, input.proofImage);
    const same = seen.companyId === auth.companyId && seen.kind === input.kind && seen.clientId === input.clientId
      && new Prisma.Decimal(seen.amount).eq(input.amount) && (seen.remark ?? "") === input.remark && proof.sameProof;
    return same ? { kind: "done", row: seen, hasProof: proof.hasProof, duplicate: true } : { kind: "conflict" };
  };
  try {
    return await prisma.$transaction(async (tx) => {
      await limitWaits(tx);
      await lockWalletAdjustSubmit(tx, input.submitKey);
      const dup = await lookupDuplicate(tx);
      if (dup) return dup;
      // 客户：这家公司的客户角色（封禁的也算，钱还是他的）
      const client = await tx.user.findFirst({ where: { id: input.clientId, companyId: auth.companyId, role: "client" }, select: { id: true } });
      if (!client) return { kind: "noClient" as const };

      const id = newAdjustmentId();
      const moveArgs = {
        companyId: auth.companyId,
        clientId: client.id,
        amount: input.amount,
        adjustmentId: id,
        remark: input.remark || null,
        operatorId: auth.userId,
        operatorName: auth.name || auth.userId,
      };
      const moved = input.kind === "topup" ? await adminTopup(tx, moveArgs) : await adminDeduct(tx, moveArgs);
      const row = await tx.walletAdjustment.create({
        data: {
          id,
          companyId: auth.companyId,
          clientId: client.id,
          kind: input.kind,
          amount: input.amount,
          remark: input.remark || null,
          proofImage: input.proofImage || null,
          submitKey: input.submitKey,
          operatorId: auth.userId,
          operatorName: auth.name || auth.userId,
          ledgerId: moved.ledgerId!,
          balanceAfter: moved.balanceAfter,
        },
        select: ADJ_SELECT,
      });
      return { kind: "done" as const, row, hasProof: !!input.proofImage, duplicate: false };
    }, ADMIN_TX);
  } catch (error) {
    // 减成负数：钱包那边抛的，事务已经整个回滚（一分没动、编号没登记）
    if (error instanceof InsufficientBalanceError) return { kind: "insufficient", have: error.have, need: error.need };
    // 兜底：排队锁没起作用、同一个编号两个都走到写那一步，后写的撞唯一约束整个回滚 —— 按先写的那条回
    if (isUniqueOn(error, "submit_key")) return (await lookupDuplicate(prisma)) ?? { kind: "conflict" };
    if (isBusyError(error)) return { kind: "busy" };
    throw error;
  }
}

function isUniqueOn(error: unknown, column: string): boolean {
  const e = error as { code?: string; meta?: { target?: unknown } } | null;
  if (e?.code !== "P2002") return false;
  const target = JSON.stringify(e.meta?.target ?? "");
  return target.includes(column) || target.includes(column.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()));
}

type ReverseOutcome =
  | { kind: "done"; row: AdjRow; duplicate: boolean }
  | { kind: "conflict" }
  | { kind: "notFound" }
  | { kind: "notTopup" }
  | { kind: "wrongClient" }
  | { kind: "alreadyReversed"; at: Date; reason: string }
  | { kind: "busy" };

/** 冲掉一笔管理员充值 */
async function runReverse(
  auth: { companyId: string; userId: string; name: string },
  input: { adjustmentId: string; clientId: string; reason: string; submitKey: string },
): Promise<ReverseOutcome> {
  const lookupDuplicate = async (db: Tx | typeof prisma): Promise<ReverseOutcome | null> => {
    // 这个编号被拿去加 / 减过：不许再拿来冲掉（一号两用，2026-11-27 审查）
    const usedForCreate = await db.walletAdjustment.findUnique({ where: { submitKey: input.submitKey }, select: { id: true } });
    if (usedForCreate) return { kind: "conflict" };
    const seen = await db.walletAdjustment.findUnique({ where: { reverseSubmitKey: input.submitKey }, select: { ...ADJ_SELECT, companyId: true } });
    if (!seen) return null;
    const same = seen.companyId === auth.companyId && seen.id === input.adjustmentId && seen.clientId === input.clientId && (seen.reverseReason ?? "") === input.reason;
    return same ? { kind: "done", row: seen, duplicate: true } : { kind: "conflict" };
  };
  try {
    return await prisma.$transaction(async (tx) => {
      await limitWaits(tx);
      await lockWalletAdjustSubmit(tx, input.submitKey);
      const dup = await lookupDuplicate(tx);
      if (dup) return dup;
      // 锁住这张调整单再看「冲过没有」（CLAUDE.md 第 28 条：锁后重读）
      await tx.$queryRaw`SELECT id FROM wallet_adjustments WHERE id = ${input.adjustmentId} AND company_id = ${auth.companyId} FOR UPDATE`;
      const adj = await tx.walletAdjustment.findFirst({
        where: { id: input.adjustmentId, companyId: auth.companyId },
        select: { ...ADJ_SELECT, companyId: true },
      });
      if (!adj) return { kind: "notFound" as const };
      if (adj.kind !== "topup") return { kind: "notTopup" as const };
      if (adj.clientId !== input.clientId) return { kind: "wrongClient" as const };
      if (adj.reversedAt) return { kind: "alreadyReversed" as const, at: adj.reversedAt, reason: adj.reverseReason ?? "" };

      const moved = await adminReverseTopup(tx, {
        companyId: auth.companyId,
        clientId: adj.clientId,
        amount: adj.amount,
        adjustmentId: adj.id,
        remark: input.reason,
        operatorId: auth.userId,
        operatorName: auth.name || auth.userId,
      });
      const row = await tx.walletAdjustment.update({
        where: { id: adj.id },
        data: {
          reversedAt: new Date(),
          reversedById: auth.userId,
          reversedByName: auth.name || auth.userId,
          reverseReason: input.reason,
          reversalLedgerId: moved.ledgerId!,
          reverseSubmitKey: input.submitKey,
          reverseBalanceAfter: moved.balanceAfter,
        },
        select: ADJ_SELECT,
      });
      return { kind: "done" as const, row, duplicate: false };
    }, ADMIN_TX);
  } catch (error) {
    if (isUniqueOn(error, "reverse_submit_key")) return (await lookupDuplicate(prisma)) ?? { kind: "conflict" };
    if (isBusyError(error)) return { kind: "busy" };
    throw error;
  }
}

/** 页码 / 每页条数：没传给默认；传了必须是正整数 */
function parsePositiveInt(raw: unknown, fallback: number): number | null {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw !== "string" || !/^\d{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}

/** 流水类型的中文名（员工 / 管理员看；客户那份在 client-compliance/routes.ts，两边一起改） */
const TYPE_ZH: Record<string, string> = {
  recharge: "充值到账", pay: "集货付款", refund: "撤销退款",
  bill_charge: "运费账单扣款", bill_refund: "账单作废退回",
  topup: "管理员充值", topup_reversal: "冲掉充值", deduction: "管理员减金额",
};
const REF_ZH: Record<string, string> = {
  whr: "仓库版集货", normal: "普通版集货", recharge: "充值单", finance2_charge: "运费账单", admin_adjust: "后台调整",
};

export function registerWalletAdjustRoutes(app: MinimalHttpApp): void {
  /* ===== 员工 / 管理员：客户和余额（按唛头搜，不带客户名字 —— 2026-09-19「显示唛头就行了」） ===== */
  app.get("/staff/wallet/clients", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const keyword = (typeof req.query.keyword === "string" ? req.query.keyword : "").trim();
    if (keyword.length > 64) { fail(res, 400, "BAD_REQUEST", "搜索词太长"); return; }
    const users = await prisma.user.findMany({
      where: { companyId: auth.companyId, role: "client", ...(keyword ? { id: { contains: keyword, mode: "insensitive" } } : {}) },
      orderBy: { id: "asc" },
      select: { id: true, status: true },
    });
    const accounts = users.length === 0 ? [] : await prisma.clientWalletAccount.findMany({
      where: { companyId: auth.companyId, currency: CONSOLIDATION_CURRENCY, clientId: { in: users.map((u) => u.id) } },
      select: { clientId: true, balance: true, updatedAt: true },
    });
    const byClient = new Map(accounts.map((a) => [a.clientId, a]));
    ok(res, {
      clients: users.map((u) => {
        const a = byClient.get(u.id);
        return {
          clientId: u.id,
          status: u.status,
          balance: a ? Number(a.balance) : 0,
          updatedAt: a ? a.updatedAt.toISOString() : null,
        };
      }),
      total: users.length,
    });
  });

  /* ===== 员工 / 管理员：一个客户的流水（新的在前，真分页） ===== */
  app.get("/staff/wallet/ledger", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId.trim() : "";
    if (!clientId) { fail(res, 400, "BAD_REQUEST", "缺少客户"); return; }
    const page = parsePositiveInt(req.query.page, 1);
    const pageSizeRaw = parsePositiveInt(req.query.pageSize, 50);
    if (page === null || pageSizeRaw === null) { fail(res, 400, "BAD_REQUEST", "页码或每页条数不合法"); return; }
    const pageSize = Math.min(pageSizeRaw, PAGE_SIZE_MAX);
    const client = await prisma.user.findFirst({ where: { id: clientId, companyId: auth.companyId, role: "client" }, select: { id: true } });
    if (!client) { fail(res, 404, "NOT_FOUND", "没有这个客户"); return; }
    const where = { companyId: auth.companyId, clientId };
    const [total, rows, account] = await Promise.all([
      prisma.consolidationBalanceLedger.count({ where }),
      prisma.consolidationBalanceLedger.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: Math.min((page - 1) * pageSize, Number.MAX_SAFE_INTEGER),
        take: pageSize,
        select: { id: true, type: true, amount: true, balanceAfter: true, refType: true, refId: true, refNo: true, remark: true, operatorId: true, operatorName: true, createdAt: true },
      }),
      prisma.clientWalletAccount.findUnique({
        where: { clientId_currency: { clientId, currency: CONSOLIDATION_CURRENCY } },
        select: { balance: true, updatedAt: true },
      }),
    ]);
    // 这一页里管理员调整单的状态（冲掉了没有、有没有水单）
    const adjIds = [...new Set(rows.filter((r) => r.refType === ADMIN_ADJUST_REF_TYPE && r.refId).map((r) => r.refId!))];
    // ⚠️ 不读 proof_image 原图（一页最多 500 条、一张最多 8MB，这一页收到推送还会悄悄重拉）：「有没有水单」在库里算
    const adjs = adjIds.length === 0 ? [] : await prisma.$queryRaw<Array<{ id: string; kind: string; ledger_id: string; has_proof: boolean; reversed_at: Date | null; reversed_by_name: string | null; reverse_reason: string | null }>>`
      SELECT id, kind, ledger_id, proof_image IS NOT NULL AS has_proof, reversed_at, reversed_by_name, reverse_reason
      FROM wallet_adjustments WHERE id = ANY(${adjIds}) AND company_id = ${auth.companyId}
    `;
    const adjById = new Map(adjs.map((a) => [a.id, a]));
    const seeOperator = canSeeOperatorIdentity(auth.role);
    ok(res, {
      clientId,
      balance: account ? Number(account.balance) : 0,
      updatedAt: account ? account.updatedAt.toISOString() : null,
      items: rows.map((r) => {
        const adj = r.refType === ADMIN_ADJUST_REF_TYPE && r.refId ? adjById.get(r.refId) : undefined;
        // 「管理员充值」那一行（不是冲掉那一行）才带调整单的状态
        const isTopupRow = !!adj && adj.kind === "topup" && adj.ledger_id === r.id;
        return {
          id: r.id,
          type: r.type,
          typeLabel: TYPE_ZH[r.type] ?? "其他",
          amount: Number(r.amount),
          balanceAfter: Number(r.balanceAfter),
          source: r.refType ? (REF_ZH[r.refType] ?? "其他") : "",
          refNo: r.refNo ?? "",
          remark: hideOperatorInRemark(r.remark ?? "", auth.role),
          // 谁做的只给管理员看（2026-09-15 老板）；客户自己付的那步显示唛头（2026-09-19，流水没存角色：操作人就是这个客户自己 = 客户那步）
          operatorName: seeOperator
            ? operatorNameForDisplay({ operatorRole: r.operatorId !== null && r.operatorId === clientId ? "client" : "staff", operatorId: r.operatorId, operatorName: r.operatorName })
            : undefined,
          createdAt: r.createdAt.toISOString(),
          adjustment: adj ? {
            id: adj.id,
            kind: adj.kind,
            canReverse: isTopupRow && !adj.reversed_at,
            hasProof: adj.has_proof && adj.ledger_id === r.id,
            reversed: isTopupRow && !!adj.reversed_at ? {
              at: new Date(adj.reversed_at!).toISOString(),
              reason: adj.reverse_reason ?? "",
              byName: seeOperator ? (adj.reversed_by_name ?? "") : undefined,
            } : null,
          } : null,
        };
      }),
      page,
      pageSize,
      total,
    });
  });

  /* ===== 管理员：给客户加金额 ===== */
  app.post("/admin/wallet/adjustments/topup", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    await handleCreate(req.body, "topup", auth, res);
  });

  /* ===== 管理员：减金额（把余额退给客户，线下转回去） ===== */
  app.post("/admin/wallet/adjustments/deduct", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    await handleCreate(req.body, "deduction", auth, res);
  });

  /* ===== 管理员：冲掉一笔管理员充值（整笔） ===== */
  app.post("/admin/wallet/adjustments/reverse", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const submitKey = typeof body.submitKey === "string" ? body.submitKey : "";
    if (!SUBMIT_KEY_RE.test(submitKey)) { fail(res, 400, "BAD_REQUEST", "缺少提交编号，请刷新页面后再试"); return; }
    const adjustmentId = typeof body.adjustmentId === "string" ? body.adjustmentId.trim() : "";
    const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
    if (!adjustmentId || !clientId) { fail(res, 400, "BAD_REQUEST", "缺少要冲掉的那一笔"); return; }
    const reason = parseAdjustText(body.reason);
    if (!reason.ok) { fail(res, 400, "BAD_REQUEST", `原因最多 ${TEXT_MAX} 个字`); return; }
    if (!reason.text) { fail(res, 400, "BAD_REQUEST", "请写冲掉的原因"); return; }
    const out = await runReverse(auth, { adjustmentId, clientId, reason: reason.text, submitKey });
    switch (out.kind) {
      case "busy": fail(res, 503, "INTERNAL_ERROR", "系统忙，这一次没有办（钱没动）。请过一会儿原样再点一次"); return;
      case "conflict": fail(res, 409, "VALIDATION_ERROR", "这次提交的编号已经用过了，内容不一样。请关掉弹窗重新打开再点"); return;
      case "notFound": fail(res, 404, "NOT_FOUND", "没有这一笔"); return;
      case "notTopup": fail(res, 400, "BAD_REQUEST", "只有「管理员充值」能冲掉"); return;
      case "wrongClient": fail(res, 400, "BAD_REQUEST", "这一笔不是这个客户的，请刷新后再看"); return;
      case "alreadyReversed": fail(res, 409, "VALIDATION_ERROR", "这一笔刚刚已经被冲掉了，没有重复冲，请刷新后再看"); return;
      default: break;
    }
    ok(res, {
      adjustmentId: out.row.id,
      clientId: out.row.clientId,
      amount: Number(out.row.amount),
      reason: out.row.reverseReason ?? "",
      reversedAt: out.row.reversedAt!.toISOString(),
      balanceAfter: Number(out.row.reverseBalanceAfter),
      duplicate: out.duplicate,
    });
  });

  /* ===== 管理员：看一张调整单的水单图（列表里不带图） ===== */
  app.get("/admin/wallet/adjustments/proof", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const id = typeof req.query.id === "string" ? req.query.id.trim() : "";
    if (!id) { fail(res, 400, "BAD_REQUEST", "缺少调整单"); return; }
    const adj = await prisma.walletAdjustment.findFirst({ where: { id, companyId: auth.companyId }, select: { proofImage: true } });
    if (!adj) { fail(res, 404, "NOT_FOUND", "没有这张调整单"); return; }
    ok(res, { id, proofImage: adj.proofImage ?? "" });
  });
}

async function handleCreate(
  rawBody: unknown,
  kind: "topup" | "deduction",
  auth: { companyId: string; userId: string; name: string },
  res: Parameters<typeof ok>[0],
): Promise<void> {
  const body = (rawBody ?? {}) as Record<string, unknown>;
  const submitKey = typeof body.submitKey === "string" ? body.submitKey : "";
  if (!SUBMIT_KEY_RE.test(submitKey)) { fail(res, 400, "BAD_REQUEST", "缺少提交编号，请刷新页面后再试"); return; }
  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  if (!clientId) { fail(res, 400, "BAD_REQUEST", "请选客户"); return; }
  const amount = parseAdjustAmount(body.amount);
  if (!amount) { fail(res, 400, "BAD_REQUEST", "金额要大于 0，最多两位小数"); return; }
  const text = parseAdjustText(kind === "topup" ? body.remark : body.reason);
  if (!text.ok) { fail(res, 400, "BAD_REQUEST", `${kind === "topup" ? "备注" : "原因"}最多 ${TEXT_MAX} 个字`); return; }
  if (kind === "deduction" && !text.text) { fail(res, 400, "BAD_REQUEST", "请写减金额的原因"); return; }
  let proofImage = "";
  if (kind === "topup" && body.proofImage !== undefined && body.proofImage !== null && body.proofImage !== "") {
    if (typeof body.proofImage !== "string") { fail(res, 400, "BAD_REQUEST", "水单格式不对，请重新上传图片"); return; }
    proofImage = body.proofImage.trim();
    const issue = proofImageIssue(proofImage);
    if (issue) { fail(res, 400, "BAD_REQUEST", issue); return; }
  } else if (kind === "deduction" && body.proofImage) {
    fail(res, 400, "BAD_REQUEST", "减金额不收水单"); return;
  }
  const out = await runCreate(auth, { kind, clientId, amount, remark: text.text, proofImage, submitKey });
  switch (out.kind) {
    case "busy": fail(res, 503, "INTERNAL_ERROR", "系统忙，这一次没有办（钱没动）。请过一会儿原样再点一次"); return;
    case "conflict": fail(res, 409, "VALIDATION_ERROR", "这次提交的编号已经用过了，内容不一样。请关掉弹窗重新打开再填"); return;
    case "noClient": fail(res, 404, "NOT_FOUND", "没有这个客户"); return;
    case "insufficient":
      fail(res, 400, "BAD_REQUEST", `余额不够减：现在 ¥${out.have.toFixed(2)}，要减 ¥${out.need.toFixed(2)}。没有减，一分没动`);
      return;
    default: break;
  }
  ok(res, adjustReply(out.row, out.hasProof, out.duplicate));
}
