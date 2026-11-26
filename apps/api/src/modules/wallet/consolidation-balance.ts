/* ==========================================================================
   集货余额（2026-08-07）
   ------------------------------------------------------------------------
   「余额」现在**只服务两个集货板块**：仓库版集货拼柜、普通版集货拼柜。
   普通运单不再能用余额付款。只有人民币，泰铢已废弃。

   规矩：
     1. 扣款、退款、充值到账，都必须走这里的函数，别在业务代码里直接
        改 client_wallet_accounts —— 否则流水会漏记，客户对不上账。
     2. 三个函数都要求传入事务 tx：扣钱和改单据状态必须在同一个事务里，
        不然会出现「钱扣了单子没付上」或者反过来。
     3. 余额不足直接抛错，由调用方 catch 后转成 400 提示。

   2026-11-27 财务系统2 客户余额（ADR 0191，约定第 12 节）：老板定客户的余额只有这一本账。
   财务系统2 的账单发给客户时来扣、作废时来退，走文件末尾的 chargeBillUpTo / refundBillCharge：
     · 同样必须传事务、先锁后读、算钱在锁里（锁和读是同一句 SELECT … FOR UPDATE）；
     · 扣款是「扣完为止」，余额不够不抛错（跟上面第 3 条不一样），扣到多少回多少；
     · 流水的关联类型是 finance2_charge（ref_id = 扣款的请求编号，退回也挂这个编号），
       不跟 whr / normal / recharge 共用：撤销付款、删单是按 ref_type + ref_id 加总算退款的，共用会算串。
   上面集货那几个函数的行为一行没改（writeLedger 只是放开了类型、多返回一个流水编号）。
   ========================================================================== */
import { Prisma } from "@prisma/client";

/** 集货余额只有人民币 */
export const CONSOLIDATION_CURRENCY = "CNY";

/**
 * 流水类型（consolidation_balance_ledger.type）。
 * 前三种是集货原有的；bill_charge / bill_refund 是财务系统2 来扣 / 退（2026-11-27）；
 * topup / topup_reversal / deduction 留给第 2 轮管理员加减（管理员充值 / 冲掉充值 / 管理员减金额），这一轮没人写。
 * 客户余额页的中文名在 client-compliance/routes.ts 的 typeZh，加类型要一起加。
 */
export type LedgerType =
  | "pay"
  | "refund"
  | "recharge"
  | "bill_charge"
  | "bill_refund"
  | "topup"
  | "topup_reversal"
  | "deduction";

/** 财务系统2 来扣的那一次在流水上的关联类型。ref_id = 扣款的请求编号（退回也挂它），ref_no = 账单号 */
export const FINANCE2_CHARGE_REF_TYPE = "finance2_charge";

/** 余额不足时抛这个，调用方据此返回 400 而不是 500 */
export class InsufficientBalanceError extends Error {
  constructor(
    public readonly need: number,
    public readonly have: number,
  ) {
    super(`余额不足：本次需要 ¥${need.toFixed(2)}，当前集货余额 ¥${have.toFixed(2)}，还差 ¥${(need - have).toFixed(2)}`);
    this.name = "InsufficientBalanceError";
  }
}

type Tx = {
  /** 加行锁用。调用方传进来的都是真事务，这个方法一定有 */
  $queryRaw: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
  clientWalletAccount: {
    findUnique: (args: any) => Promise<any>;
    upsert: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
  };
  consolidationBalanceLedger: { create: (args: any) => Promise<any> };
};

/** 单据已经被别的请求付掉了 / 状态变了，调用方据此返回 400 */
export class PaymentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentConflictError";
  }
}

/**
 * 锁住这个客户的钱包行（2026-08-25 新增）。**改余额之前必须先调这个。**
 *
 * ## 不锁会少扣钱
 *
 * 原来三个函数都是「先读余额、算一个新数、再把这个数写回去」。
 * 两笔付款同时进来就会互相覆盖：
 * ```
 *   请求A 读到 12000 → 算出 11000
 *   请求B 读到 12000 → 算出 11000   （A 还没提交，B 读到的还是旧值）
 *   两个都写 11000，流水各记一笔 -1000
 *   结果：账上只少了 1000，流水显示少了 2000 —— 公司白亏 1000
 * ```
 * 生产已有 ¥12,450 真实余额、¥27,700 已付款业务，触发条件是真实存在的。
 *
 * 加了 FOR UPDATE 之后，B 会卡在这一行等 A 提交完，然后读到 11000，算出 10000。
 *
 * ⚠️ 账户行还不存在时（客户从没有过余额），这里锁不到任何东西 ——
 *    扣款那条路不受影响（读出来是 0，直接报余额不足）；
 *    退款/充值那条路走 upsert 新建，极端情况下两个并发新建会撞唯一约束报错，
 *    **报错总比静默算错强**，而且要同时满足「客户零余额 + 两笔退款同秒发生」，实际碰不到。
 */
async function lockAccount(tx: Tx, clientId: string): Promise<void> {
  // ⚠️ 列名是 "clientId" 不是 client_id ——
  // 这张表的 clientId 字段在 schema.prisma 里**没写 @map**，所以数据库里就是驼峰的，
  // 而同一张表的 company_id / updated_at 又是下划线的。手写 SQL 前必须逐列确认，
  // 大小写混合的列名在 PostgreSQL 里还必须加双引号，否则会被当成全小写。
  // （2026-08-25 第一版就是写成 client_id，测试库一跑直接报 column does not exist。）
  await tx.$queryRaw`
    SELECT "clientId" FROM client_wallet_accounts
    WHERE "clientId" = ${clientId} AND currency = ${CONSOLIDATION_CURRENCY}
    FOR UPDATE
  `;
}

/** 读当前集货余额（元）。没有账户当 0 处理。 */
export async function readBalance(tx: Tx, clientId: string): Promise<number> {
  const acc = await tx.clientWalletAccount.findUnique({
    where: { clientId_currency: { clientId, currency: CONSOLIDATION_CURRENCY } },
    select: { balance: true },
  });
  return Number(acc?.balance ?? 0);
}

interface MoveArgs {
  companyId: string;
  clientId: string;
  /** 正数，单位元 */
  amount: number;
  /** whr=仓库版预报单 | normal=普通版任务 | recharge=充值单 */
  refType: string;
  refId: string;
  /** 给客户看的单号 */
  refNo?: string | null;
  remark?: string | null;
  operatorId?: string | null;
  operatorName?: string | null;
}

/**
 * 集货付款扣钱。余额不够抛 InsufficientBalanceError，一分钱都不扣。
 * @returns 扣完之后的余额
 */
export async function chargeForConsolidation(tx: Tx, args: MoveArgs): Promise<number> {
  const amount = round2(args.amount);
  if (!(amount > 0)) throw new Error("扣款金额必须大于 0");

  await lockAccount(tx, args.clientId);
  const have = await readBalance(tx, args.clientId);
  if (have < amount) throw new InsufficientBalanceError(amount, have);

  const after = round2(have - amount);
  await tx.clientWalletAccount.update({
    where: { clientId_currency: { clientId: args.clientId, currency: CONSOLIDATION_CURRENCY } },
    data: { balance: after },
  });
  await writeLedger(tx, args, "pay", -amount, after);
  return after;
}

/**
 * 管理员撤销付款，把钱退回集货余额。
 * @returns 退完之后的余额
 */
export async function refundToConsolidation(tx: Tx, args: MoveArgs): Promise<number> {
  const amount = round2(args.amount);
  if (!(amount > 0)) throw new Error("退款金额必须大于 0");

  await lockAccount(tx, args.clientId);
  const have = await readBalance(tx, args.clientId);
  const after = round2(have + amount);
  await tx.clientWalletAccount.upsert({
    where: { clientId_currency: { clientId: args.clientId, currency: CONSOLIDATION_CURRENCY } },
    create: {
      clientId: args.clientId,
      companyId: args.companyId,
      currency: CONSOLIDATION_CURRENCY,
      balance: after,
    },
    update: { balance: after },
  });
  await writeLedger(tx, args, "refund", amount, after);
  return after;
}

/**
 * 充值审核通过、钱到账时记一笔流水。
 * 加钱本身由充值审核那边的 upsert 做，这里只负责把流水补上并回填余额。
 */
export async function recordRechargeCredit(tx: Tx, args: MoveArgs): Promise<number> {
  const amount = round2(args.amount);
  // 充值的加钱动作在审核那边做，这里只补流水；但 balanceAfter 要读准，
  // 所以同样先锁 —— 不锁的话并发时这个数会记成别人扣款前的旧值。
  await lockAccount(tx, args.clientId);
  const after = await readBalance(tx, args.clientId);
  await writeLedger(tx, args, "recharge", amount, after);
  return after;
}

/** 记流水要的那几样（金额单独传，带正负号） */
type LedgerArgs = Omit<MoveArgs, "amount">;

/** @returns 这笔流水的编号（集货那几条路不用它，财务系统2 那两条要回给对方） */
async function writeLedger(
  tx: Tx,
  args: LedgerArgs,
  type: LedgerType,
  signedAmount: number | Prisma.Decimal,
  balanceAfter: number | Prisma.Decimal,
): Promise<string> {
  const row = await tx.consolidationBalanceLedger.create({
    data: {
      companyId: args.companyId,
      clientId: args.clientId,
      type,
      amount: signedAmount,
      balanceAfter,
      refType: args.refType,
      refId: args.refId,
      refNo: args.refNo ?? null,
      remark: args.remark ?? null,
      operatorId: args.operatorId ?? null,
      operatorName: args.operatorName ?? null,
    },
    select: { id: true },
  });
  return row.id as string;
}

/** 钱一律留两位小数，避免浮点误差一分一分地积累 */
function round2(n: number): number {
  return Math.round(Number(n) * 100) / 100;
}

/* --------------------------------------------------------------------------
   删除单据时的退款（2026-08-08）
   ------------------------------------------------------------------------
   背景：管理员端新加的「删除集货任务 / 删除集货计划」是级联删除，
   单子删掉之后，客户已经付的钱本来会一直挂在他账上不见 —— 实测确认过：
   付了 8.5 元，强删之后余额没变，单子却没了，客户来问都查不到。

   这里的两个函数就是补这个洞：删之前先算出「这张单实际净扣了多少」，
   照「撤销付款」那条路原样退回客户的集货余额，并记一笔流水说明是删除退款。

   净额算法跟「撤销付款」保持一致：把这张单的 pay(负数) 和 refund(正数)
   加起来再取反 —— 已经退过的不会重复退。
   -------------------------------------------------------------------------- */

/** 某个客户在某张单上实际还欠退的金额 */
export interface PendingRefund {
  clientId: string;
  /** 正数，单位元 */
  amount: number;
  /** 给客户看的单号，取流水里记着的那个 */
  refNo: string | null;
}

type LedgerReader = {
  consolidationBalanceLedger: {
    findMany: (args: any) => Promise<any[]>;
  };
};

/**
 * 算出一批单据上还需要退给客户的钱，按客户分组。
 *
 * 一张单可能涉及多个客户（仓库版一个计划下有多个客户各付各的），
 * 所以按 clientId 分开算，一个客户一笔退款。
 *
 * @param refs 要查的单据，如 [{ refType: "whr", refId: "预报单id" }, ...]
 */
export async function computePendingRefunds(
  db: LedgerReader,
  refs: { refType: string; refId: string }[],
): Promise<PendingRefund[]> {
  if (refs.length === 0) return [];

  const rows = await db.consolidationBalanceLedger.findMany({
    where: { OR: refs.map((r) => ({ refType: r.refType, refId: r.refId })) },
    select: { clientId: true, amount: true, refNo: true },
  });

  const byClient = new Map<string, { sum: number; refNo: string | null }>();
  for (const row of rows) {
    const prev = byClient.get(row.clientId) ?? { sum: 0, refNo: null };
    byClient.set(row.clientId, {
      sum: prev.sum + Number(row.amount),
      refNo: prev.refNo ?? row.refNo ?? null,
    });
  }

  const result: PendingRefund[] = [];
  for (const [clientId, v] of byClient) {
    // pay 是负数，取反才是「已经净扣走的钱」
    const amount = round2(-v.sum);
    if (amount > 0) result.push({ clientId, amount, refNo: v.refNo });
  }
  return result;
}

/**
 * 把上面算出来的钱真退回去。必须和删除操作在同一个事务里，
 * 否则会出现「钱退了单子没删」或者反过来。
 *
 * @returns 实际退出去的总金额
 */
export async function refundPendingOnDelete(
  tx: Tx,
  args: {
    companyId: string;
    refType: string;
    /** 记在退款流水上的单据 id，用哪个都行，取被删的那张主单最直观 */
    refId: string;
    refunds: PendingRefund[];
    remark: string;
    operatorId?: string | null;
    operatorName?: string | null;
  },
): Promise<number> {
  let total = 0;
  // ⚠️ 按 clientId 排序再退：一个计划下有多个客户时会依次锁多行，
  // 两个并发的删除操作如果加锁顺序相反，PostgreSQL 会判定死锁、掐掉其中一个。
  // 固定成同一个顺序就不会打架。
  const ordered = [...args.refunds].sort((a, b) => a.clientId.localeCompare(b.clientId));
  for (const r of ordered) {
    await refundToConsolidation(tx, {
      companyId: args.companyId,
      clientId: r.clientId,
      amount: r.amount,
      refType: args.refType,
      refId: args.refId,
      refNo: r.refNo,
      remark: args.remark,
      operatorId: args.operatorId ?? null,
      operatorName: args.operatorName ?? null,
    });
    total = round2(total + r.amount);
  }
  return total;
}

/* --------------------------------------------------------------------------
   财务系统2 来扣 / 退（2026-11-27，ADR 0191，约定第 12 节）
   ------------------------------------------------------------------------
   老板定：客户的余额只有这一本账。财务系统2 的账单点「已发给客户」时来扣（扣完为止），
   账单作废 / 那笔扣款作废 / 扣多了时来退。请求编号去重、谁能调在 finance2-balance/ 那个模块，这里只管钱。

   跟上面集货那几个函数的区别：
     · 金额用 Prisma.Decimal 算（不经过 JS 浮点），进出都是两位小数；
     · 锁和读是同一句（SELECT balance … FOR UPDATE），读到的一定是锁住那一刻的数；
     · 钱包行还不存在时 FOR UPDATE 锁不到东西（见 lockAccount 的注释），两条路各自处理：
         扣款：锁不到行 = 这一刻余额就是 0 → 扣 0、不建行、不写流水（不再去读第二遍，免得读到锁之后才建出来的行）；
         退回：先 INSERT … ON CONFLICT DO NOTHING 保证行在（两个一起建时后一个等前一个提交、然后什么都不做，不撞主键），再锁再读。
   锁序：调用方先拿单据那边的锁（这里是「这个请求编号」的排队锁），再进这里锁钱包，跟集货「单据 → 钱包」同向。
   -------------------------------------------------------------------------- */

const Decimal = Prisma.Decimal;

type BillTx = Tx & {
  $executeRaw: (strings: TemplateStringsArray, ...values: any[]) => Promise<number>;
  consolidationBalanceLedger: { aggregate: (args: any) => Promise<any> };
};

/** 实扣 / 实退的结果 */
export interface BillMoveResult {
  /** 实扣 / 实退（≥ 0，两位小数） */
  amount: Prisma.Decimal;
  /** 动完以后的余额（可以是负数：管理员冲掉充值时不够冲，第 2 轮） */
  balanceAfter: Prisma.Decimal;
  /** 写的那笔流水；一分没动是 null */
  ledgerId: string | null;
}

/** 要退的比这次扣款还能退的多。调用方据此回 409 over_refund，不动钱 */
export class OverRefundError extends Error {
  constructor(
    public readonly requested: Prisma.Decimal,
    public readonly refundable: Prisma.Decimal,
  ) {
    super(`这次扣款还能退 ¥${refundable.toFixed(2)}，要退 ¥${requested.toFixed(2)}，超了`);
    this.name = "OverRefundError";
  }
}

/** 锁住这个客户的钱包行并读余额（同一句）。行不存在给 null（这时什么也没锁住） */
async function lockAndReadWallet(tx: BillTx, clientId: string): Promise<Prisma.Decimal | null> {
  // 列名 "clientId" 是驼峰的（没写 @map），company_id / updated_at 是下划线的 —— 见 lockAccount 的注释（CLAUDE.md 第 26 条）
  const rows: Array<{ balance: string }> = await tx.$queryRaw`
    SELECT balance::text AS balance FROM client_wallet_accounts
    WHERE "clientId" = ${clientId} AND currency = ${CONSOLIDATION_CURRENCY}
    FOR UPDATE
  `;
  return rows[0] ? new Decimal(rows[0].balance) : null;
}

/** 两位小数、大于 0 的金额，不是就抛（调用方先校验过格式，这里是第二道） */
function positiveMoney(value: Prisma.Decimal | string, label: string): Prisma.Decimal {
  const d = new Decimal(value);
  if (!d.isFinite() || !d.gt(0) || d.decimalPlaces() > 2) throw new Error(`${label}必须是大于 0、最多两位小数的金额`);
  return d;
}

/**
 * 财务系统2 账单扣款：扣完为止。
 * 实扣 = min(上限, max(余额, 0))；实扣大于 0 才改余额、写一笔 bill_charge 流水（金额为负，ref = finance2_charge + 请求编号，ref_no = 账单号）。
 * 余额 0 或负数、钱包行不存在：扣 0，不写流水，不建钱包行。
 */
export async function chargeBillUpTo(
  tx: BillTx,
  args: { companyId: string; clientId: string; maxAmount: Prisma.Decimal | string; requestId: string; billNo: string },
): Promise<BillMoveResult> {
  const cap = positiveMoney(args.maxAmount, "扣款上限");
  const have = await lockAndReadWallet(tx, args.clientId);
  // 锁不到行 = 从来没有过余额：这一刻就是 0
  if (have === null) return { amount: new Decimal(0), balanceAfter: new Decimal(0), ledgerId: null };
  const charged = Decimal.min(cap, Decimal.max(have, 0));
  if (!charged.gt(0)) return { amount: new Decimal(0), balanceAfter: have, ledgerId: null };

  const after = have.minus(charged);
  await tx.clientWalletAccount.update({
    where: { clientId_currency: { clientId: args.clientId, currency: CONSOLIDATION_CURRENCY } },
    data: { balance: after },
  });
  const ledgerId = await writeLedger(
    tx,
    {
      companyId: args.companyId,
      clientId: args.clientId,
      refType: FINANCE2_CHARGE_REF_TYPE,
      refId: args.requestId,
      refNo: args.billNo,
      remark: null,
      operatorId: null,
      operatorName: null,
    },
    "bill_charge",
    charged.neg(),
    after,
  );
  return { amount: charged, balanceAfter: after, ledgerId };
}

/**
 * 财务系统2 退回某一次扣款（全部或一部分）。
 * 锁住钱包后按流水重算「这次扣款还能退多少」= -(这次扣款编号下 bill_charge + bill_refund 的合计)，
 * 要退的超了抛 OverRefundError（一分不动）；没超就加回余额、写一笔 bill_refund 流水（金额为正，挂在原来那次扣款的编号上）。
 * 同一次扣款的几次退回都锁同一个钱包行，所以是排着队算的，加起来不会超过扣的。
 */
export async function refundBillCharge(
  tx: BillTx,
  args: { companyId: string; clientId: string; amount: Prisma.Decimal | string; chargeRequestId: string; billNo: string },
): Promise<BillMoveResult> {
  const amount = positiveMoney(args.amount, "退回金额");
  // 先保证钱包行在（正常情况下扣过钱一定在；这里兜住行不在的情况），再锁。
  // ON CONFLICT DO NOTHING：两个请求同时建，后一个等前一个提交后什么都不做，不会撞主键报错
  await tx.$executeRaw`
    INSERT INTO client_wallet_accounts ("clientId", company_id, currency, balance, updated_at)
    VALUES (${args.clientId}, ${args.companyId}, ${CONSOLIDATION_CURRENCY}, 0, CURRENT_TIMESTAMP)
    ON CONFLICT DO NOTHING
  `;
  const have = await lockAndReadWallet(tx, args.clientId);
  if (have === null) throw new Error("钱包行刚建过却锁不到");

  // 锁里重算（CLAUDE.md 第 28 条：不用锁之前的快照）
  const agg = await tx.consolidationBalanceLedger.aggregate({
    where: { companyId: args.companyId, clientId: args.clientId, refType: FINANCE2_CHARGE_REF_TYPE, refId: args.chargeRequestId },
    _sum: { amount: true },
  });
  const net = new Decimal(agg?._sum?.amount ?? 0);
  const refundable = Decimal.max(net.neg(), 0);
  if (amount.gt(refundable)) throw new OverRefundError(amount, refundable);

  const after = have.plus(amount);
  await tx.clientWalletAccount.update({
    where: { clientId_currency: { clientId: args.clientId, currency: CONSOLIDATION_CURRENCY } },
    data: { balance: after },
  });
  const ledgerId = await writeLedger(
    tx,
    {
      companyId: args.companyId,
      clientId: args.clientId,
      refType: FINANCE2_CHARGE_REF_TYPE,
      refId: args.chargeRequestId,
      refNo: args.billNo,
      remark: null,
      operatorId: null,
      operatorName: null,
    },
    "bill_refund",
    amount,
    after,
  );
  return { amount, balanceAfter: after, ledgerId };
}
