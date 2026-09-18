import { DECIMAL_10_2, DECIMAL_10_6, DECIMAL_12_2, checkTotalsWritable, requireDecimal, requireDerivedWithinDecimal } from "../core/decimal-guard";
import { parseNumericStrict, requirePositiveInt, requireProductWithinInt } from "../core/int-guard";
import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { logger } from "../core/logger";
import { BusinessError } from "../core/business-error";
import { hideOperatorIdentity, hideOperatorInRemark, operatorNameForDisplay } from "../core/operator-visibility";
import { verifyPassword } from "../auth/crypto-utils";
// 取消任务验管理员密码用的失败限流（2026-08-31 Codex 复核）：复用登录那套内存计数器
import { rateLimitKey, isFailureBlocked, failureRetryAfterMs, recordFailure, clearFailures } from "../core/rate-limit";
import {
  InsufficientBalanceError,
  chargeForConsolidation,
  PaymentConflictError,
  computePendingRefunds,
  refundPendingOnDelete,
  refundToConsolidation,
} from "../wallet/consolidation-balance";
import { saveImageToDisk, readImageAsBase64 } from "../orders/image-storage";
// 客户排队锁：跟「超管改客户归属」同一把，建普通版任务时防止客户同时被改归代理（确认单 4.1）
import { lockClientWhrPrice } from "../whr-consolidation/long-term-price";

// ============================================================================
// 辅助函数
// ============================================================================

/** 货型取值，与仓库版集货保持一致。普通版只记录，不参与计价。 */
const CARGO_TYPES = ["normal", "inspection", "sensitive"];

/**
 * 任务走到这几档之后就不许再删货了（2026-08-15）。
 *
 * ⚠️ 这里用「黑名单」不用「白名单」是有原因的：任务状态实际取值是
 * collecting / full_confirmed / quoted / paid / loading / in_transit /
 * customs / delivering / completed / cancelled —— 前面能删的有四档，
 * 白名单漏写一档就会让「明明还没付款却删不了」，而且以后加新状态还会再漏一次。
 * 黑名单只锁住真正有风险的「已装柜及以后」，新状态默认落在可删这一侧。
 * 至于付款，另有 paymentStatus 那道判断管着，不靠这里。
 */
const TASK_LOCKED_FOR_PRODUCT_DELETE = [
  "loading", "in_transit", "customs", "delivering", "completed", "cancelled",
];

/**
 * 「这张预报单 / 这件货，现在还能不能删」——三条删除路径共用同一把尺子。
 *
 * ⚠️ 2026-08-28 补。之前这把尺子只长在「删单件货物」那条路上，
 * 而「删整张预报单」（管理员和客户各一条）**一道检查都没有** ——
 * 删整张的杀伤力更大（数据库对货物明细是级联删除，一删全没），
 * 却反而没人管。`product-delete` 的提示语还写着
 * 「整张不要了请走『删除预报单』，那条路会一并清干净」，等于把人往没锁的门里领。
 *
 * 结果就是：任务已付款 → 管理员删掉整张预报单 → **货没了，钱一分没退**。
 * 而且货删光之后「撤销付款」那条路会直接 400，退款的口子也跟着封死。
 *
 * 界线沿用用户 2026-08-15 拍板的那条：**客户还没交钱就能删**。
 * 已付款要删，请先走「撤销付款」——那条路会正经退钱，不在这里私自动账。
 *
 * 抽成纯函数是为了能测：路由那一层要连数据库，测不动。
 */

/**
 * 普通版集货产品行的数值校验 —— **三个入口共用一份**（2026-08-29 抽出来的）。
 *
 * 为什么抽：同一段校验在这个文件里有**三份拷贝**（建单、改单、管理员强改）。
 * 第九轮复核报的时候我只改了建单那一份，另外两份原样留着 ——
 * 这个项目里「三个入口只修了一个」已经发生过两次了（产品行校验那次也是）。
 * 一份实现三处调用，才不会再漏。
 *
 * 原来的写法错在哪：
 *   · 件数/装箱数量 `if (!x || x < 1)` —— **2.5 能过**，而库里是 `Int`
 *   · 单件重量/长宽高 `=== undefined || === null` —— **只查填没填，不查填的是什么**，
 *     负数、0、超大数、21 位小数全进得来；库里是 `Decimal(10,2)`，
 *     多余小数位被静默抹掉 → 页面算的方数和库里存的尺寸对不上
 *     （复核实测 ¥850/方 差 ¥5.10）。这条路的方数是要拿去算钱的。
 *
 * @returns 有问题时返回给人看的中文提示；合格返回 null。
 */
// ⚠️ 导出是为了让自测能**真调它**（扫源码证明不了行为，第十二轮的教训）
export function validateConsolidationProductRow(p: any, index: number): string | null {
  const label = `产品行${index + 1}`;
  const pkgIssue = requirePositiveInt(parseNumericStrict(p.packageCount), `${label}的件数`);
  if (pkgIssue) return pkgIssue;
  const qpbIssue = requirePositiveInt(parseNumericStrict(p.quantityPerBox), `${label}的装箱数量`);
  if (qpbIssue) return qpbIssue;
  // totalQuantity = 件数 × 装箱数量，也是 Int，两个因子各自合法乘起来照样能爆
  const totalIssue = requireProductWithinInt(
    parseNumericStrict(p.packageCount),
    parseNumericStrict(p.quantityPerBox),
    `${label}的总数量`,
  );
  if (totalIssue) return totalIssue;
  for (const [field, name] of [
    ["unitWeightKg", "单件重量(kg)"],
    ["lengthCm", "长(cm)"],
    ["widthCm", "宽(cm)"],
    ["heightCm", "高(cm)"],
  ] as Array<[string, string]>) {
    const val = p[field];
    if (val === undefined || val === null) return `${label}的${name}为必填`;
    const issue = requireDecimal(val, `${label}的${name}`, DECIMAL_10_2);
    if (issue) return issue;
  }

  /**
   * ⚠️⚠️ **算出来的字段也要卡**（2026-08-29 第十轮补）。
   * 复核报的一条新的，也是最隐蔽的一类：**每个输入都合法，算出来的数爆掉**。
   *   · 单重 99999999.99 × 数量 2 = 199999999.98 →
   *     `totalWeight` 那列是 `Decimal(10,2)`，数据库实测 `numeric field overflow`
   *   · 1000×1000×1000 cm × 10 件 = 10000 m³ →
   *     `volume` 是 `Decimal(10,6)`，最大只能存 9999.999999 → 裸 500
   * 只卡输入不卡输出，等于没卡。
   * ⚠️ 这里算的口径必须跟下面真正写库那几行**一模一样**，
   *    否则这道闸放行的数写库还是会炸。
   */
  const pkg = parseNumericStrict(p.packageCount);
  const qpb = parseNumericStrict(p.quantityPerBox);
  const totalQuantity = pkg * qpb;
  const weightIssue = requireDerivedWithinDecimal(
    parseNumericStrict(p.unitWeightKg) * totalQuantity,
    `${label}的总重量`,
    DECIMAL_10_2,
  );
  if (weightIssue) return weightIssue;
  const volumeIssue = requireDerivedWithinDecimal(
    (parseNumericStrict(p.lengthCm) * parseNumericStrict(p.widthCm) * parseNumericStrict(p.heightCm) / 1_000_000) * pkg,
    `${label}的体积(m³)`,
    DECIMAL_10_6,
  );
  if (volumeIssue) return volumeIssue;

  /**
   * ⚠️ **顺手把规范化后的数字写回去**（2026-08-29 第十一轮补）。
   *
   * 复核指出：这个接口收数字**字符串**（前端经常这么传），校验时我用
   * `parseNumericStrict` 转过了，但**写库那三处用的还是 `p.packageCount!` 原值** ——
   * 于是一个合法的 `"3"` 会一路走到 Prisma 才报类型错误，员工看到「服务器繁忙」。
   *
   * 校验和写库用的必须是**同一个值**。就地改 p，三处写库自然拿到规范化后的数。
   */
  p.packageCount = pkg;
  p.quantityPerBox = qpb;
  p.unitWeightKg = parseNumericStrict(p.unitWeightKg);
  p.lengthCm = parseNumericStrict(p.lengthCm);
  p.widthCm = parseNumericStrict(p.widthCm);
  p.heightCm = parseNumericStrict(p.heightCm);

  return null;
}

/**
 * 删集货任务的「发运红线」（2026-09-16，确认单 4.15）：已经发出去的任务谁都不能删，输管理员密码也不行。
 *
 * 普通版任务状态全集（schema 注释 + advance-status 的 validTransitions 核过）：
 *   collecting → full_confirmed → quoted → paid → loading → in_transit → customs → delivering → completed，另有 cancelled。
 * 「发运起」= 离开装柜进入运输：in_transit / customs / delivering / completed。
 * loading（装柜中）还没发出去，照原来的规矩（开始走流程要输密码）。
 * cancelled 不算：取消只允许在收集中 / 已满柜 / 已报价时做，被取消的任务一定没发过运。
 * ⚠️ 状态机以后加了新的「运输中」档，这里要一起加 —— 白名单漏写一档等于那档能被带密码删掉。
 */
export const CONSOLIDATION_SHIPPED_TASK_STATUSES = ["in_transit", "customs", "delivering", "completed"];
export function consolidationTaskShippedReason(taskStatus: string): string | null {
  return CONSOLIDATION_SHIPPED_TASK_STATUSES.includes(taskStatus)
    ? "这个集货任务已经发运，已发出去的任务谁都不能删，输管理员密码也不行"
    : null;
}

export function checkConsolidationDeletable(input: {
  paymentStatus: string;
  taskStatus: string;
}): { ok: true } | { ok: false; message: string } {
  // pending_review = 客户已交凭证等审核，算已付款
  if (input.paymentStatus !== "unpaid") {
    return {
      ok: false,
      message: "该任务客户已付款或正在审核付款，不能删。要删请先走「撤销付款」，那条路会退钱",
    };
  }
  if (TASK_LOCKED_FOR_PRODUCT_DELETE.includes(input.taskStatus)) {
    return { ok: false, message: "该任务已进入装柜流程，不能再删" };
  }
  return { ok: true };
}

/**
 * 生成任务编号 JH + 7位数字（如 JH0000001）
 *
 * ⚠️ 必须传**正在插入的那个事务**（2026-08-31 改，排查报告第54条）。
 * 原来这里自己开一个小事务：领完号锁就放了，插入却在外面单独做 ——
 * 两个客户几乎同时操作会领到同一个号，后插入的撞唯一约束，
 * 客户看到的是「服务器繁忙」。仓库版 8 月已改成「咨询锁 + 插入绑在同一个事务里」
 * （whr-consolidation/client-routes.ts 83011 那段），这里照抄同一个修法：
 * 锁要一直握到插入提交，后来的排队拿下一个号，而不是撞号报错。
 */
async function generateTaskNo(
  tx: Pick<typeof prisma, "$executeRaw" | "consolidationTask">,
): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(83001)`;
  const last = await tx.consolidationTask.findFirst({
    where: { taskNo: { startsWith: "JH" } },
    orderBy: { taskNo: "desc" },
    select: { taskNo: true },
  });
  const nextNum = last ? parseInt(last.taskNo.replace("JH", ""), 10) + 1 : 1;
  return `JH${String(nextNum).padStart(7, "0")}`;
}

/**
 * 生成预报单运单号 JH-YW + 7位数字（如 JH-YW0000001）
 * ⚠️ 同 generateTaskNo：必须传插入用的那个事务，锁握到插入完成（2026-08-31 改）
 */
async function generateTrackingNo(
  tx: Pick<typeof prisma, "$executeRaw" | "consolidationPrealert">,
): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(83002)`;
  const last = await tx.consolidationPrealert.findFirst({
    where: { trackingNo: { startsWith: "JH-YW" } },
    orderBy: { trackingNo: "desc" },
    select: { trackingNo: true },
  });
  const nextNum = last ? parseInt(last.trackingNo.replace("JH-YW", ""), 10) + 1 : 1;
  return `JH-YW${String(nextNum).padStart(7, "0")}`;
}

/**
 * 重新计算任务汇总数据（总件数、总体积、预报单数量）
 * 只统计已签收（received）的预报单
 */
/**
 * 重算任务的总件数/总方数/预报单数。
 *
 * ⚠️ `db` 一定要传事务客户端（2026-08-28 补）。
 * 原来写死用全局 prisma，删除和重算就分在两个事务里：
 * 删成功、重算失败时，任务上会留着一份跟实际货物对不上的数字。
 * 不传时退回全局 prisma，老调用点行为不变。
 */
// ⚠️ 导出是为了让自测能**真调它**（扫源码证明不了行为）
export async function recalcTaskTotals(
  taskId: string,
  db: Pick<typeof prisma, "consolidationPrealert" | "consolidationTask"> = prisma,
): Promise<void> {
  const prealerts = await db.consolidationPrealert.findMany({
    where: { taskId, status: "received" },
    include: {
      products: { select: { packageCount: true, volume: true } },
    },
  });

  let totalPackages = 0;
  let totalVolumeM3 = 0;

  for (const pa of prealerts) {
    for (const p of pa.products) {
      totalPackages += p.packageCount;
      totalVolumeM3 += Number(p.volume ?? 0);
    }
  }

  /**
   * ⚠️ 普通版任务汇总同样要卡（2026-08-29 第十二轮补）。
   * 复核实测：两行各 11 亿件都能过单行校验，合计 22 亿，超过 `Int` 上限。
   * 我上一轮只给仓库版那两个汇总加了闸，这个漏了 ——
   * 「N 个入口只修了 M 个」这个错我犯过五六次，所以现在四个汇总点
   * 全部走共用的 checkTotalsWritable。
   */
  const overflow = checkTotalsWritable({
    counts: [["这个任务的总件数", totalPackages]],
    volumes: [["这个任务的总方数", totalVolumeM3]],
  });
  if (overflow) {
    throw new BusinessError(`${overflow}。请把这个任务下的预报单拆开`, 400, "VALIDATION_ERROR");
  }

  await db.consolidationTask.update({
    where: { id: taskId },
    data: {
      totalPackages,
      totalVolumeM3: totalVolumeM3,
      totalPrealerts: prealerts.length,
    },
  });
}

/**
 * 计算任务体积使用百分比，返回 0-100 的数字
 */
function calcVolumePercent(task: { totalVolumeM3: any; maxVolumeM3: any }): number {
  const total = Number(task.totalVolumeM3 ?? 0);
  const max = Number(task.maxVolumeM3 ?? 68);
  if (max <= 0) return 0;
  return parseFloat(((total / max) * 100).toFixed(1));
}

// ============================================================================
// 格式化辅助
// ============================================================================

function formatTask(task: any) {
  return {
    ...task,
    maxVolumeM3: Number(task.maxVolumeM3 ?? 0),
    totalVolumeM3: Number(task.totalVolumeM3 ?? 0),
    bookingFee: task.bookingFee ? Number(task.bookingFee) : null,
    customsFee: task.customsFee ? Number(task.customsFee) : null,
    loadingFee: task.loadingFee ? Number(task.loadingFee) : null,
    totalFee: task.totalFee ? Number(task.totalFee) : null,
    createdAt: task.createdAt instanceof Date ? task.createdAt.toISOString() : task.createdAt,
    updatedAt: task.updatedAt instanceof Date ? task.updatedAt.toISOString() : task.updatedAt,
  };
}

/**
 * 列表专用：在 formatTask 基础上摘掉付款凭证图。
 *
 * paymentProofBase64 是整张付款凭证（@db.Text 存 base64），
 * formatTask 里的 ...task 会把它一并带出去。三个端的界面都只在
 * 「详情」里显示这张图（taskDetail.paymentProofBase64），列表里从没读过。
 * 前端拿到 undefined 走的是同一个 `&&` 判空分支，不会报错。
 */
function formatTaskForList(task: any) {
  const formatted = formatTask(task);
  delete formatted.paymentProofBase64;
  return formatted;
}

/**
 * 发给**客户**的任务数据：在 formatTask 基础上摘掉柜号。
 *
 * 用户 2026-08-07 定的规矩：客户不能看到柜号。运单那边一直照做，
 * 集货这块漏了 —— 客户端页面当初是照抄员工页面的，连柜号那行一起抄了过来，
 * 后端 `...task` 又把整行原样吐出去（2026-08-27 补）。
 * 光在前端不显示不够：抓包、看接口返回照样能拿到。
 */
function formatTaskForClient(task: any) {
  const { containerNo: _hidden, ...rest } = formatTask(task) as any;
  // 2026-09-15：`...task` 还会带出 paymentReviewedBy（审核付款的员工账号 id），一并摘掉
  return hideOperatorIdentity(rest, "client");
}

/**
 * 列表专用（客户端）：既摘凭证图，也摘柜号，也摘审核人。
 */
function formatTaskForClientList(task: any) {
  const { containerNo: _hidden, ...rest } = formatTaskForList(task) as any;
  return hideOperatorIdentity(rest, "client");
}

function formatPrealert(pa: any) {
  return {
    ...pa,
    signedAt: pa.signedAt instanceof Date ? pa.signedAt.toISOString() : pa.signedAt ?? null,
    createdAt: pa.createdAt instanceof Date ? pa.createdAt.toISOString() : pa.createdAt,
    updatedAt: pa.updatedAt instanceof Date ? pa.updatedAt.toISOString() : pa.updatedAt,
  };
}

function formatProduct(p: any) {
  return {
    ...p,
    unitWeight: p.unitWeight ? Number(p.unitWeight) : null,
    totalWeight: p.totalWeight ? Number(p.totalWeight) : null,
    length: p.length ? Number(p.length) : null,
    width: p.width ? Number(p.width) : null,
    height: p.height ? Number(p.height) : null,
    volume: p.volume ? Number(p.volume) : null,
    createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : p.createdAt,
  };
}

function formatStatusLog(log: any) {
  return {
    ...log,
    createdAt: log.createdAt instanceof Date ? log.createdAt.toISOString() : log.createdAt,
  };
}

/**
 * 发给**客户**的状态记录：把备注里的柜号抹掉（2026-08-28 补）。
 *
 * 上一轮只把 task.containerNo 这个字段对客户屏蔽了，但装柜那一步会把柜号
 * 写进状态日志的备注（`柜号: XXXU1234567`），而客户端详情接口是带 statusLogs 的、
 * 页面也把备注显示出来 —— 等于从另一条路又漏出去了。
 * 员工端和管理员端不受影响，照常看得到完整备注。
 */
/**
 * 按「谁在看」给状态记录（2026-09-15）。
 *
 * formatStatusLog 是 `...log` 整行展开，operatorId / operatorRole / operatorName 全在里面。
 * 老板拍板：只有超级管理员能看到是哪个账号操作的 —— 员工、客户都要明确摘掉（CLAUDE.md 第 31 条）。
 * 备注开头代码自己拼的「管理员…」也一并去掉（见 hideOperatorInRemark），库里原文不动。
 */
function formatStatusLogForViewer(log: any, viewerRole: string) {
  // 客户自己操作的那步，操作人显示唛头不显示客户名字（operatorNameForDisplay，2026-09-19）
  const formatted = formatStatusLog(log);
  const base = hideOperatorIdentity({ ...formatted, operatorName: operatorNameForDisplay(formatted) }, viewerRole);
  return typeof base.remark === "string" ? { ...base, remark: hideOperatorInRemark(base.remark, viewerRole) } : base;
}

function formatStatusLogForClient(log: any) {
  const base = formatStatusLogForViewer(log, "client");
  const remark: unknown = base?.remark;
  if (typeof remark === "string" && /柜号\s*[:：]/.test(remark)) {
    // 整条备注就是柜号 → 换成不含柜号的说法；备注里夹着柜号 → 只抹掉柜号那段
    return { ...base, remark: remark.replace(/柜号\s*[:：]\s*\S+/g, "柜号（不对外显示）") };
  }
  return base;
}

// ============================================================================
// 路由注册
// ============================================================================

export function registerConsolidationRoutes(app: MinimalHttpApp): void {
  // --------------------------------------------------------------------------
  // 客户端接口
  // --------------------------------------------------------------------------

  // 1) 创建集货任务
  app.post("/client/consolidation/tasks", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { destinationTh?: string };
    if (!body.destinationTh?.trim()) {
      fail(res, 400, "BAD_REQUEST", "目的地地址为必填");
      return;
    }

    // ⚠️ 取号和插入必须在同一个事务里（2026-08-31 改，排查报告第54条）：
    // 原来是先领号、放锁、再插入，两个客户同时点会领到同一个号，后一个撞唯一约束报「服务器繁忙」
    const task = await prisma.$transaction(async (tx) => {
      /**
       * ⚠️ 代理的客户不许有普通版集货任务（确认单 4.1，2026-09-16 第 2 轮复核补）。
       * server.ts 那道统一闸用的是请求进门时读的 agentId；超管同一刻把这个客户改归代理的话，
       * 改归属那边「查名下没有普通版任务 → 写 agentId」和这边的插入会互相看不见，两边都成功
       * （复核实测 40 个客户命中 11 个）。所以这里先拿改归属用的同一把客户锁（锁序也一样：
       * 客户价排队锁在前、取号锁在后），锁里现读 agentId，已归代理就拒。
       */
      await lockClientWhrPrice(tx, auth.userId);
      const owner = await tx.user.findFirst({
        where: { id: auth.userId, companyId: auth.companyId },
        select: { agentId: true },
      });
      if (!owner) throw new BusinessError("账号不存在，请重新登录", 401, "UNAUTHORIZED");
      if (owner.agentId) throw new BusinessError("该功能暂未开放", 403, "FORBIDDEN");
      const taskNo = await generateTaskNo(tx);
      return tx.consolidationTask.create({
        data: {
          taskNo,
          companyId: auth.companyId,
          clientId: auth.userId,
          destinationTh: body.destinationTh!.trim(),
          status: "collecting",
          maxVolumeM3: 68,
          currency: "CNY",
          paymentStatus: "unpaid",
        },
      });
    });

    ok(res, formatTaskForClient(task));
  });

  // 2) 查询任务列表
  app.get("/client/consolidation/tasks", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const statusFilter = (req.query as any)?.status as string | undefined;
    const where: any = { companyId: auth.companyId, clientId: auth.userId };

    if (statusFilter === "active") {
      where.status = { notIn: ["completed", "cancelled"] };
    }

    const tasks = await prisma.consolidationTask.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        prealerts: { select: { id: true, status: true } },
      },
    });

    const result = tasks.map((t) => {
      const volumePercent = calcVolumePercent(t);
      return {
        ...formatTaskForClientList(t),
        volumePercent,
        isNearFull: volumePercent >= 85,
        prealertCount: t.prealerts.length,
      };
    });

    ok(res, result);
  });

  // 3) 任务详情
  app.get("/client/consolidation/tasks/detail", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const taskId = (req.query as any)?.taskId as string | undefined;
    if (!taskId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }

    const task = await prisma.consolidationTask.findFirst({
      // ⚠️ 必须带 companyId（2026-08-27 补）：原来只按 id 查，实测能跨公司拿到别家数据
      where: { id: taskId , companyId: auth.companyId },
      include: {
        prealerts: {
          orderBy: { createdAt: "asc" },
          include: {
            products: { orderBy: { sortOrder: "asc" } },
          },
        },
        statusLogs: { orderBy: { createdAt: "desc" } },
      },
    });

    if (!task || task.clientId !== auth.userId) {
      fail(res, 403, "FORBIDDEN", "无权访问该任务");
      return;
    }

    ok(res, {
      ...formatTaskForClient(task),
      volumePercent: calcVolumePercent(task),
      isNearFull: calcVolumePercent(task) >= 85,
      prealerts: task.prealerts.map((pa) => ({
        ...formatPrealert(pa),
        products: pa.products.map(formatProduct),
      })),
      statusLogs: task.statusLogs.map(formatStatusLogForClient),
    });
  });

  // 4) 更新任务目的地
  app.post("/client/consolidation/tasks/update", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { taskId?: string; destinationTh?: string };
    if (!body.taskId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }
    if (!body.destinationTh?.trim()) {
      fail(res, 400, "BAD_REQUEST", "目的地地址为必填");
      return;
    }

    const task = await prisma.consolidationTask.findFirst({
      // ⚠️ 必须带 companyId（2026-08-27 补）：原来只按 id 查，
      // 外部复审实测跨公司请求能返回 200 并改掉别家公司的数据。
      // 生产目前只有一家公司，暂时没影响，接第二家之前必须是现在这样。
      where: { id: body.taskId, companyId: auth.companyId },
    });
    if (!task || task.clientId !== auth.userId) {
      fail(res, 403, "FORBIDDEN", "无权操作该任务");
      return;
    }
    if (task.status !== "collecting") {
      fail(res, 400, "BAD_REQUEST", "只有收集中状态的任务才能修改");
      return;
    }

    const updated = await prisma.consolidationTask.update({
      where: { id: body.taskId },
      data: { destinationTh: body.destinationTh.trim() },
    });

    ok(res, formatTaskForClient(updated));
  });

  // 5) 创建预报单
  app.post("/client/consolidation/prealerts", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      taskId?: string;
      mark?: string;
      expressNo?: string;
      products?: Array<{
        productName?: string;
        packageCount?: number;
        quantityPerBox?: number;
        unitWeightKg?: number;
        lengthCm?: number;
        widthCm?: number;
        heightCm?: number;
        material?: string;
        cargoValue?: string;
        cargoType?: string;
        productImage?: { fileName?: string; mime?: string; base64?: string };
      }>;
    };

    if (!body.taskId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }
    if (!body.mark?.trim()) {
      fail(res, 400, "BAD_REQUEST", "唛头为必填");
      return;
    }
    if (!body.products || body.products.length === 0) {
      fail(res, 400, "BAD_REQUEST", "至少需要一个产品行");
      return;
    }

    /**
     * ⚠️ 产品行校验挪到**碰数据库之前**（2026-08-29），跟别的入口一个规矩：
     * 参数本来就不合法的请求不该先查一轮库；而且自测想验它就得连库。
     */
    // 校验产品行必填字段
    for (let i = 0; i < body.products.length; i++) {
      const p = body.products[i];
      if (!p.productName?.trim()) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的产品名为必填`); return; }
      {
        const issue = validateConsolidationProductRow(p, i);
        if (issue) { fail(res, 400, "BAD_REQUEST", issue); return; }
      }
      if (!p.material?.trim()) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的材质为必填`); return; }
      if (!p.cargoValue?.trim()) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的货值为必填`); return; }
      if (p.cargoType && !CARGO_TYPES.includes(p.cargoType)) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的货型不合法`); return; }
    }

    // 校验任务
    const task = await prisma.consolidationTask.findFirst({
      // ⚠️ 必须带 companyId（2026-08-27 补）：原来只按 id 查，
      // 外部复审实测跨公司请求能返回 200 并改掉别家公司的数据。
      // 生产目前只有一家公司，暂时没影响，接第二家之前必须是现在这样。
      where: { id: body.taskId, companyId: auth.companyId },
    });
    if (!task || task.clientId !== auth.userId) {
      fail(res, 403, "FORBIDDEN", "无权操作该任务");
      return;
    }
    if (task.status !== "collecting") {
      fail(res, 400, "BAD_REQUEST", "只有收集中状态的任务才能添加预报单");
      return;
    }

    const productData = body.products.map((p, idx) => {
      const totalQuantity = p.packageCount! * p.quantityPerBox!;
      const totalWeightKg = parseFloat((p.unitWeightKg! * totalQuantity).toFixed(2));
      const volumeM3 = parseFloat(
        ((p.lengthCm! * p.widthCm! * p.heightCm!) / 1_000_000 * p.packageCount!).toFixed(6),
      );

      return {
        productName: p.productName!.trim(),
        packageCount: p.packageCount!,
        quantityPerBox: p.quantityPerBox!,
        totalQuantity,
        unitWeight: p.unitWeightKg!,
        totalWeight: totalWeightKg,
        length: p.lengthCm!,
        width: p.widthCm!,
        height: p.heightCm!,
        volume: volumeM3,
        material: p.material!.trim(),
        cargoValue: p.cargoValue!.trim(),
        cargoType: p.cargoType || "normal",
        sortOrder: idx,
      };
    });

    // 处理产品图片
    const imageDataList: Array<{
      idx: number;
      fileName: string;
      mime: string;
      base64: string | null;
    }> = [];
    for (let i = 0; i < body.products.length; i++) {
      const img = body.products[i].productImage;
      if (img?.base64 && img.mime) {
        const savedPath = saveImageToDisk(
          `consolidation_${Date.now()}`,
          img.mime,
          img.base64,
        );
        imageDataList.push({
          idx: i,
          fileName: img.fileName || savedPath.split("/").pop() || "",
          mime: img.mime,
          base64: savedPath,
        });
      }
    }

    /**
     * ⚠️ 插入必须**在锁里面**（2026-08-29 修）。
     * 上一版是「事务外插入 → 再开事务锁任务重算合计」——
     * 上面那道 `task.status !== "collecting"` 也在事务外，
     * 于是任务已经满柜确认、已报价、甚至已付款时，新预报单照样插得进去：
     * 客户看到的账单跟实际货物对不上，而报价那一步早就算完了。
     *
     * 现在：锁任务 → 重查状态 → 确认还在收货中 → 才插入 → 同一个事务里重算合计。
     */
    const prealert = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM consolidation_tasks WHERE id = ${body.taskId} FOR UPDATE`;
      const fresh = await tx.consolidationTask.findUnique({
        where: { id: body.taskId },
        select: { status: true },
      });
      if (!fresh) throw new BusinessError("集货任务不存在", 404, "NOT_FOUND");
      if (fresh.status !== "collecting") {
        throw new BusinessError(
          "这个集货任务刚刚已经不在收货中了（可能已满柜或已报价），预报单没有提交，请刷新后再看",
          409,
          "VALIDATION_ERROR",
        );
      }

      // ⚠️ 取号也在这个事务里做（2026-08-31 改，排查报告第54条）：
      // 原来在事务外面领号、放锁、再进来插入，两个客户同时提交会领到同一个号，
      // 后插入的撞唯一约束报「服务器繁忙」。锁序是【任务行锁 → 取号咨询锁】，
      // 跟仓库版（先锁计划再取号）一致；咨询锁 83002 只有这一处在用，不会跟别的路互相等。
      const trackingNo = await generateTrackingNo(tx);

      const created = await tx.consolidationPrealert.create({
        data: {
          taskId: body.taskId!,
          companyId: auth.companyId,
          clientId: auth.userId,
          trackingNo,
          expressNo: body.expressNo?.trim() || null,
          mark: body.mark!.trim(),
          status: "pending",
          products: {
            create: productData.map((pd, idx) => {
              const img = imageDataList.find((im) => im.idx === idx);
              return {
                ...pd,
                productImageFileName: img?.fileName || null,
                productImageMime: img?.mime || null,
                productImageBase64: img?.base64 || null,
              };
            }),
          },
        },
      });
      await recalcTaskTotals(body.taskId!, tx);
      return created;
    });

    ok(res, formatPrealert(prealert));
  });

  // 6) 更新预报单
  app.post("/client/consolidation/prealerts/update", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      prealertId?: string;
      mark?: string;
      expressNo?: string;
      products?: Array<{
        /** 已有产品行的编号；不传表示这是新增的一行 */
        id?: string;
        productName?: string;
        packageCount?: number;
        quantityPerBox?: number;
        unitWeightKg?: number;
        lengthCm?: number;
        widthCm?: number;
        heightCm?: number;
        material?: string;
        cargoValue?: string;
        cargoType?: string;
        /** 只有本次真的换了图才传；不传表示沿用原图 */
        productImage?: { fileName?: string; mime?: string; base64?: string };
      }>;
    };

    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }
    /**
     * ⚠️ 传了清单但是空的要当场拦（2026-08-31 补，排查报告第26条）。
     * 下面的校验循环是「有货才逐行查」，空数组会整个跳过；
     * 可事务里 `if (body.products)` 对空数组照样成立 —— 老行全删、新行一件不补，
     * 留下一张没有任何货物的空预报单。正常页面点不出这种请求（删行不让删到零），
     * 但接口直接调就能触发。跟新建时「至少一个产品行」的规矩对齐。
     */
    if (body.products && body.products.length === 0) {
      fail(res, 400, "BAD_REQUEST", "至少需要一个产品行");
      return;
    }

    const pa = await prisma.consolidationPrealert.findFirst({
      // ⚠️ 必须带 companyId（2026-08-27 补）：原来只按 id 查，实测能跨公司拿到别家数据
      where: { id: body.prealertId , companyId: auth.companyId },
      include: { task: true },
    });
    if (!pa || pa.clientId !== auth.userId) {
      fail(res, 403, "FORBIDDEN", "无权操作该预报单");
      return;
    }
    if (pa.status !== "pending") {
      fail(res, 400, "BAD_REQUEST", "已签收的预报单不能修改");
      return;
    }
    /**
     * ⚠️ 任务离开「收货中」后，客户就不能再改预报单了（2026-08-31 补，排查报告第9条）。
     * 原来只看预报单自己签没签收，不看任务走到哪一步 —— 任务已报价、客户已付款后，
     * 还没签收的那几张单客户照样能改（1 箱改成 50 箱），仓库照单签收，
     * 员工又改不了价（付款后不许改价），等于客户付一份钱多运货。
     * 「删除预报单」这个口子 8-28 已经堵了（付款后不许删），「修改」当时漏了没跟着补。
     * 口径跟「新增预报单」一致：任务必须还在收货中、且没付款。
     * 这道是事务外的友好提示，真正说了算的是下面锁内那道复查。
     */
    if (pa.task.status !== "collecting" || pa.task.paymentStatus !== "unpaid") {
      fail(res, 400, "BAD_REQUEST", "该任务已不在收货中（可能已满柜、已报价或已付款），预报单内容不能再修改");
      return;
    }
    // 校验产品
    if (body.products && body.products.length > 0) {
      for (let i = 0; i < body.products.length; i++) {
        const p = body.products[i];
        if (!p.productName?.trim()) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的产品名为必填`); return; }
        {
          // 三个入口共用同一份校验，见 validateConsolidationProductRow
          const issue = validateConsolidationProductRow(p, i);
          if (issue) { fail(res, 400, "BAD_REQUEST", issue); return; }
        }
        if (!p.material?.trim()) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的材质为必填`); return; }
        if (!p.cargoValue?.trim()) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的货值为必填`); return; }
        if (p.cargoType && !CARGO_TYPES.includes(p.cargoType)) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的货型不合法`); return; }
      }
    }

    // 事务内：产品行按行增量同步，不再整批删除重建
    const updated = await prisma.$transaction(async (tx) => {
      /**
       * ⚠️ 锁住再复查（2026-08-27 补）。上面「已签收的不能改」在事务外面：
       * 仓库正好在这一刻签收了，客户这边照样能改掉货物明细 ——
       * 签收单上写的和系统里存的就对不上了。
       */
      /**
       * ⚠️ 锁序统一成【任务 → 预报单】（2026-08-28 补）。
       * 删除那三条路是「先锁任务、再删预报单、锁内重算合计」；
       * 这条路原来只锁预报单、却又去写任务的合计 —— 方向正好相反，会死锁。
       * 而且合计原来在事务**外面**重算：删除那边刚把货删掉、这边用旧结果写回去，
       * 任务上的总件数/总方数就跟实际货物对不上了。
       */
      await tx.$queryRaw`SELECT id FROM consolidation_tasks WHERE id = ${pa.taskId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM consolidation_prealerts WHERE id = ${pa.id} FOR UPDATE`;
      // ⚠️ 任务状态锁后复查（2026-08-31 补，排查报告第9条）：
      // 上面那道「任务必须在收货中」是事务外的快照，员工正好在这一瞬间确认满柜/报价、
      // 客户正好付款，这边照样改得进去。锁住之后用重读的值说了算。
      const freshTask = await tx.consolidationTask.findUnique({
        where: { id: pa.taskId },
        select: { status: true, paymentStatus: true },
      });
      if (!freshTask) throw new BusinessError("集货任务不存在", 404, "NOT_FOUND");
      if (freshTask.status !== "collecting" || freshTask.paymentStatus !== "unpaid") {
        throw new BusinessError(
          "这个任务刚刚已经不在收货中了（可能已满柜、已报价或已付款），修改没有保存，请刷新后再看",
          409,
          "VALIDATION_ERROR",
        );
      }
      const freshPa = await tx.consolidationPrealert.findUnique({
        where: { id: pa.id },
        select: { status: true },
      });
      if (!freshPa) throw new BusinessError("预报单不存在", 404, "NOT_FOUND");
      if (freshPa.status !== "pending") {
        throw new BusinessError("这张预报单刚刚被仓库签收了，修改没有保存，请刷新后再看");
      }

      if (body.products) {
        const rows = body.products;
        const keepIds = rows
          .map((p) => p.id?.trim())
          .filter((v): v is string => Boolean(v));

        // 只删本次没提交的行
        await tx.consolidationPrealertProduct.deleteMany({
          where: {
            prealertId: body.prealertId,
            ...(keepIds.length > 0 ? { id: { notIn: keepIds } } : {}),
          },
        });

        for (let idx = 0; idx < rows.length; idx++) {
          const p = rows[idx];
          const totalQuantity = p.packageCount! * p.quantityPerBox!;
          const totalWeightKg = parseFloat((p.unitWeightKg! * totalQuantity).toFixed(2));
          const volumeM3 = parseFloat(
            ((p.lengthCm! * p.widthCm! * p.heightCm!) / 1_000_000 * p.packageCount!).toFixed(6),
          );
          const data = {
            productName: p.productName!.trim(),
            packageCount: p.packageCount!,
            quantityPerBox: p.quantityPerBox!,
            totalQuantity,
            unitWeight: p.unitWeightKg!,
            totalWeight: totalWeightKg,
            length: p.lengthCm!,
            width: p.widthCm!,
            height: p.heightCm!,
            volume: volumeM3,
            material: p.material!.trim(),
            cargoValue: p.cargoValue!.trim(),
            cargoType: p.cargoType || "normal",
            sortOrder: idx,
          };

          // 传了新图才落盘覆盖；没传就不动图片字段，原图保留
          const img = p.productImage;
          const imagePatch = img?.base64 && img.mime
            ? (() => {
                const savedPath = saveImageToDisk(`consolidation_${Date.now()}`, img.mime!, img.base64!);
                return {
                  productImageFileName: img.fileName || savedPath.split("/").pop() || "",
                  productImageMime: img.mime!,
                  productImageBase64: savedPath,
                };
              })()
            : {};

          const rowId = p.id?.trim();
          if (rowId) {
            await tx.consolidationPrealertProduct.updateMany({
              where: { id: rowId, prealertId: body.prealertId },
              data: { ...data, ...imagePatch },
            });
          } else {
            await tx.consolidationPrealertProduct.create({
              data: { prealertId: body.prealertId!, ...data, ...imagePatch },
            });
          }
        }
      }

      const updateData: any = {};
      if (body.mark?.trim()) updateData.mark = body.mark.trim();
      if (body.expressNo !== undefined) updateData.expressNo = body.expressNo?.trim() || null;

      const saved = await tx.consolidationPrealert.update({
        where: { id: body.prealertId },
        data: updateData,
      });
      // 合计必须在**握着任务锁的这个事务里**重算，不能等事务提交后再算
      await recalcTaskTotals(pa.taskId, tx);
      return saved;
    });

    ok(res, formatPrealert(updated));
  });

  // 7) 删除预报单
  app.post("/client/consolidation/prealerts/delete", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { prealertId?: string };
    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }

    const pa = await prisma.consolidationPrealert.findFirst({
      // ⚠️ 必须带 companyId（2026-08-27 补）：原来只按 id 查，实测能跨公司拿到别家数据
      where: { id: body.prealertId , companyId: auth.companyId },
    });
    if (!pa || pa.clientId !== auth.userId) {
      fail(res, 403, "FORBIDDEN", "无权删除该预报单");
      return;
    }
    if (pa.status !== "pending") {
      fail(res, 400, "BAD_REQUEST", "已签收的预报单不能删除");
      return;
    }

    /**
     * ⚠️ 2026-08-28 补：这条路原来只看预报单自己的 status，**没看任务付没付款**。
     * 任务已付款、这张预报单还没签收时，客户自己就能把它删掉 —— 货没了、钱不退。
     * 而且判断在事务外面：仓库正好在这一刻签收，判断和删除之间就能插进去。
     * 现在跟管理员那条走同一把尺子、同一套「锁住 → 重查 → 判断」。
     */
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM consolidation_tasks WHERE id = ${pa.taskId} FOR UPDATE`;
      const fresh = await tx.consolidationTask.findUnique({
        where: { id: pa.taskId },
        select: { status: true, paymentStatus: true },
      });
      if (!fresh) throw new BusinessError("集货任务不存在", 404, "NOT_FOUND");
      const verdict = checkConsolidationDeletable({
        paymentStatus: fresh.paymentStatus,
        taskStatus: fresh.status,
      });
      if (!verdict.ok) throw new BusinessError(verdict.message, 400, "BAD_REQUEST");

      // 锁后再确认这张单还没被签收（上面那道是事务外的快照）
      const freshPa = await tx.consolidationPrealert.findUnique({
        where: { id: pa.id },
        select: { status: true },
      });
      if (!freshPa) throw new BusinessError("预报单不存在", 404, "NOT_FOUND");
      if (freshPa.status !== "pending") {
        throw new BusinessError("这张预报单刚刚被仓库签收了，没有删除，请刷新后再看", 409, "VALIDATION_ERROR");
      }

      await tx.consolidationPrealert.delete({ where: { id: body.prealertId } });
      await recalcTaskTotals(pa.taskId, tx);
    });

    ok(res, { deleted: true, id: body.prealertId });
  });

  // 8) 提交付款凭证（客户上传截图 → 待员工审核）
  // ==========================================================================
  // 客户付款：用集货余额直接扣（2026-08-07 改）
  // 原来是上传付款凭证 → 等员工审核。现在改成余额支付：当场扣钱、当场付清，
  // 不用传水单、不用审核。水单只在充值那一步传一次。
  // 误操作由管理员端「撤销付款」兜底（退钱 + 回到未付款）。
  // ==========================================================================
  app.post("/client/consolidation/pay", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { taskId?: string };
    if (!body.taskId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }

    const task = await prisma.consolidationTask.findFirst({
      // ⚠️ 必须带 companyId（2026-08-27 补）：原来只按 id 查，
      // 外部复审实测跨公司请求能返回 200 并改掉别家公司的数据。
      // 生产目前只有一家公司，暂时没影响，接第二家之前必须是现在这样。
      where: { id: body.taskId, companyId: auth.companyId },
    });
    if (!task || task.clientId !== auth.userId) {
      fail(res, 403, "FORBIDDEN", "无权操作该任务");
      return;
    }
    if (task.status !== "quoted") {
      fail(res, 400, "BAD_REQUEST", "只有已报价的任务才能付款");
      return;
    }
    if (task.paymentStatus === "paid") {
      fail(res, 400, "BAD_REQUEST", "该任务已付款，不用重复付");
      return;
    }

    const amount = task.totalFee == null ? 0 : Number(task.totalFee);
    if (!(amount > 0)) {
      fail(res, 400, "BAD_REQUEST", "这个任务还没有报价金额，请联系客服核对后再付款");
      return;
    }

    try {
      const paid = await prisma.$transaction(async (tx) => {
        /**
         * ⚠️⚠️ 事务里必须**重新读一遍并锁住这张任务**（2026-08-25 新增）。
         *
         * 上面那几道 `if` 是在事务**外面**查的。客户手抖点两下「付款」，
         * 两个请求会同时通过那几道检查、各自开事务、各扣一次钱 ——
         * 单子只有一张，钱扣了两遍。前端禁用按钮挡不住（抓包重放、网络重试都能绕过）。
         *
         * FOR UPDATE 之后，第二个请求会卡在这里等第一个提交完，
         * 然后读到 paymentStatus 已经是 paid，直接报「已付款」退出，一分钱不扣。
         *
         * ⚠️ 金额也要用**事务里读出来的**：员工可能正好在这一刻改了报价，
         * 用事务外那个旧金额会扣错数。
         */
        await tx.$queryRaw`SELECT id FROM consolidation_tasks WHERE id = ${task.id} FOR UPDATE`;
        const fresh = await tx.consolidationTask.findUnique({
          where: { id: task.id },
          select: { status: true, paymentStatus: true, totalFee: true },
        });
        if (!fresh || fresh.status !== "quoted") {
          throw new PaymentConflictError("这个任务的状态刚刚变了，请刷新页面后再试");
        }
        if (fresh.paymentStatus === "paid") {
          throw new PaymentConflictError("该任务已付款，不用重复付");
        }
        const amount = fresh.totalFee == null ? 0 : Number(fresh.totalFee);
        if (!(amount > 0)) {
          throw new PaymentConflictError("这个任务还没有报价金额，请联系客服核对后再付款");
        }

        // 扣钱和改状态必须在同一个事务里
        const after = await chargeForConsolidation(tx as any, {
          companyId: auth.companyId,
          clientId: auth.userId,
          amount,
          refType: "normal",
          refId: task.id,
          refNo: task.taskNo,
          remark: "普通版集货付款",
          operatorId: auth.userId,
          // 客户自己付的款：操作人记唛头，不记客户名字（2026-09-19，见 operatorNameForDisplay）
          operatorName: auth.userId,
        });
        await tx.consolidationTask.update({
          where: { id: task.id },
          data: {
            paymentStatus: "paid",
            // ⚠️ 流程状态也要往前走（2026-08-27 补）。
            // 原来只改 paymentStatus，status 还停在 quoted，后果实测有三条：
            //   ① 已经付过钱的任务进不了装柜（装柜要求 status=paid）
            //   ② 员工还能重新报价，把已付款任务的金额从 100 改成 999
            //   ③ 还能被取消，而且一分钱不退
            status: "paid",
            paymentProofUploadedAt: new Date(),
            paymentRejectReason: null,
          },
        });
        await tx.consolidationStatusLog.create({
          data: {
            taskId: task.id,
            companyId: auth.companyId,
            operatorId: auth.userId,
            operatorRole: auth.role,
            operatorName: auth.userId, // 客户自己付的款：记唛头（2026-09-19）
            fromStatus: "quoted",
            toStatus: "paid",
            remark: `客户用集货余额付款 ¥${amount.toFixed(2)}`,
          },
        });
        return { balanceAfter: after, amount };
      });

      ok(res, {
        success: true,
        taskId: task.id,
        paidAmount: paid.amount,
        balanceAfter: paid.balanceAfter,
        message: `付款成功，已扣 ¥${paid.amount.toFixed(2)}，集货余额剩余 ¥${paid.balanceAfter.toFixed(2)}`,
      });
    } catch (e) {
      if (e instanceof InsufficientBalanceError || e instanceof PaymentConflictError) {
        fail(res, 400, "BAD_REQUEST", e.message);
        return;
      }
      throw e;
    }
  });

  // ==========================================================================
  // ==========================================================================
  // 付款审核接口（员工 / 管理员）
  // ==========================================================================

  // 审核通过 — 确认付款
  app.post("/staff/consolidation/review-payment", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { taskId?: string };
    if (!body.taskId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }

    const task = await prisma.consolidationTask.findFirst({
      // ⚠️ 必须带 companyId（2026-08-27 补）：原来只按 id 查，
      // 外部复审实测跨公司请求能返回 200 并改掉别家公司的数据。
      // 生产目前只有一家公司，暂时没影响，接第二家之前必须是现在这样。
      where: { id: body.taskId, companyId: auth.companyId },
    });
    if (!task || task.companyId !== auth.companyId) {
      fail(res, 403, "FORBIDDEN", "无权操作该任务");
      return;
    }
    if (task.paymentStatus !== "pending_review") {
      fail(res, 400, "BAD_REQUEST", "当前没有待审核的付款");
      return;
    }

    const now = new Date();

    await prisma.$transaction(async (tx) => {
      /**
       * ⚠️ 锁住再复查（2026-08-27 补）。上面那道「有没有待审核的付款」在事务外面：
       * 一个人点「通过」一个人点「拒绝」，两边都能过，最后谁写完谁算数 ——
       * 同一笔付款可能既写了「已通过」的记录又写了「已拒绝」的记录。
       */
      await tx.$queryRaw`SELECT id FROM consolidation_tasks WHERE id = ${task.id} FOR UPDATE`;
      const fresh = await tx.consolidationTask.findUnique({
        where: { id: task.id },
        select: { paymentStatus: true },
      });
      if (!fresh) throw new BusinessError("集货任务不存在", 404, "NOT_FOUND");
      if (fresh.paymentStatus !== "pending_review") {
        throw new BusinessError("这笔付款刚刚已经被别人审核过了，请刷新后再看");
      }

      await tx.consolidationTask.update({
        where: { id: body.taskId },
        data: {
          paymentStatus: "paid",
          paidAt: now,
          paymentReviewedAt: now,
          paymentReviewedBy: auth.userId,
          status: "paid",
        },
      });

      await tx.consolidationStatusLog.create({
        data: {
          taskId: body.taskId!,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: "quoted",
          toStatus: "paid",
          remark: "付款审核通过",
        },
      });

      return null;
    });

    ok(res, { success: true, taskId: body.taskId, paymentStatus: "paid" });
  });

  // 审核拒绝 — 退回付款
  app.post("/staff/consolidation/reject-payment", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { taskId?: string; reason?: string };
    if (!body.taskId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }
    if (!body.reason?.trim()) {
      fail(res, 400, "BAD_REQUEST", "拒绝原因为必填");
      return;
    }

    const task = await prisma.consolidationTask.findFirst({
      // ⚠️ 必须带 companyId（2026-08-27 补）：原来只按 id 查，
      // 外部复审实测跨公司请求能返回 200 并改掉别家公司的数据。
      // 生产目前只有一家公司，暂时没影响，接第二家之前必须是现在这样。
      where: { id: body.taskId, companyId: auth.companyId },
    });
    if (!task || task.companyId !== auth.companyId) {
      fail(res, 403, "FORBIDDEN", "无权操作该任务");
      return;
    }
    if (task.paymentStatus !== "pending_review") {
      fail(res, 400, "BAD_REQUEST", "当前没有待审核的付款");
      return;
    }

    await prisma.$transaction(async (tx) => {
      /**
       * ⚠️ 锁住再复查（2026-08-27 补）。上面那道「有没有待审核的付款」在事务外面：
       * 一个人点「通过」一个人点「拒绝」，两边都能过，最后谁写完谁算数 ——
       * 同一笔付款可能既写了「已通过」的记录又写了「已拒绝」的记录。
       */
      await tx.$queryRaw`SELECT id FROM consolidation_tasks WHERE id = ${task.id} FOR UPDATE`;
      const fresh = await tx.consolidationTask.findUnique({
        where: { id: task.id },
        select: { paymentStatus: true },
      });
      if (!fresh) throw new BusinessError("集货任务不存在", 404, "NOT_FOUND");
      if (fresh.paymentStatus !== "pending_review") {
        throw new BusinessError("这笔付款刚刚已经被别人审核过了，请刷新后再看");
      }

      await tx.consolidationTask.update({
        where: { id: body.taskId },
        data: {
          paymentStatus: "unpaid",
          paymentRejectReason: body.reason!.trim(),
          paymentReviewedAt: new Date(),
          paymentReviewedBy: auth.userId,
          // 任务状态保持 quoted
        },
      });

      await tx.consolidationStatusLog.create({
        data: {
          taskId: body.taskId!,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: "quoted",
          toStatus: "quoted",
          remark: `付款审核不通过：${body.reason!.trim()}`,
        },
      });

      return null;
    });

    ok(res, { success: true, taskId: body.taskId, paymentStatus: "unpaid" });
  });

  // ==========================================================================
  // 员工端接口
  // ==========================================================================


  // 1) 任务列表（员工视角，看所有客户）
  app.get("/staff/consolidation/tasks", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const statusFilter = (req.query as any)?.status as string | undefined;
    const where: any = { companyId: auth.companyId };
    if (statusFilter) where.status = statusFilter;

    const tasks = await prisma.consolidationTask.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        client: { select: { id: true, name: true, phone: true } },
        // 与 /client/consolidation/tasks 保持同一写法。
        // 原来是 include: { products: true } —— 把每个任务下所有预报单的
        // 所有商品（含 product_image_base64 整张商品照片）全都带出来。
        // 但列表页只显示任务编号/客户/目的地/进度/状态/创建时间六列，
        // 商品和照片是点开任务后由详情接口单独取的，列表里这份从来没被读过。
        // 参见 CLAUDE.md 教训 #3「大数据量字段不要随列表返回」、规则 8b「三端列表条件必须一致」。
        prealerts: { select: { id: true, status: true } },
      },
    });

    const result = tasks.map((t) => ({
      // 2026-09-15：paymentReviewedBy（审核人账号）只给超级管理员
      ...hideOperatorIdentity(formatTaskForList(t), auth.role),
      clientName: t.client.name,
      clientPhone: t.client.phone,
      volumePercent: calcVolumePercent(t),
      isNearFull: calcVolumePercent(t) >= 85,
      prealertCount: t.prealerts.length,
    }));

    ok(res, result);
  });

  // 2) 任务详情（员工视角）
  app.get("/staff/consolidation/tasks/detail", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const taskId = (req.query as any)?.taskId as string | undefined;
    if (!taskId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }

    const task = await prisma.consolidationTask.findFirst({
      // ⚠️ 必须带 companyId（2026-08-27 补）：原来只按 id 查，实测能跨公司拿到别家数据
      where: { id: taskId , companyId: auth.companyId },
      include: {
        client: { select: { id: true, name: true, phone: true } },
        prealerts: {
          orderBy: { createdAt: "asc" },
          include: { products: { orderBy: { sortOrder: "asc" } } },
        },
        statusLogs: { orderBy: { createdAt: "desc" } },
      },
    });

    if (!task) {
      fail(res, 404, "NOT_FOUND", "任务不存在");
      return;
    }

    ok(res, {
      // 2026-09-15：这个接口员工和管理员共用（管理员端集货详情也调它），按角色摘审核人
      ...hideOperatorIdentity(formatTask(task), auth.role),
      clientName: task.client.name,
      clientPhone: task.client.phone,
      volumePercent: calcVolumePercent(task),
      isNearFull: calcVolumePercent(task) >= 85,
      prealerts: task.prealerts.map((pa) => ({
        ...formatPrealert(pa),
        products: pa.products.map(formatProduct),
      })),
      statusLogs: task.statusLogs.map((log) => formatStatusLogForViewer(log, auth.role)),
    });
  });

  // 3) 签收预报单
  app.post("/staff/consolidation/prealerts/receive", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { prealertId?: string; proofBase64?: string; proofFileName?: string; proofMime?: string };
    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }

    const pa = await prisma.consolidationPrealert.findFirst({
      // ⚠️ 必须带 companyId（2026-08-27 补）：原来只按 id 查，可以跨公司操作别家的单
      where: { id: body.prealertId, companyId: auth.companyId },
    });
    if (!pa) {
      fail(res, 404, "NOT_FOUND", "预报单不存在");
      return;
    }
    if (pa.status !== "pending") {
      fail(res, 400, "BAD_REQUEST", "该预报单已签收");
      return;
    }
    if (!body.proofBase64?.trim()) {
      fail(res, 400, "BAD_REQUEST", "签收照片为必填");
      return;
    }

    const now = new Date();

    // 处理签收照片（必填）
    const proofPath = saveImageToDisk(`consolidation_receive_${Date.now()}`, body.proofMime || "image/png", body.proofBase64!);

    /**
     * ⚠️ 把「还没签收」写进 where（2026-08-28 补）。
     * 上面那道 `pa.status !== "pending"` 是在这之前单独查出来判断的，
     * 两个仓管同时点「签收」都能通过，各写一次签收时间和凭证 ——
     * 后一次会把前一次的凭证覆盖掉。
     * 用 updateMany 把状态写进条件，数据库自己保证只有一个人改得动，
     * 不用为这一处专门开事务。
     */
    /**
     * ⚠️ 改状态和重算合计必须在**同一个任务锁**里（2026-08-29 修）。
     *
     * 上一版把 updateMany 留在锁外面，理由是「它带 status:"pending" 条件、本身是原子的」。
     * 那句话对，但**不够** —— 原子只保证「不会两个人同时签成功」，
     * 挡不住别人在这中间用旧清单写合计：
     * 删除那条路握着任务锁 → 读预报单清单（这张还是 pending，不计入合计）
     * → 删掉另一张 → 写合计。这边的签收随后提交，
     * **任务上的总件数/总方数就少了这一张**，直到下一次重算才对得上。
     *
     * 现在整段进锁：谁先拿到任务锁谁先做，另一个看到的一定是提交后的真实状态。
     * `status: "pending"` 那个条件保留 —— 它顺便挡住「已经被签收了」的重复提交。
     */
    const received = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM consolidation_tasks WHERE id = ${pa.taskId} FOR UPDATE`;
      /**
       * ⚠️ 顺手看一眼任务付没付款（2026-08-31 补，排查报告第9条）。
       * 报价是按签收时点的货算的：任务已付款之后才到仓签收的单，
       * 它的货不在当初报价的账里。修改那条路已经堵死（付款后客户改不了货），
       * 这里再给员工提个醒，让他知道这张是「付款后补签收」的，方便回头核对报价。
       * 只提醒不拦：货真到了仓库总得签收，拦了就没法收货了。
       * 用锁内重读的值，不吃事务外的快照。
       */
      const freshTask = await tx.consolidationTask.findUnique({
        where: { id: pa.taskId },
        select: { paymentStatus: true },
      });
      const done = await tx.consolidationPrealert.updateMany({
        where: { id: body.prealertId, companyId: auth.companyId, status: "pending" },
        data: {
          status: "received",
          signedAt: now,
          receivedProofFileName: body.proofFileName?.trim() || proofPath.split("/").pop() || "",
          receivedProofMime: body.proofMime?.trim() || "image/png",
          receivedProofBase64: proofPath,
        },
      });
      if (done.count === 0) return { count: done.count, paidBeforeReceive: false };
      await recalcTaskTotals(pa.taskId, tx);
      return { count: done.count, paidBeforeReceive: freshTask?.paymentStatus !== "unpaid" };
    });
    if (received.count === 0) {
      fail(res, 400, "BAD_REQUEST", "这张预报单刚刚已经被签收了，请刷新后再看");
      return;
    }
    if (received.paidBeforeReceive) {
      // 留一条日志：万一前端没把提醒显示出来，事后也能查到这张单是付款后签收的
      logger.warn("集货预报单在任务付款后才签收，请核对报价", {
        预报单: body.prealertId, 任务: pa.taskId, 操作人: auth.userId,
      });
    }

    ok(res, {
      success: true,
      prealertId: body.prealertId,
      status: "received",
      // 前端没读这个字段也不碍事；读了就能把提醒弹出来
      ...(received.paidBeforeReceive
        ? { warning: "这张预报单是任务付款之后才签收的，这批货不在当初报价的账里，请核对报价是否需要调整" }
        : {}),
    });
  });

  // 4) 确认满柜
  app.post("/staff/consolidation/tasks/confirm-full", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { taskId?: string };
    if (!body.taskId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }

    const task = await prisma.consolidationTask.findFirst({
      // ⚠️ 必须带 companyId（2026-08-27 补）：原来只按 id 查，
      // 外部复审实测跨公司请求能返回 200 并改掉别家公司的数据。
      // 生产目前只有一家公司，暂时没影响，接第二家之前必须是现在这样。
      where: { id: body.taskId, companyId: auth.companyId },
    });
    if (!task) {
      fail(res, 404, "NOT_FOUND", "任务不存在");
      return;
    }
    if (task.status !== "collecting") {
      fail(res, 400, "BAD_REQUEST", "只有收集中状态的任务才能确认满柜");
      return;
    }

    await prisma.$transaction(async (tx) => {
      // 锁住再复查一遍状态（2026-08-28 补）：上面那道检查是在事务外面做的，
      // 两个人同时操作会都通过，最后谁写完算谁的，还会各写一条流转记录。
      await tx.$queryRaw`SELECT id FROM consolidation_tasks WHERE id = ${task.id} FOR UPDATE`;
      const fresh = await tx.consolidationTask.findUnique({
        where: { id: task.id },
        select: { status: true },
      });
      if (!fresh) throw new BusinessError("集货任务不存在", 404, "NOT_FOUND");
      if (fresh.status !== "collecting") {
        throw new BusinessError("这个任务的状态刚刚变了，确认满柜没有执行，请刷新后再看");
      }

      await tx.consolidationTask.update({
        where: { id: body.taskId },
        data: { status: "full_confirmed" },
      });

      await tx.consolidationStatusLog.create({
        data: {
          taskId: body.taskId!,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: "collecting",
          toStatus: "full_confirmed",
        },
      });

      return null;
    });

    ok(res, { success: true, taskId: body.taskId, status: "full_confirmed" });
  });

  // 5) 报价
  app.post("/staff/consolidation/tasks/quote", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      taskId?: string;
      bookingFee?: number;
      customsFee?: number;
      loadingFee?: number;
    };

    if (!body.taskId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }
    if (body.bookingFee === undefined || body.bookingFee === null) {
      fail(res, 400, "BAD_REQUEST", "订舱费为必填");
      return;
    }
    if (body.customsFee === undefined || body.customsFee === null) {
      fail(res, 400, "BAD_REQUEST", "清关费为必填");
      return;
    }
    if (body.loadingFee === undefined || body.loadingFee === null) {
      fail(res, 400, "BAD_REQUEST", "装柜费为必填");
      return;
    }

    /**
     * ⚠️ 三个费用必须是**有限的非负数**（2026-08-27 补）。
     * 原来只判了「有没有传」，不判值 —— 实测提交 -10 会返回 200、
     * 把 totalFee 写成 -10 并把状态改成「已报价」，负数直接进财务合计。
     * 字符串同理：`"abc" + 0 + 0` 会算出 NaN。
     */
    // ⚠️ 用 unknown：body 是 JSON 传进来的，类型声明说是 number 不代表运行时就是 number
    const feeFields: Array<[string, unknown]> = [
      ["订舱费", body.bookingFee], ["清关费", body.customsFee], ["装柜费", body.loadingFee],
    ];
    // 校验过程中顺手把每一项转成干净的数字，**下面写库要用这个**，不能再用原始值
    const cleanFee: Record<string, number> = {};
    for (const [label, v] of feeFields) {
      // ⚠️ 不能直接 Number()：`Number("")`、`Number(" ")`、`Number(false)` 都等于 0，
      // 会被当成「报价 0 元」放过去，再在 Prisma 那边炸成 500（外部复审实测）。
      if (typeof v !== "number" && typeof v !== "string") {
        fail(res, 400, "BAD_REQUEST", `${label}必须填数字`);
        return;
      }
      if (typeof v === "string" && v.trim() === "") {
        fail(res, 400, "BAD_REQUEST", `${label}不能为空`);
        return;
      }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        fail(res, 400, "BAD_REQUEST", `${label}必须是 0 或正数`);
        return;
      }
      if (n > 10_000_000) {
        fail(res, 400, "BAD_REQUEST", `${label}超出合理范围，请核对后重填`);
        return;
      }
      /**
       * ⚠️ 小数位也要卡死（2026-08-31 补，排查报告第25条）。
       * 这三列在库里是 Decimal(12,2)：填 10.994 会被各自抹成 10.99，
       * 总价却是先相加再抹 —— 两种抹法差一分钱，客户拿计算器一对就对不上。
       * 走本文件已经在用的 requireDecimal 统一检查；min 设 0 是保住
       * 原有「0 或正数」的口径（装柜费经常就是 0），别的入口不受影响。
       */
      const decIssue = requireDecimal(n, label, { ...DECIMAL_12_2, min: 0 });
      if (decIssue) {
        fail(res, 400, "BAD_REQUEST", decIssue);
        return;
      }
      cleanFee[label] = n;
    }

    const task = await prisma.consolidationTask.findFirst({
      // ⚠️ 必须带 companyId（2026-08-27 补）：原来只按 id 查，
      // 外部复审实测跨公司请求能返回 200 并改掉别家公司的数据。
      // 生产目前只有一家公司，暂时没影响，接第二家之前必须是现在这样。
      where: { id: body.taskId, companyId: auth.companyId },
    });
    if (!task) {
      fail(res, 404, "NOT_FOUND", "任务不存在");
      return;
    }
    if (task.status !== "full_confirmed" && task.status !== "quoted") {
      fail(res, 400, "BAD_REQUEST", "只有已满柜或已报价状态的任务才能报价");
      return;
    }


    const totalFee = parseFloat((cleanFee["订舱费"] + cleanFee["清关费"] + cleanFee["装柜费"]).toFixed(2));
    const isFirstQuote = task.status === "full_confirmed";

    await prisma.$transaction(async (tx) => {
      /**
       * ⚠️ 锁住再复查（2026-08-27 补）。上面那道状态检查在事务外面：
       * 客户正好在这一瞬间付了款，员工这边照样能把已付款任务的金额从 100 改成 999，
       * 而钱已经按 100 扣走了，账就对不上了。锁住之后第二个人会看到状态已经是 paid，直接被拦。
       */
      await tx.$queryRaw`SELECT id FROM consolidation_tasks WHERE id = ${task.id} FOR UPDATE`;
      const fresh = await tx.consolidationTask.findUnique({
        where: { id: task.id },
        select: { status: true, paymentStatus: true },
      });
      if (!fresh) throw new BusinessError("任务不存在", 404, "NOT_FOUND");
      if (fresh.paymentStatus !== "unpaid") {
        throw new BusinessError("客户已经付款（或正在审核付款），不能再改价。要改请先撤销付款");
      }
      if (fresh.status !== "full_confirmed" && fresh.status !== "quoted") {
        throw new BusinessError("这个任务的状态刚刚变了，报价没有保存，请刷新后再看");
      }

      await tx.consolidationTask.update({
        where: { id: body.taskId },
        data: {
          // ⚠️ 必须写上面转好的数字，不能写 body 里的原始值（2026-08-27 补）：
          // 前端传 " 1.25 "（带空格）时校验能过（Number 会忽略空格），
          // 但直接丢给数据库会解析失败，用户看到的是「服务器错误」而不是提示。
          bookingFee: cleanFee["订舱费"],
          customsFee: cleanFee["清关费"],
          loadingFee: cleanFee["装柜费"],
          totalFee,
          ...(isFirstQuote ? { status: "quoted" } : {}),
        },
      });

      if (isFirstQuote) {
        await tx.consolidationStatusLog.create({
          data: {
            taskId: body.taskId!,
            companyId: auth.companyId,
            operatorId: auth.userId,
            operatorRole: auth.role,
            operatorName: auth.name || auth.userId,
            fromStatus: "full_confirmed",
            toStatus: "quoted",
            remark: `报价：订舱${body.bookingFee} + 清关${body.customsFee} + 装柜${body.loadingFee} = ${totalFee}`,
          },
        });
      }

      return null;
    });

    ok(res, { success: true, taskId: body.taskId, totalFee, isFirstQuote });
  });

  // 6) 推进状态
  app.post("/staff/consolidation/tasks/advance-status", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { taskId?: string; toStatus?: string; remark?: string };

    if (!body.taskId?.trim() || !body.toStatus?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 和 toStatus 为必填");
      return;
    }

    // 状态流转校验
    const validTransitions: Record<string, string> = {
      paid: "loading",
      loading: "in_transit",
      in_transit: "customs",
      customs: "delivering",
      delivering: "completed",
    };

    const task = await prisma.consolidationTask.findFirst({
      // ⚠️ 必须带 companyId（2026-08-27 补）：原来只按 id 查，
      // 外部复审实测跨公司请求能返回 200 并改掉别家公司的数据。
      // 生产目前只有一家公司，暂时没影响，接第二家之前必须是现在这样。
      where: { id: body.taskId, companyId: auth.companyId },
    });
    if (!task) {
      fail(res, 404, "NOT_FOUND", "任务不存在");
      return;
    }

    const expectedNext = validTransitions[task.status];
    if (!expectedNext) {
      fail(res, 400, "BAD_REQUEST", `当前状态 ${task.status} 不允许推进`);
      return;
    }
    if (body.toStatus !== expectedNext) {
      fail(res, 400, "BAD_REQUEST", `当前状态 ${task.status} 只能转到 ${expectedNext}，不能转到 ${body.toStatus}`);
      return;
    }

    await prisma.$transaction(async (tx) => {
      // 锁住再复查一遍状态（2026-08-28 补）：上面那道检查是在事务外面做的，
      // 两个人同时操作会都通过，最后谁写完算谁的，还会各写一条流转记录。
      await tx.$queryRaw`SELECT id FROM consolidation_tasks WHERE id = ${task.id} FOR UPDATE`;
      const fresh = await tx.consolidationTask.findUnique({
        where: { id: task.id },
        select: { status: true },
      });
      if (!fresh) throw new BusinessError("集货任务不存在", 404, "NOT_FOUND");
      if (fresh.status !== task.status) {
        throw new BusinessError("这个任务的状态刚刚变了，推进没有执行，请刷新后再看");
      }

      await tx.consolidationTask.update({
        where: { id: body.taskId },
        data: { status: body.toStatus },
      });

      await tx.consolidationStatusLog.create({
        data: {
          taskId: body.taskId!,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: task.status,
          toStatus: body.toStatus!,
          remark: body.remark?.trim() || null,
        },
      });

      return null;
    });

    ok(res, { success: true, taskId: body.taskId, fromStatus: task.status, toStatus: body.toStatus });
  });

  // 7) 装柜
  app.post("/staff/consolidation/tasks/loading", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { taskId?: string; containerNo?: string; loadingDate?: string };

    if (!body.taskId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }

    const task = await prisma.consolidationTask.findFirst({
      // ⚠️ 必须带 companyId（2026-08-27 补）：原来只按 id 查，
      // 外部复审实测跨公司请求能返回 200 并改掉别家公司的数据。
      // 生产目前只有一家公司，暂时没影响，接第二家之前必须是现在这样。
      where: { id: body.taskId, companyId: auth.companyId },
    });
    if (!task) {
      fail(res, 404, "NOT_FOUND", "任务不存在");
      return;
    }
    if (task.status !== "paid") {
      fail(res, 400, "BAD_REQUEST", "只有已付款的任务才能装柜");
      return;
    }

    await prisma.$transaction(async (tx) => {
      // 锁住再复查一遍状态（2026-08-28 补）：上面那道检查是在事务外面做的，
      // 两个人同时操作会都通过，最后谁写完算谁的，还会各写一条流转记录。
      await tx.$queryRaw`SELECT id FROM consolidation_tasks WHERE id = ${task.id} FOR UPDATE`;
      const fresh = await tx.consolidationTask.findUnique({
        where: { id: task.id },
        select: { status: true },
      });
      if (!fresh) throw new BusinessError("集货任务不存在", 404, "NOT_FOUND");
      if (fresh.status !== "paid") {
        throw new BusinessError("这个任务的状态刚刚变了，装柜没有执行，请刷新后再看");
      }

      await tx.consolidationTask.update({
        where: { id: body.taskId },
        data: {
          containerNo: body.containerNo?.trim() || null,
          loadingDate: body.loadingDate?.trim() || null,
          status: "loading",
        },
      });

      await tx.consolidationStatusLog.create({
        data: {
          taskId: body.taskId!,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: "paid",
          toStatus: "loading",
          remark: body.containerNo ? `柜号: ${body.containerNo}` : null,
        },
      });

      return null;
    });

    ok(res, { success: true, taskId: body.taskId, status: "loading" });
  });

  // 8) 取消任务
  app.post("/staff/consolidation/tasks/cancel", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { taskId?: string; confirmPassword?: string; adminAccount?: string };
    if (!body.taskId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }

    const task = await prisma.consolidationTask.findFirst({
      // ⚠️ 必须带 companyId（2026-08-27 补）：原来只按 id 查，
      // 外部复审实测跨公司请求能返回 200 并改掉别家公司的数据。
      // 生产目前只有一家公司，暂时没影响，接第二家之前必须是现在这样。
      where: { id: body.taskId, companyId: auth.companyId },
    });
    if (!task) {
      fail(res, 404, "NOT_FOUND", "任务不存在");
      return;
    }

    const cancellable = ["collecting", "full_confirmed", "quoted"];
    if (!cancellable.includes(task.status)) {
      fail(res, 400, "BAD_REQUEST", `当前状态 ${task.status} 不允许取消，只能取消收集中/已满柜/已报价的任务`);
      return;
    }

    /**
     * ⚠️ 有已签收的货，取消必须带管理员密码（2026-08-31 补，排查报告第2条）。
     * 取消会把这个任务的全部预报单、货物明细、签收凭证、状态历史**物理删光**——
     * 签收凭证就存在预报单上，删预报单等于销毁签收证据：货还堆在仓库里，
     * 系统里却查无此货。同一批数据走「管理员删除任务」那条路，只要有已收货的单
     * 就必须输管理员密码（2026-08-07 定的规矩），取消这条路原来一道保护都没有。
     * 现在两条路用同一把尺子：没签收货的照旧两下点掉；有签收货的要输密码。
     * 密码验证照 tasks/delete 那套（passwordVerified），差别只有一点：
     * 这个接口员工也能调，验员工自己的密码不算「管理员拍板」，
     * 所以密码要对得上本公司**管理员**账号才算数。
     *
     * ⚠️ 必须指名验**哪一个**管理员（2026-08-31 Codex 复核）。
     * 原来是「拿密码去挨个试全公司所有管理员」—— 员工每发一次请求，
     * 等于同时猜 N 个管理员的密码，而且不限次数，这接口成了猜密码的口子。
     * 现在改成：前端多传一个 adminAccount（管理员账号），只验这一个账号
     * （必须是本公司、role=admin、在职）；账号没传/不对/密码不对，一律同一句 403，
     * 不让人从提示语里区分「账号错」还是「密码错」。
     *
     * ⚠️ 再补一道失败限流（同一次复核）：留痕日志只能事后查，挡不住当场硬猜。
     * 复用 core/rate-limit 那套失败计数（键按**操作者**算，前缀 cancel-pw，
     * 换任务、换管理员账号都躲不掉）：30 分钟内错 5 次就拒绝再试，验对了清零。
     * 跟登录限流一样，计数在进程内存里，API 重启会清零 —— 这是那个模块的已知前提。
     */
    const cancelPwLimitKey = rateLimitKey(auth.userId, "cancel-pw");
    const CANCEL_PW_FAIL_MAX = 5;
    const CANCEL_PW_FAIL_WINDOW_MS = 30 * 60_000;
    let passwordVerified = false;
    if (body.confirmPassword?.trim()) {
      if (isFailureBlocked(cancelPwLimitKey, CANCEL_PW_FAIL_MAX)) {
        const waitMinutes = Math.max(1, Math.ceil(failureRetryAfterMs(cancelPwLimitKey, CANCEL_PW_FAIL_MAX) / 60_000));
        fail(res, 403, "FORBIDDEN", `管理员密码错的次数太多，请 ${waitMinutes} 分钟后再试，取消没有执行`);
        return;
      }
      const adminAccount = body.adminAccount?.trim();
      const admin = adminAccount
        ? await prisma.user.findFirst({
            where: { id: adminAccount, companyId: auth.companyId, role: "admin", status: "active" },
            select: { passwordHash: true },
          })
        : null;
      if (!admin || !verifyPassword(body.confirmPassword, admin.passwordHash ?? "")) {
        recordFailure(cancelPwLimitKey, CANCEL_PW_FAIL_WINDOW_MS);
        // ⚠️ 密码错也要留痕（2026-08-31 补，复查报告）：限流只挡当场硬猜，
        // 谁在拿谁的任务反复试管理员密码，事后还是靠这条日志查。
        logger.warn("取消集货任务：管理员密码验证失败", {
          操作人: auth.userId, 操作角色: auth.role, 任务号: task.taskNo,
          填的管理员账号: adminAccount || "(没填)",
        });
        fail(res, 403, "FORBIDDEN", "管理员账号或管理员密码不对，没有取消");
        return;
      }
      clearFailures(cancelPwLimitKey);
      passwordVerified = true;
    }
    const receivedCount = await prisma.consolidationPrealert.count({
      where: { taskId: body.taskId, status: "received" },
    });
    if (receivedCount > 0 && !passwordVerified) {
      fail(res, 409, "VALIDATION_ERROR",
        `这个集货任务不能直接取消：有 ${receivedCount} 张预报单已签收，取消会把签收记录一并删掉。确实要取消请输入管理员账号和管理员密码。`);
      return;
    }

    // 事务回调最后 return 锁内数出来的已签收张数，取消成功后写日志要用（CLAUDE.md 第7条：回调必须 return）
    const deletedReceivedCount = await prisma.$transaction(async (tx) => {
      /**
       * ⚠️ 锁住再复查（2026-08-27 补）。上面那道状态检查在事务外面：
       * 客户正好在这一瞬间付了款，员工这边照样能把任务取消掉，而且**一分钱不退** ——
       * 单子没了、钱还在公司账上，客户只能打电话来吵。
       * 锁住之后第二个人会看到状态/付款状态已经变了，取消不会执行。
       */
      await tx.$queryRaw`SELECT id FROM consolidation_tasks WHERE id = ${task.id} FOR UPDATE`;
      const fresh = await tx.consolidationTask.findUnique({
        where: { id: task.id },
        select: { status: true, paymentStatus: true },
      });
      if (!fresh) throw new BusinessError("任务不存在", 404, "NOT_FOUND");
      if (fresh.paymentStatus !== "unpaid") {
        throw new BusinessError("客户已经付款（或正在审核付款），不能直接取消。要取消请先「撤销付款」把钱退给客户");
      }
      if (!cancellable.includes(fresh.status)) {
        throw new BusinessError("这个任务的状态刚刚变了，取消没有执行，请刷新后再看");
      }

      /**
       * ⚠️ 「有没有签收货」也要锁后重查（2026-08-31 补，排查报告第2条）。
       * 上面那次 count 是事务外的快照：员工点取消的那一刻还没人签收、不用密码，
       * 等事务真跑起来时仓库刚签了一张 —— 签收记录就这么被无密码删掉了。
       * 照 tasks/delete 锁内重查那套：情况变了就拦下来，让他刷新后带密码重来。
       */
      const nowReceived = await tx.consolidationPrealert.count({
        where: { taskId: body.taskId, status: "received" },
      });
      if (nowReceived > 0 && !passwordVerified) {
        throw new BusinessError(
          "这个任务刚刚有预报单被签收了，取消没有执行。请刷新后确认，确实要取消请输入管理员账号和管理员密码。",
          409,
          "VALIDATION_ERROR",
        );
      }

      // 删除产品行
      const prealerts = await tx.consolidationPrealert.findMany({
        where: { taskId: body.taskId },
        select: { id: true },
      });
      for (const pa of prealerts) {
        await tx.consolidationPrealertProduct.deleteMany({ where: { prealertId: pa.id } });
      }
      // 删除预报单
      await tx.consolidationPrealert.deleteMany({ where: { taskId: body.taskId } });
      // 删除状态日志
      await tx.consolidationStatusLog.deleteMany({ where: { taskId: body.taskId } });
      // 更新任务状态
      await tx.consolidationTask.update({
        where: { id: body.taskId },
        data: { status: "cancelled" },
      });
      // 写取消日志
      await tx.consolidationStatusLog.create({
        data: {
          taskId: body.taskId!,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: task.status,
          toStatus: "cancelled",
        },
      });
      return nowReceived;
    });

    /**
     * ⚠️ 取消也要在服务器日志里留一笔（2026-08-31 补，复查报告）。
     * 照 tasks/delete 那套：取消会把签收凭证、货物明细物理删光，
     * 状态日志表里只剩一条「变 cancelled」，事后想查「是谁、删了几张已签收的单」
     * 全靠这条日志。已签收张数用的是锁内重数的那份，不是事务外的旧快照。
     */
    logger.warn("取消集货任务", {
      操作人: auth.userId, 操作角色: auth.role, 任务号: task.taskNo,
      是否带密码强取消: passwordVerified, 删掉的已签收预报单张数: deletedReceivedCount,
    });

    ok(res, { success: true, taskId: body.taskId, status: "cancelled" });
  });

  // 9) 导出数据（前端负责生成 Excel）
  app.get("/staff/consolidation/tasks/export", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const taskId = (req.query as any)?.taskId as string | undefined;
    if (!taskId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }

    const task = await prisma.consolidationTask.findFirst({
      // ⚠️ 必须带 companyId（2026-08-27 补）：原来只按 id 查，实测能跨公司拿到别家数据
      where: { id: taskId , companyId: auth.companyId },
      select: { taskNo: true },
    });
    // 查不到必须当场停：以前漏了这一步，别家公司的任务号虽然查不到，
    // 下面的预报单还是照拉不误，等于把人家的货物明细导出去了（2026-08-27 实测复现）
    if (!task) {
      fail(res, 404, "NOT_FOUND", "任务不存在");
      return;
    }

    const prealerts = await prisma.consolidationPrealert.findMany({
      where: { taskId, companyId: auth.companyId, status: "received" },
      orderBy: { createdAt: "asc" },
      include: { products: { orderBy: { sortOrder: "asc" } } },
    });

    // 构建导出数据（不含快递单号 expressNo）
    const rows: any[] = [];
    for (const pa of prealerts) {
      for (const p of pa.products) {
        rows.push({
          mark: pa.mark,
          trackingNo: pa.trackingNo,
          productName: p.productName,
          packageCount: p.packageCount,
          quantityPerBox: p.quantityPerBox,
          totalQuantity: p.totalQuantity,
          unitWeight: p.unitWeight ? Number(p.unitWeight) : null,
          totalWeight: p.totalWeight ? Number(p.totalWeight) : null,
          lengthCm: p.length ? Number(p.length) : null,
          widthCm: p.width ? Number(p.width) : null,
          heightCm: p.height ? Number(p.height) : null,
          volumeM3: p.volume ? Number(p.volume) : null,
          material: p.material,
          cargoValue: p.cargoValue,
          // 直接给中文：这是导出到 Excel 的展示数据，全中文系统不能漏英文值出去
          cargoType: p.cargoType === "inspection" ? "商检货" : p.cargoType === "sensitive" ? "敏感货" : "普货",
          productImageBase64: (() => {
            if (!p.productImageBase64) return null;
            if (p.productImageBase64.startsWith("data:image/")) return p.productImageBase64;
            if (p.productImageBase64.startsWith("/images/")) {
              const b64 = readImageAsBase64(p.productImageBase64);
              if (!b64) return null;
              const mimeType = (p.productImageMime || "image/jpeg").replace("image/", "");
              return `data:image/${mimeType};base64,${b64}`;
            }
            return p.productImageBase64;
          })(),
        });
      }
    }

    ok(res, {
      taskNo: task?.taskNo ?? "",
      taskId,
      totalRows: rows.length,
      headers: [
        { key: "mark", label: "唛头" },
        { key: "trackingNo", label: "运单号" },
        { key: "productName", label: "产品名称" },
        { key: "packageCount", label: "件数" },
        { key: "quantityPerBox", label: "装箱数量" },
        { key: "totalQuantity", label: "总数量" },
        { key: "unitWeight", label: "单件重量" },
        { key: "totalWeight", label: "总重量" },
        { key: "lengthCm", label: "长(cm)" },
        { key: "widthCm", label: "宽(cm)" },
        { key: "heightCm", label: "高(cm)" },
        { key: "volumeM3", label: "体积(m³)" },
        { key: "material", label: "材质" },
        { key: "cargoValue", label: "货值" },
        { key: "cargoType", label: "货型" },
        // ⚠️ 产品图片必须留在最后一列：员工端导出用 headers.length 定位图片列
        { key: "productImageBase64", label: "产品图片" },
      ],
      rows,
    });
  });

  // ==========================================================================
  // 管理员端接口
  // ==========================================================================

  // 1) 管理员任务列表
  app.get("/admin/consolidation/tasks", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const statusFilter = (req.query as any)?.status as string | undefined;
    const where: any = { companyId: auth.companyId };
    if (statusFilter) where.status = statusFilter;

    const tasks = await prisma.consolidationTask.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        client: { select: { id: true, name: true, phone: true } },
        // 同员工端列表：只取列表页需要的，商品和照片由详情接口单独取
        prealerts: { select: { id: true, status: true } },
      },
    });

    const result = tasks.map((t) => ({
      ...formatTaskForList(t),
      clientName: t.client.name,
      clientPhone: t.client.phone,
      volumePercent: calcVolumePercent(t),
      isNearFull: calcVolumePercent(t) >= 85,
      prealertCount: t.prealerts.length,
    }));

    ok(res, result);
  });

  // 2) 管理员删除任务
  /**
   * ❌ 旧的 `DELETE /admin/consolidation/tasks` 已在 2026-08-27 删除。
   *
   * 它是最早期的写法：拿到 taskId 就 `delete`，**三道保护一道都不走** ——
   *   · 不查有没有已收货的预报单（新版会拦，要强删得输管理员密码）
   *   · 不给删除预览（新版会先告诉你要连带删掉多少预报单、货物、日志）
   *   · **不退钱**（新版会把客户已付的款在同一个事务里退回集货余额）
   * 误调一次就是「任务删了、客户的钱还在公司账上」，而且删了找不回来。
   *
   * 前端从来没调用过它（2026-08-27 全项目 grep 确认）。
   * 要删任务请用 `POST /admin/consolidation/tasks/delete`，
   * 它带 dryRun 预览、强删密码和退款。
   */

  // 3) 管理员强制编辑预报单
  // ==========================================================================
  // 撤销付款并退款（2026-08-07）
  // 客户在集货里付款是当场扣余额、不可撤销的，这里是唯一的后手。
  // 退多少不看当前报价，看流水里**实际扣过**的钱。
  // ==========================================================================
  app.post("/admin/consolidation/payments/revoke", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { taskId?: string; reason?: string };
    if (!body.taskId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }

    const task = await prisma.consolidationTask.findFirst({
      where: { id: body.taskId.trim(), companyId: auth.companyId },
    });
    if (!task) {
      fail(res, 404, "NOT_FOUND", "集货任务不存在");
      return;
    }
    // 这里只做「早点给个好看的提示」，真正说了算的判断在下面事务里重做一遍。
    if (task.paymentStatus !== "paid") {
      fail(res, 400, "BAD_REQUEST", "只有「已付款」的任务能撤销");
      return;
    }

    const { balanceAfter, refundable } = await prisma.$transaction(async (tx) => {
      /**
       * ⚠️ 先锁任务，再复查状态和退款金额（2026-08-27 补）。跟仓库版那条一样的洞：
       * 原来状态和「可退多少」都在事务外面读，两个管理员同时点「撤销付款」，
       * 两边都读到「已付款 / 可退 400」，各退一次 —— 客户白拿一笔（已实测复现）。
       * 顺带统一锁序【任务 → 钱包】，避免跟付款那条路互相等成死锁。
       */
      await tx.$queryRaw`SELECT id FROM consolidation_tasks WHERE id = ${task.id} FOR UPDATE`;
      const fresh = await tx.consolidationTask.findUnique({
        where: { id: task.id },
        select: { paymentStatus: true, status: true },
      });
      if (!fresh) throw new BusinessError("集货任务不存在", 404, "NOT_FOUND");
      if (fresh.paymentStatus !== "paid") {
        throw new BusinessError("这个任务刚刚被别人改过付款状态了，撤销没有执行，请刷新后再看");
      }
      /**
       * ⚠️ 已经开始装柜/发运的不能退（2026-08-27 补）。
       * 流程是 collecting → full_confirmed → quoted → paid → loading → …
       * 走到 loading 之后货已经在柜里了，这时候把钱退回去等于白送。
       */
      if (fresh.status !== "paid") {
        throw new BusinessError("这个任务已经进入装柜流程，不能撤销付款");
      }

      const rows = await tx.consolidationBalanceLedger.findMany({
        where: { refType: "normal", refId: task.id },
        select: { amount: true },
      });
      const refundable = -rows.reduce((sum, r) => sum + Number(r.amount), 0);
      if (!(refundable > 0)) {
        throw new BusinessError("这个任务没有可退的金额（可能刚刚已经退过了）");
      }

      const after = await refundToConsolidation(tx as any, {
        companyId: auth.companyId,
        clientId: task.clientId,
        amount: refundable,
        refType: "normal",
        refId: task.id,
        refNo: task.taskNo,
        remark: body.reason?.trim() ? `管理员撤销付款：${body.reason.trim()}` : "管理员撤销付款",
        operatorId: auth.userId,
        operatorName: auth.name || auth.userId,
      });
      await tx.consolidationTask.update({
        where: { id: task.id },
        data: {
          paymentStatus: "unpaid",
          /**
           * ⚠️ 流程状态也必须退回「已报价」（2026-08-27 补）。
           *
           * 之前只把 paymentStatus 改回 unpaid，status 还停在 paid，后果实测有两条：
           *   ① 客户**再也付不了款** —— 付款那条路要求 status = quoted
           *   ② 员工**照样能装柜** —— 装柜那条路要求 status = paid
           * 合起来就是「已装柜但没付款」，钱退了货还发出去。
           */
          status: "quoted",
          paymentProofUploadedAt: null,
        },
      });
      await tx.consolidationStatusLog.create({
        data: {
          taskId: task.id,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: "admin",
          operatorName: auth.name || auth.userId,
          fromStatus: "paid",
          toStatus: "quoted",
          remark: `管理员撤销付款，退回集货余额 ¥${refundable.toFixed(2)}${body.reason?.trim() ? `（${body.reason.trim()}）` : ""}`,
        },
      });
      return { balanceAfter: after, refundable };
    });

    ok(res, {
      taskId: task.id,
      refunded: refundable,
      balanceAfter,
      paymentStatus: "unpaid",
      status: "quoted",
      message: `已退回 ¥${refundable.toFixed(2)} 到客户集货余额，任务回到未付款`,
    });
  });

  app.post("/admin/consolidation/prealerts/force-edit", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      prealertId?: string;
      mark?: string;
      expressNo?: string;
      products?: Array<{
        /** 已有产品行的编号；不传表示这是新增的一行 */
        id?: string;
        productName?: string;
        packageCount?: number;
        quantityPerBox?: number;
        unitWeightKg?: number;
        lengthCm?: number;
        widthCm?: number;
        heightCm?: number;
        material?: string;
        cargoValue?: string;
        cargoType?: string;
        /** 只有本次真的换了图才传；不传表示沿用原图 */
        productImage?: { fileName?: string; mime?: string; base64?: string };
      }>;
    };

    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }
    // ⚠️ 空清单要当场拦（2026-08-31 补，排查报告第26条）：
    // 空数组会跳过下面的逐行校验，却照样走事务里的删行逻辑，把整张单的货清空。
    // 跟客户端 update 那条同一把尺子，详细说明见那边的注释。
    if (body.products && body.products.length === 0) {
      fail(res, 400, "BAD_REQUEST", "至少需要一个产品行");
      return;
    }

    const pa = await prisma.consolidationPrealert.findFirst({
      // ⚠️ 必须带 companyId（2026-08-27 补）：原来只按 id 查，实测能跨公司拿到别家数据
      where: { id: body.prealertId , companyId: auth.companyId },
      include: { task: true },
    });
    if (!pa) {
      fail(res, 404, "NOT_FOUND", "预报单不存在");
      return;
    }

    // 校验产品行
    if (body.products && body.products.length > 0) {
      for (let i = 0; i < body.products.length; i++) {
        const p = body.products[i];
        if (!p.productName?.trim()) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的产品名为必填`); return; }
        {
          // 三个入口共用同一份校验，见 validateConsolidationProductRow
          const issue = validateConsolidationProductRow(p, i);
          if (issue) { fail(res, 400, "BAD_REQUEST", issue); return; }
        }
        if (!p.material?.trim()) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的材质为必填`); return; }
        if (!p.cargoValue?.trim()) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的货值为必填`); return; }
        if (p.cargoType && !CARGO_TYPES.includes(p.cargoType)) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的货型不合法`); return; }
      }
    }

    await prisma.$transaction(async (tx) => {
      /**
       * ⚠️⚠️ 锁必须在**事务最开头**（2026-08-29 修）。
       * 上一版把这两句放在产品行增删之后 —— 实际顺序成了
       * 【产品 → 任务 → 预报单】，跟别处的【任务 → 预报单】反着，会死锁；
       * 而且产品行是在**没拿到锁**的情况下先删改的，
       * 删除那条路正好在这一刻把整张预报单删掉时，这边的写入会撞上或写成孤儿。
       *
       * ⚠️ 我上一轮用正则扫「每个事务里 FOR UPDATE 的先后」，得出「17 条路径锁序统一」，
       * 那个结论是**错的** —— 正则只看得见加锁语句，看不见锁之前已经写了什么。
       * 复核实测把这条揪了出来。以后判断锁序不能只看 FOR UPDATE 的位置，
       * 要看**第一条写语句**在不在锁后面。
       */
      await tx.$queryRaw`SELECT id FROM consolidation_tasks WHERE id = ${pa.taskId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM consolidation_prealerts WHERE id = ${pa.id} FOR UPDATE`;

      if (body.products) {
        // 产品行按行增量同步，不再整批删除重建（重建会把没重传的图片弄丢）
        const rows = body.products;
        const keepIds = rows
          .map((p) => p.id?.trim())
          .filter((v): v is string => Boolean(v));

        await tx.consolidationPrealertProduct.deleteMany({
          where: {
            prealertId: body.prealertId,
            ...(keepIds.length > 0 ? { id: { notIn: keepIds } } : {}),
          },
        });

        for (let idx = 0; idx < rows.length; idx++) {
          const p = rows[idx];
          const totalQuantity = p.packageCount! * p.quantityPerBox!;
          const totalWeightKg = parseFloat((p.unitWeightKg! * totalQuantity).toFixed(2));
          const volumeM3 = parseFloat(
            ((p.lengthCm! * p.widthCm! * p.heightCm!) / 1_000_000 * p.packageCount!).toFixed(6),
          );
          const data = {
            productName: p.productName!.trim(),
            packageCount: p.packageCount!,
            quantityPerBox: p.quantityPerBox!,
            totalQuantity,
            unitWeight: p.unitWeightKg!,
            totalWeight: totalWeightKg,
            length: p.lengthCm!,
            width: p.widthCm!,
            height: p.heightCm!,
            volume: volumeM3,
            material: p.material!.trim(),
            cargoValue: p.cargoValue!.trim(),
            cargoType: p.cargoType || "normal",
            sortOrder: idx,
          };

          const img = p.productImage;
          const imagePatch = img?.base64 && img.mime
            ? (() => {
                const savedPath = saveImageToDisk(`consolidation_admin_${Date.now()}`, img.mime!, img.base64!);
                return {
                  productImageFileName: img.fileName || savedPath.split("/").pop() || "",
                  productImageMime: img.mime!,
                  productImageBase64: savedPath,
                };
              })()
            : {};

          const rowId = p.id?.trim();
          if (rowId) {
            await tx.consolidationPrealertProduct.updateMany({
              where: { id: rowId, prealertId: body.prealertId },
              data: { ...data, ...imagePatch },
            });
          } else {
            await tx.consolidationPrealertProduct.create({
              data: { prealertId: body.prealertId!, ...data, ...imagePatch },
            });
          }
        }
      }

      const updateData: any = {};
      if (body.mark?.trim()) updateData.mark = body.mark.trim();
      if (body.expressNo !== undefined) updateData.expressNo = body.expressNo?.trim() || null;

      await tx.consolidationPrealert.update({
        where: { id: body.prealertId },
        data: updateData,
      });

      await recalcTaskTotals(pa.taskId, tx);
      return null;
    });

    ok(res, { success: true, prealertId: body.prealertId });
  });

  // 4) 管理员删除预报单
  app.post("/admin/consolidation/prealerts/delete", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { prealertId?: string };
    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }

    const pa = await prisma.consolidationPrealert.findFirst({
      // ⚠️ 必须带 companyId（2026-08-27 补）：原来只按 id 查，可以跨公司操作别家的单
      where: { id: body.prealertId, companyId: auth.companyId },
    });
    if (!pa) {
      fail(res, 404, "NOT_FOUND", "预报单不存在");
      return;
    }

    /**
     * ⚠️ 2026-08-28 补：这条路原来**一道检查都没有** —— 没付款判断、没锁、没事务。
     * 任务已付款也照删，而且是级联删除（货物明细跟着一起没），钱一分不退；
     * 货删光之后「撤销付款」还会 400，退款的口子也跟着封死。
     * 现在跟「删单件货物」用同一把尺子，并且照 tasks/delete 那套：
     * **锁住任务 → 重查 → 用重查的值判断 → 再动手**。
     * 事务外面判断挡不住并发：员工正好在这一刻收款，判断和删除中间就能插进去。
     */
    // BusinessError 由 server.ts:210 的全局处理统一转成 HTTP 响应，这里直接抛
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM consolidation_tasks WHERE id = ${pa.taskId} FOR UPDATE`;
      const fresh = await tx.consolidationTask.findUnique({
        where: { id: pa.taskId },
        select: { status: true, paymentStatus: true },
      });
      if (!fresh) throw new BusinessError("集货任务不存在", 404, "NOT_FOUND");
      const verdict = checkConsolidationDeletable({
        paymentStatus: fresh.paymentStatus,
        taskStatus: fresh.status,
      });
      if (!verdict.ok) throw new BusinessError(verdict.message, 400, "BAD_REQUEST");

      await tx.consolidationPrealert.delete({ where: { id: body.prealertId } });
      // 总件数/总方数按已签收预报单汇总，必须**在同一个事务里**重算，
      // 否则删成功、重算失败时，任务上留着一份对不上的数字
      await recalcTaskTotals(pa.taskId, tx);
    });

    ok(res, { deleted: true, prealertId: body.prealertId });
  });

  // 4b) 管理员删单件货物明细（2026-08-15 新增）
  //     原来只能删整张预报单，客户多报一件就得整张作废重来。
  //     ⚠️ 普通版的总价是员工手填在任务上的（task.totalFee），删货不会自动改钱，
  //        界面弹窗必须提醒管理员自己回去核对金额。
  app.post("/admin/consolidation/prealerts/product-delete", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { productId?: string };
    if (!body.productId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "productId 为必填");
      return;
    }

    // 这张表没有公司字段，公司归属靠下面查父预报单时核对（见后面的 prealert 校验）
    const product = await prisma.consolidationPrealertProduct.findUnique({
      where: { id: body.productId },
      select: {
        id: true,
        productName: true,
        prealertId: true,
        prealert: {
          select: {
            id: true,
            companyId: true,
            taskId: true,
            task: { select: { status: true, paymentStatus: true } },
            _count: { select: { products: true } },
          },
        },
      },
    });

    if (!product || product.prealert.companyId !== auth.companyId) {
      fail(res, 404, "NOT_FOUND", "货物明细不存在");
      return;
    }

    /**
     * ⚠️ 2026-08-28 补：这三道检查原来全在事务**外面**读的快照上做，
     * 判断和删除之间隔着 await —— 客户正好在这一刻付款，货照样被删掉，钱不退。
     * 现在照 tasks/delete 那套：锁住任务 → 重查 → 用重查的值判断 → 再动手。
     * 「最后一件不给删」也要用锁后的实时件数，不然两个人各删一件就把整张删空了。
     */
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM consolidation_tasks WHERE id = ${product.prealert.taskId} FOR UPDATE`;
      const fresh = await tx.consolidationTask.findUnique({
        where: { id: product.prealert.taskId },
        select: { status: true, paymentStatus: true },
      });
      if (!fresh) throw new BusinessError("集货任务不存在", 404, "NOT_FOUND");
      const verdict = checkConsolidationDeletable({
        paymentStatus: fresh.paymentStatus,
        taskStatus: fresh.status,
      });
      if (!verdict.ok) throw new BusinessError(verdict.message, 400, "BAD_REQUEST");

      // 最后一件不给删：整张不要了请走「删除预报单」，那条路会一并清干净
      const remaining = await tx.consolidationPrealertProduct.count({
        where: { prealertId: product.prealertId },
      });
      if (remaining <= 1) {
        throw new BusinessError(
          "这是该预报单最后一件货物，不能删。整张不要了请删除预报单",
          400,
          "BAD_REQUEST",
        );
      }

      await tx.consolidationPrealertProduct.delete({ where: { id: product.id } });
      // 任务的总件数/总方数是按已签收预报单汇总出来的，删完必须在同一个事务里重算
      await recalcTaskTotals(product.prealert.taskId, tx);
    });

    ok(res, { deleted: true, productId: product.id, productName: product.productName });
  });

  /**
   * 删除整个集货任务（管理员，2026-08-07 新增）。
   *
   * ⚠️ 这是级联删除。数据库里 ConsolidationPrealert / ConsolidationStatusLog
   * 对 task 都是 onDelete: Cascade，预报单下面的货物明细又对预报单 Cascade。
   * 也就是删一个任务 = 任务 + 它的全部预报单 + 货物明细 + 状态日志 一起没。
   *
   * 安全规则（用户 2026-08-07 定）：
   *   默认拦住「已经开始走流程」的任务 —— 里面有预报单已收货，或任务本身已确认/装柜/
   *   已发货/已完成。要删必须带管理员密码强删。
   *   没带密码时返回 409 + 拦截原因，让界面把话说清楚再让人决定。
   *
   * 不带 confirmPassword 时只做预检、不删，界面靠它显示「会删掉几张预报单」。
   */
  app.post("/admin/consolidation/tasks/delete", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { taskId?: string; confirmPassword?: string; dryRun?: boolean };
    const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
    if (!taskId) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }

    const task = await prisma.consolidationTask.findFirst({
      where: { id: taskId, companyId: auth.companyId },
      include: { prealerts: { select: { id: true, status: true, trackingNo: true } } },
    });
    if (!task) {
      fail(res, 404, "NOT_FOUND", "集货任务不存在");
      return;
    }

    const [productCount, logCount] = await Promise.all([
      prisma.consolidationPrealertProduct.count({
        where: { prealertId: { in: task.prealerts.map((p) => p.id) } },
      }),
      prisma.consolidationStatusLog.count({ where: { taskId } }),
    ]);

    /**
     * 发运红线（2026-09-16，确认单 4.15）：已经发出去的任务谁都不能删，输管理员密码也不行。
     * 预览照样回（hardBlocked=true），界面据此不给密码框；真删的时候锁里再判一次。
     */
    const shippedReason = consolidationTaskShippedReason(task.status);

    // 哪些情况算「已经开始走流程」
    const startedPrealerts = task.prealerts.filter((p) => p.status !== "pending");
    const taskStarted = !["collecting", "cancelled"].includes(task.status);
    const blockers: string[] = [];
    if (startedPrealerts.length > 0) {
      blockers.push(`有 ${startedPrealerts.length} 张预报单已收货（${startedPrealerts.slice(0, 3).map((p) => p.trackingNo).join("、")}${startedPrealerts.length > 3 ? " 等" : ""}）`);
    }
    if (taskStarted) blockers.push(`任务状态已是「${task.status}」，不是收货中`);

    const willDelete = {
      预报单: task.prealerts.length,
      货物明细: productCount,
      状态日志: logCount,
    };

    // 客户已经付过的钱，删之前要退回去（2026-08-08 补）。
    // 普通版是整个任务一次性付款，流水记的是 refType=normal / refId=任务id。
    const pendingRefunds = await computePendingRefunds(prisma, [{ refType: "normal", refId: task.id }]);
    const refundTotal = pendingRefunds.reduce((s, r) => s + r.amount, 0);

    if (body.dryRun) {
      ok(res, {
        taskNo: task.taskNo, willDelete, blockers, refundTotal, refundCount: pendingRefunds.length,
        hardBlocked: shippedReason !== null,
        hardBlockReason: shippedReason,
      });
      return;
    }

    // 发运红线在查密码之前就拦：带没带密码、密码对不对，都一样删不了
    if (shippedReason) {
      fail(res, 409, "VALIDATION_ERROR", shippedReason);
      return;
    }

    // 密码只要填对了就记下来，事务里会再查一次「现在还有没有拦截条件」
    let passwordVerified = false;
    if (body.confirmPassword?.trim()) {
      const admin = await prisma.user.findUnique({
        where: { id: auth.userId },
        select: { passwordHash: true },
      });
      if (!admin || !verifyPassword(body.confirmPassword, admin.passwordHash ?? "")) {
        fail(res, 403, "FORBIDDEN", "管理员密码不对，没有删除");
        return;
      }
      passwordVerified = true;
    }
    if (blockers.length > 0 && !passwordVerified) {
      fail(res, 409, "VALIDATION_ERROR",
        `这个集货任务不能直接删除：${blockers.join("；")}。确实要删请输入管理员密码。`);
      return;
    }

    // 退款和删除必须在同一个事务里：不然会出现「钱退了单子还在」或者反过来
    const actualRefunds = await prisma.$transaction(async (tx) => {
      /**
       * ⚠️ 退款金额必须**锁住任务之后重新算一遍**（2026-08-27 补）。
       *
       * 上面那次 computePendingRefunds 是在事务外面跑的，只是拿来给「预览」和
       * 提示用的。客户如果正好在管理员输密码那几秒里付了款，那笔钱不在旧快照里，
       * 删除时就漏退 —— 单子删没了，钱留在公司账上，谁也查不出来。
       * 锁住之后重算，付款那条路会被卡住等我们，算出来的一定是最新的。
       */
      await tx.$queryRaw`SELECT id FROM consolidation_tasks WHERE id = ${task.id} FOR UPDATE`;

      /**
       * ⚠️ 「能不能直接删」也要**锁完重查一遍**（2026-08-27 补）。
       * 上面那份拦截清单是事务外面算的：管理员点删除的那一刻这单还是「收货中、没人收过货」，
       * 于是不用输密码；等事务真跑起来时仓库已经收了货 —— 一张已经开始走流程的单
       * 就这么被无密码删掉了。这里重查，情况变了就让他重来一次并输密码。
       */
      const nowTask = await tx.consolidationTask.findUnique({
        where: { id: task.id },
        select: { status: true, prealerts: { select: { status: true } } },
      });
      if (!nowTask) throw new BusinessError("集货任务不存在", 404, "NOT_FOUND");
      // ⚠️ 发运红线锁完再判一次（CLAUDE.md #28）：输密码那几秒里员工可能刚把任务推进到运输中
      const shippedNow = consolidationTaskShippedReason(nowTask.status);
      if (shippedNow) {
        throw new BusinessError(shippedNow, 409, "VALIDATION_ERROR");
      }
      const nowBlocked =
        nowTask.prealerts.some((pa) => pa.status !== "pending") ||
        !["collecting", "cancelled"].includes(nowTask.status);
      if (nowBlocked && !passwordVerified) {
        throw new BusinessError(
          "这个任务刚刚有了新动静（收到货或状态变了），删除没有执行。请刷新后确认，确实要删请输入管理员密码。",
          409,
          "VALIDATION_ERROR",
        );
      }

      const fresh = await computePendingRefunds(tx as any, [{ refType: "normal", refId: task.id }]);
      if (fresh.length > 0) {
        await refundPendingOnDelete(tx as any, {
          companyId: auth.companyId,
          refType: "normal",
          refId: task.id,
          refunds: fresh,
          remark: `管理员删除集货任务 ${task.taskNo}，退回已付款项`,
          operatorId: auth.userId,
          operatorName: auth.name || auth.userId,
        });
      }
      await tx.consolidationTask.delete({ where: { id: taskId } });
      return fresh;
    });
    // 回给前端的必须是**真退了多少**，不是上面那个预览数字（2026-08-27 补）
    const actualRefundTotal = actualRefunds.reduce((s, r) => s + r.amount, 0);

    logger.warn("删除集货任务", {
      操作人: auth.userId, 任务号: task.taskNo, 任务状态: task.status,
      连带删除: willDelete, 是否强删: blockers.length > 0,
      退款客户数: actualRefunds.length, 退款总额: actualRefundTotal,
    });

    ok(res, {
      deleted: true, taskNo: task.taskNo, willDelete, forced: blockers.length > 0,
      refundTotal: actualRefundTotal, refundCount: actualRefunds.length,
    });
  });
}
