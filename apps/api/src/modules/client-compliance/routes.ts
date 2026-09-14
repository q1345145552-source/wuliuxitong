// B-4b: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-20）
import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { type DecimalRule, requireDecimal } from "../core/decimal-guard";
import { parseNumericStrict } from "../core/int-guard";
import { fail, ok, requireRole } from "../core/http-utils";
import { CONSOLIDATION_CURRENCY } from "../wallet/consolidation-balance";
import { hideOperatorInRemark } from "../core/operator-visibility";

/**
 * 2026-08-31 Codex 二轮：充值金额列的规格。
 * wallet_recharges.amount 在 schema.prisma 里是 Decimal(14,2)，
 * 上限直接从列本身推（整数部分最多 12 位），不编业务数字。
 * decimal-guard 里没有现成的 14,2 预设，所以在这里就地声明。
 */
const RECHARGE_AMOUNT_RULE: DecimalRule = { precision: 14, scale: 2 };

/**
 * 2026-09-01（Codex 终验收尾）：分页参数的严格校验，逐字照抄 fcl-inquiries/routes.ts。
 * 原来 page 用 Number(...) 宽松转换：传 `1e400` 会变 Infinity，skip 跟着变
 * Infinity 打到库上直接 500；0/-1/2.5 被 Math.trunc/Math.max 静默改写成合法值。
 * 规矩：没传/传空串用默认值；传了就必须是正的安全整数（Number.isSafeInteger），
 * 不是就返回 null，由调用处 400 中文报错。
 */
function parsePageParam(raw: unknown, fallback: number): number | null {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return fallback;
  const n = parseNumericStrict(raw);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return n;
}

/**
 * 注册多币种账户接口。
 */
export function registerClientComplianceRoutes(app: MinimalHttpApp): void {
  // ===== 客户端钱包概览 =====
  app.get("/client/wallet/overview", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    // 2026-08-07：集货余额只有人民币，历史遗留的其它币种不再下发给前端
    const accountRows = await prisma.clientWalletAccount.findMany({
      where: { companyId: auth.companyId, clientId: auth.userId, currency: CONSOLIDATION_CURRENCY },
      select: { currency: true, balance: true, updatedAt: true },
    });
    const balance = accountRows[0] ? Number(accountRows[0].balance.toString()) : 0;
    ok(res, {
      balance,
      currency: CONSOLIDATION_CURRENCY,
      updatedAt: accountRows[0]?.updatedAt.toISOString() ?? null,
      // 兼容老前端：仍然给一个 accounts 数组，但只有人民币这一条
      accounts: accountRows.map((item) => ({
        currency: item.currency,
        balance: Number(item.balance.toString()),
        updatedAt: item.updatedAt.toISOString(),
      })),
    });
  });

  // ===== 客户端：提交充值申请 =====
  app.post("/client/wallet/recharge", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      amount?: number;
      currency?: string;
      paymentMethod?: string;
      proofImage?: string;
      remark?: string;
    };
    /**
     * 2026-08-31 Codex 二轮：金额改走统一金额闸（照抄集货报价那三处的写法）。
     * 原来是宽松的 Number()：传 true 会变成 1 元充值，传 [500] 也能溜过去；
     * 小数位和列上限也没卡 —— 填 0.001 会被 Decimal(14,2) 悄悄存成 0.00。
     * 现在必须是严格数字、不小于 0.01、最多两位小数、不超列上限，
     * 不合法在碰库之前就 400 中文报错。
     */
    const amount = parseNumericStrict(body.amount);
    const amountIssue = requireDecimal(amount, "充值金额", RECHARGE_AMOUNT_RULE);
    if (amountIssue) {
      fail(res, 400, "BAD_REQUEST", amountIssue);
      return;
    }
    // 2026-08-07：集货余额只有人民币，泰铢已废弃。
    // 老前端可能还会传 currency，一律忽略，强制按人民币入账。
    const currency = CONSOLIDATION_CURRENCY;
    const paymentMethod = body.paymentMethod ?? "";
    const validMethods = ["WECHAT", "ALIPAY", "BANK_TRANSFER"];
    if (!validMethods.includes(paymentMethod)) {
      fail(res, 400, "BAD_REQUEST", "支付方式无效，可选：微信、支付宝、银行转账");
      return;
    }
    const proofImage = (body.proofImage ?? "").trim();
    if (!proofImage) {
      fail(res, 400, "BAD_REQUEST", "请上传付款凭证");
      return;
    }
    /**
     * ⚠️ 必须校验格式（2026-08-28 补）。
     *
     * 这个字段是客户自己填的，原来只 trim 一下就存库。而管理员审核页会把它
     * 直接拼进 HTML 显示 —— 客户填一段带 onerror 的字符串，管理员一点开，
     * 脚本就在**管理员的浏览器里**跑，能读走 localStorage 里的登录令牌，
     * 等于客户拿到管理员账号。
     *
     * 前端那处也已改成用 DOM 接口设 src（不再拼字符串），这里是第二道闸：
     * 只放行「图片 data URL」和「站内 /images/ 路径」，别的一律拒绝。
     */
    const isDataImage = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/=\s]+$/.test(proofImage);
    const isLocalPath = /^\/images\/[A-Za-z0-9._-]+$/.test(proofImage);
    if (!isDataImage && !isLocalPath) {
      fail(res, 400, "BAD_REQUEST", "付款凭证格式不对，请重新上传图片");
      return;
    }
    if (proofImage.length > 8 * 1024 * 1024) {
      fail(res, 400, "BAD_REQUEST", "付款凭证图片过大，请压缩后再上传");
      return;
    }
    const recharge = await prisma.walletRecharge.create({
      data: {
        // 2026-08-31：单号加随机后缀（照抄 admin-ops 里 lm_ 的写法）。
        // 原来只用时间戳，两笔申请撞同一毫秒会撞号，第二笔被数据库拒收报「服务器错误」。
        id: `rcg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        companyId: auth.companyId,
        clientId: auth.userId,
        currency,
        amount,
        paymentMethod,
        proofImage,
        remark: body.remark?.trim() || null,
        status: "PENDING",
      },
    });
    ok(res, {
      id: recharge.id,
      status: recharge.status,
      message: "充值申请已提交，等待管理员审核，通过后才会进集货余额",
    });
  });

  // ===== 客户端：集货余额流水（2026-08-07 新增）=====
  // 充值到账、集货付款、管理员退款，每一笔都在这里，客户能自己对账。
  app.get("/client/wallet/ledger", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    /* 2026-09-01 Codex 复核收尾：加真分页（照抄 /client/prealerts 那套）。
       原来只取前 200 条、total 写的是本次返回条数——流水超 200 条后老记录
       静默消失，客户对账少看还不知道（教训21）。默认 50、上限 500，
       total 改成 count 出来的真实总数，前端按它翻页。 */
    // 2026-09-01（Codex 终验收尾）：page/pageSize 改用严格校验，非法直接 400（见文件头 parsePageParam）。
    // 原来的宽松转换：1e400 → skip=Infinity 打到库上 500，0/-1/2.5 被静默改写。
    const page = parsePageParam((req.query as any)?.page, 1);
    if (page === null) { fail(res, 400, "BAD_REQUEST", "页码不合法"); return; }
    const pageSizeRaw = parsePageParam((req.query as any)?.pageSize, 50);
    if (pageSizeRaw === null) { fail(res, 400, "BAD_REQUEST", "每页条数不合法"); return; }
    const pageSize = Math.min(pageSizeRaw, 500); // 上限维持 500，传再大也只给 500
    // skip 再夹一道保险，全部在碰库之前算好（2026-09-01 Codex 终验收尾）
    const skip = Math.min((page - 1) * pageSize, Number.MAX_SAFE_INTEGER);
    const ledgerWhere = { companyId: auth.companyId, clientId: auth.userId };
    const [total, rows] = await Promise.all([
      prisma.consolidationBalanceLedger.count({ where: ledgerWhere }),
      prisma.consolidationBalanceLedger.findMany({
        where: ledgerWhere,
        // 2026-09-01（Codex 终验收尾）：createdAt 不唯一，同一秒多笔会跨页重复/漏行，加 id 当第二排序键
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take: pageSize,
        select: {
          id: true, type: true, amount: true, balanceAfter: true,
          refType: true, refNo: true, remark: true, createdAt: true,
        },
      }),
    ]);
    const typeZh: Record<string, string> = { recharge: "充值到账", pay: "集货付款", refund: "撤销退款" };
    const refZh: Record<string, string> = { whr: "仓库版集货", normal: "普通版集货", recharge: "充值单" };
    ok(res, {
      items: rows.map((r) => ({
        id: r.id,
        type: r.type,
        typeLabel: typeZh[r.type] ?? r.type,
        amount: Number(r.amount),
        balanceAfter: Number(r.balanceAfter),
        source: r.refType ? (refZh[r.refType] ?? r.refType) : "",
        refNo: r.refNo ?? "",
        // 2026-09-15：「管理员删除集货任务…」这类代码拼的备注，开头的「管理员」不给客户（库里原文不动）
        remark: hideOperatorInRemark(r.remark ?? "", "client"),
        createdAt: r.createdAt.toISOString(),
      })),
      page,
      pageSize,
      // 过滤后的真实总数，不再是「本次返回了几条」（2026-09-01 Codex 复核收尾）
      total,
    });
  });

  // ===== 客户端：查看充值记录 =====
  app.get("/client/wallet/recharges", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const rows = await prisma.walletRecharge.findMany({
      where: { companyId: auth.companyId, clientId: auth.userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        currency: true,
        amount: true,
        paymentMethod: true,
        status: true,
        remark: true,
        reviewRemark: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    ok(res, {
      recharges: rows.map((r) => ({
        id: r.id,
        currency: r.currency,
        amount: Number(r.amount.toString()),
        paymentMethod: r.paymentMethod,
        status: r.status,
        remark: r.remark,
        reviewRemark: r.reviewRemark,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    });
  });

  // 获取所有客户备注
  app.get("/staff/lastmile/notes", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const rows = await prisma.clientNote.findMany({
      where: { companyId: auth.companyId },
      select: { clientId: true, content: true, updatedAt: true },
    });
    const map: Record<string, { content: string; updatedAt: string }> = {};
    for (const r of rows) {
      map[r.clientId] = { content: r.content, updatedAt: r.updatedAt.toISOString() };
    }
    ok(res, map);
  });

  // 保存客户备注（员工和管理员都在用；路径里的 admin 是历史遗留，别被名字骗了）
  app.post("/admin/shipping/notes", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { clientId?: string; content?: string };
    const clientId = body.clientId?.trim();
    if (!clientId) { fail(res, 400, "BAD_REQUEST", "clientId required"); return; }
    // 2026-08-31：先核对客户是不是本公司的（照抄 whr-consolidation 的写法）。
    // 原来只认客户编号不看公司，将来接了第二家公司，对方员工传我们客户的编号
    // 就能把我们写的备注整个覆盖掉。现在只有一家公司在用，属于提前补闸。
    const client = await prisma.user.findFirst({
      where: { id: clientId, companyId: auth.companyId, role: "client" },
      select: { id: true },
    });
    if (!client) { fail(res, 404, "NOT_FOUND", "客户不存在或不属于本公司"); return; }
    await prisma.clientNote.upsert({
      where: { clientId },
      create: { companyId: auth.companyId, clientId, content: body.content ?? "" },
      update: { content: body.content ?? "" },
    });
    ok(res, { saved: true });
  });
  // 员工端创建客户地址
  app.post("/staff/client-addresses", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      clientId?: string;
      contactName?: string;
      contactPhone?: string;
      addressDetail?: string;
      label?: string;
    };
    const clientId = body.clientId?.trim();
    if (!clientId) { fail(res, 400, "BAD_REQUEST", "clientId required"); return; }
    if (!body.contactName?.trim()) { fail(res, 400, "BAD_REQUEST", "contactName required"); return; }
    if (!body.contactPhone?.trim()) { fail(res, 400, "BAD_REQUEST", "contactPhone required"); return; }
    if (!body.addressDetail?.trim()) { fail(res, 400, "BAD_REQUEST", "addressDetail required"); return; }
    // 2026-08-31 收尾补：跟上面保存备注同一道闸——客户必须是本公司的，
    // 否则将来接了第二家公司，能拿别家客户的编号往咱们库里挂地址。
    const addrClient = await prisma.user.findFirst({
      where: { id: clientId, companyId: auth.companyId, role: "client" },
      select: { id: true },
    });
    if (!addrClient) { fail(res, 404, "NOT_FOUND", "客户不存在或不属于本公司"); return; }
    const addr = await prisma.clientAddress.create({
      data: {
        // 2026-08-31：同上，加随机后缀防止同一毫秒两条地址撞号
        id: `addr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        companyId: auth.companyId,
        clientId,
        contactName: body.contactName.trim(),
        contactPhone: body.contactPhone.trim(),
        addressDetail: body.addressDetail.trim(),
        label: body.label?.trim() || null,
      },
    });
    ok(res, { id: addr.id, created: true });
  });

  /**
   * 员工改客户的派送地址（2026-08-29 加，老板要求）。
   *
   * 原来尾端地址那一栏只能「添加」和「删除」—— 电话打错一位、门牌少一个字，
   * 员工只能把整条删掉重新加一遍，客户的默认地址标记也跟着没了。
   *
   * ⚠️ 用 POST 不是 PATCH：MinimalHttpApp（server.ts:37）只有 get/post/delete，
   *    没有 patch/put，写了也注册不上。
   * ⚠️ 必须先按 companyId 查一遍再改（照抄删除那条的做法，
   *    orders/routes.ts 的 DELETE /staff/lastmile/addresses）——
   *    只靠 update 的 where 带 companyId 也行，但查不到时要能回 404 而不是静默 0 行。
   */
  app.post("/staff/client-addresses/update", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      id?: string;
      contactName?: string;
      contactPhone?: string;
      addressDetail?: string;
      label?: string;
    };
    const id = body.id?.trim();
    if (!id) { fail(res, 400, "BAD_REQUEST", "缺少地址 id"); return; }
    if (!body.contactName?.trim()) { fail(res, 400, "BAD_REQUEST", "联系人姓名为必填"); return; }
    if (!body.contactPhone?.trim()) { fail(res, 400, "BAD_REQUEST", "联系电话为必填"); return; }
    if (!body.addressDetail?.trim()) { fail(res, 400, "BAD_REQUEST", "详细地址为必填"); return; }

    const existing = await prisma.clientAddress.findFirst({
      where: { id, companyId: auth.companyId },
      select: { id: true },
    });
    if (!existing) { fail(res, 404, "NOT_FOUND", "找不到这条地址，可能已被删除"); return; }

    await prisma.clientAddress.update({
      where: { id },
      data: {
        contactName: body.contactName.trim(),
        contactPhone: body.contactPhone.trim(),
        addressDetail: body.addressDetail.trim(),
        // label 没传就不动（前端编辑框里没有这一项，别把已有的备注名清掉）
        ...(body.label === undefined ? {} : { label: body.label.trim() || null }),
      },
    });
    ok(res, { id, updated: true });
  });
}