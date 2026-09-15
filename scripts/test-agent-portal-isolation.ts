/**
 * 代理工作台隔离测试（2026-09-16，B3）。
 *
 * 需求：docs/交接文档-附件-代理账号确认单/final.md 第 3 节（不进 git）。盯住：
 *   1. 每个 /agent/* 接口只拿到**自己名下**客户的数据：代理甲、代理乙、湘泰自己的客户各造一份
 *   2. 拿别人的 id（运单 / 集货计划 / 返现单 / 客户）一律 404，跟「根本不存在」同一句话
 *   3. 混装柜、一车多家的派送单、一个集货计划里三家客户：别人整行不出现
 *   4. 柜号、员工名 / 操作人、内部备注（运单备注、client_notes、充值审核备注）、谁改的价、整柜已用方数 —— 响应里一个字都没有
 *      ⚠️ 字段恰好为空 = 测不出来（CLAUDE.md #31④）：这些值在夹具里全部填上好认的真值
 *   5. agent 令牌打 /admin/* /staff/* /client/* 全 403；员工 / 客户 / 管理员令牌打 /agent/* 全 403
 *   6. 代理给名下客户填价：别家客户 404、低于代理价 400、合法价存进去且没付款的单按新价重算
 *
 * 分两段：
 *   · 纯函数（不连库）：永远跑，CI 里也跑
 *   · 真接口（连测试库 + 真起 HTTP 服务走完整请求管线）：只在 DATABASE_URL 是 Neon 测试库时跑；
 *     CI 没有数据库 → 这一段打印「跳过」。⚠️ 为防连到生产库，URL 里不带 neon.tech 的一律不跑，
 *     除非显式设 AGENT_PORTAL_TEST_ALLOW_DB=1。
 *     测试数据全部挂在假公司 zz_b3_co 下、id 以 zz_b3_ 开头，开跑前先清一遍残留、跑完（含失败）再清一遍。
 *
 * 本地跑：set -a && . ./.env && set +a && npx tsx scripts/test-agent-portal-isolation.ts
 */
import assert from "node:assert/strict";

const failures: string[] = [];
let total = 0;
async function check(name: string, body: () => Promise<void> | void): Promise<void> {
  total += 1;
  try {
    await body();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(name);
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.log(`  ❌ ${name}\n     ${message.split("\n").slice(0, 8).join("\n     ")}`);
  }
}

/* ══════════════════════ 第一段：纯函数 ══════════════════════ */

async function pureChecks(): Promise<void> {
  console.log("\n【纯函数】");
  const v = await import("../apps/api/src/modules/agent-portal/views");

  await check("没填尺寸：只认 pending；没货品行 / 长宽高缺一个 / 方数 0 都算", () => {
    const full = { lengthCm: 10, widthCm: 10, heightCm: 10, volumeM3: 0.001 };
    assert.equal(v.isMissingSize("pending", []), true);
    assert.equal(v.isMissingSize("pending", [full]), false);
    assert.equal(v.isMissingSize("pending", [full, { ...full, heightCm: null }]), true);
    assert.equal(v.isMissingSize("pending", [{ ...full, volumeM3: 0 }]), true);
    assert.equal(v.isMissingSize("pending", [{ ...full, lengthCm: "0" }]), true);
    assert.equal(v.isMissingSize("received_pending_payment", []), false, "已签收的不算没填尺寸");
  });

  await check("签收照片只挑 4 个字段，数组里夹带的操作人带不出去", () => {
    const out = v.mapProofs([
      { base64Path: "/images/a.jpg", fileName: "a.jpg", mime: "image/jpeg", uploadedAt: "2026-09-01T00:00:00Z", operatorName: "员工甲" },
      null,
      { fileName: "没有路径的" },
      "垃圾",
    ]);
    assert.deepEqual(out, [{ base64Path: "/images/a.jpg", fileName: "a.jpg", mime: "image/jpeg", uploadedAt: "2026-09-01T00:00:00Z" }]);
    assert.deepEqual(v.mapProofs(null), []);
  });

  await check("轨迹备注：柜号抹掉、代码拼的「管理员」抹掉", () => {
    const r = v.remarkForAgent("装入柜子 ABCU1234567（分装 2件）");
    assert.ok(!r.includes("ABCU1234567"), r);
    assert.ok(r.includes("已装柜"), r);
    assert.ok(!v.remarkForAgent("到达凭祥口岸（随柜 L2608219129 补记）").includes("L2608219129"));
    assert.equal(v.remarkForAgent(null), "");
  });

  await check("分页参数严格：1e400 / 0 / -1 / 2.5 / 数组都拒", () => {
    assert.equal(v.parsePageParam(undefined, 1), 1);
    assert.equal(v.parsePageParam("", 7), 7);
    assert.equal(v.parsePageParam("3", 1), 3);
    for (const bad of ["1e400", "0", "-1", "2.5", "abc", ["1"]]) assert.equal(v.parsePageParam(bad, 1), null, String(bad));
  });

  await check("日期参数 / 长宽高拼接", () => {
    assert.equal(v.parseDateParam(undefined), undefined);
    assert.equal(v.parseDateParam("2026-09-01"), "2026-09-01");
    assert.equal(v.parseDateParam("2026/09/01"), null);
    assert.equal(v.joinDims([60, 50, 60, null]), "60/50");
    assert.equal(v.joinDims([null, undefined]), null);
  });

  await check("返现单明细映射：没有 statementId / companyId / prealertId 这类内部键", () => {
    const d = new Date("2026-08-10T00:00:00Z");
    const line = v.mapRebateLine({
      id: "l1", trackingNo: "T", planNo: "P", clientId: "C", mark: "M", productNames: "鞋",
      volumeNormalM3: "1.5", volumeInspectionM3: 0, volumeSensitiveM3: null,
      clientPriceNormal: 600, clientPriceInspection: 650, clientPriceSensitive: 700,
      agentPriceNormal: 500, agentPriceInspection: 550, agentPriceSensitive: 600,
      rebateAmount: "150.00", prealertCreatedAt: d, signedAt: null, paidAt: d, loadedAt: null, shippedAt: null, thailandReceivedAt: d,
      // @ts-expect-error 故意多塞内部字段，映射不许带出去
      statementId: "st", companyId: "co", prealertId: "pa",
    });
    assert.equal(line.rebateAmount, 150);
    assert.equal(line.volumes.normal, 1.5);
    for (const k of ["statementId", "companyId", "prealertId"]) assert.ok(!(k in line), k);
    const st = v.mapRebateStatement({ id: "s", month: "2026-08", lineCount: 1, totalVolumeM3: "1.5", totalRebate: "150", status: "paid", generatedAt: d, paidAt: d,
      // @ts-expect-error 同上
      paidBy: "u_admin" });
    assert.ok(!("paidBy" in st));
  });
}

/* ══════════════════════ 第二段：真接口 ══════════════════════ */

const CO = "zz_b3_co";
const P = "zz_b3_";
const PORT = Number(process.env.AGENT_PORTAL_TEST_PORT ?? 3113);

/** 只要在代理甲的任何响应里出现就是泄漏 */
const MUST_NOT_LEAK = [
  "SECRET", // 夹具里别家客户、湘泰客户、内部备注、员工名都带这个词
  "ZZB3CU7777777", // 柜号
  "ZZB3DN001", // 派送单号（一车拉了甲和乙的货）
  "员工甲ZZB3",
  "zz_b3_staff",
  "zz_b3_admin",
  "zz_b3_cb1",
  "zz_b3_cx",
  "ZZB3B1",
  "ZZB3X1",
  "ZZB3P-B1",
  "ZZB3P-X1",
  "operatorName",
  "operatorRole",
  "operatorId",
  "updatedBy",
  "paidBy",
  "reviewRemark",
  "reviewedBy",
  "proofImage",
  "batchNo\":\"",
  "containerNo",
  "creatorName",
  "usedVolumeM3",
  "paymentProofs",
];

async function cleanup(prisma: any): Promise<void> {
  // 顺序按外键：明细 → 单 → 客户行 → 计划；运单 → 订单 → 用户 → 代理
  await prisma.agentRebateLine.deleteMany({ where: { companyId: CO } });
  await prisma.agentRebateStatement.deleteMany({ where: { companyId: CO } });
  await prisma.whrConsolidationStatusLog.deleteMany({ where: { companyId: CO } });
  await prisma.whrConsolidationPrealertItem.deleteMany({ where: { companyId: CO } });
  await prisma.whrConsolidationPrealert.deleteMany({ where: { companyId: CO } });
  await prisma.whrConsolidationPlanCustomer.deleteMany({ where: { companyId: CO } });
  await prisma.whrConsolidationPlan.deleteMany({ where: { companyId: CO } });
  await prisma.clientWhrPrice.deleteMany({ where: { companyId: CO } });
  await prisma.walletRecharge.deleteMany({ where: { companyId: CO } });
  await prisma.clientWalletAccount.deleteMany({ where: { companyId: CO } });
  await prisma.clientNote.deleteMany({ where: { companyId: CO } });
  await prisma.adminLastmileOrder.deleteMany({ where: { companyId: CO } });
  await prisma.statusLog.deleteMany({ where: { companyId: CO } });
  const shipments = await prisma.shipment.findMany({ where: { companyId: CO }, select: { id: true } });
  await prisma.shipmentContainerItem.deleteMany({ where: { shipmentId: { in: shipments.map((s: { id: string }) => s.id) } } });
  await prisma.container.deleteMany({ where: { companyId: CO } });
  await prisma.shipment.deleteMany({ where: { companyId: CO } });
  await prisma.orderProduct.deleteMany({ where: { companyId: CO } });
  await prisma.order.deleteMany({ where: { companyId: CO } });
  await prisma.user.deleteMany({ where: { companyId: CO } });
  await prisma.agent.deleteMany({ where: { companyId: CO } });
}

async function seed(prisma: any): Promise<void> {
  const T = (s: string) => new Date(s);
  await prisma.agent.createMany({
    data: [
      { id: `${P}agA`, companyId: CO, name: "代理甲ZZB3", priceNormal: 500, priceInspection: 550, priceSensitive: 600, logoPath: "/images/zz_b3_logo.png" },
      { id: `${P}agB`, companyId: CO, name: "代理乙SECRETB", priceNormal: 400, priceInspection: 450, priceSensitive: 500 },
    ],
  });
  const user = (id: string, role: string, name: string, agentId: string | null) =>
    ({ id, companyId: CO, role, name, phone: "0800000000", status: "active", agentId });
  await prisma.user.createMany({
    data: [
      user(`${P}login_a`, "agent", "代理甲登录", `${P}agA`),
      user(`${P}login_b`, "agent", "代理乙登录SECRETB", `${P}agB`),
      user(`${P}ca1`, "client", "甲客一", `${P}agA`),
      user(`${P}ca2`, "client", "甲客二", `${P}agA`),
      user(`${P}cb1`, "client", "乙客一SECRETB", `${P}agB`),
      user(`${P}cx`, "client", "湘泰客SECRETX", null),
      user(`${P}staff`, "staff", "员工甲ZZB3", null),
      user(`${P}admin`, "admin", "管理员SECRETADMIN", null),
    ],
  });

  const order = (id: string, clientId: string, itemName: string, addr: string, approvalStatus = "approved") => ({
    id, companyId: CO, clientId, warehouseId: "wh_zz_b3", itemName, productQuantity: 1, packageCount: 2, packageUnit: "箱",
    transportMode: "sea", receiverNameTh: "收件人", receiverPhoneTh: "0811111111", receiverAddressTh: addr, approvalStatus,
    shipDate: "2026-09-01", batchNo: "ZZB3CU7777777", volumeM3: 1.2, weightKg: 30,
  });
  await prisma.order.createMany({
    data: [
      order(`${P}o_a1`, `${P}ca1`, "甲货品A1", "甲地址A1"),
      order(`${P}o_a2pending`, `${P}ca2`, "甲待审货品", "甲地址A2", "pending"),
      order(`${P}o_b1`, `${P}cb1`, "乙货品SECRETB", "乙地址SECRETB"),
      order(`${P}o_x1`, `${P}cx`, "湘泰货品SECRETX", "湘泰地址SECRETX"),
    ],
  });
  await prisma.orderProduct.create({
    data: { id: `${P}op_a1`, companyId: CO, orderId: `${P}o_a1`, itemName: "甲产品行", packageCount: 2, lengthCm: 60, widthCm: 40, heightCm: 30, cargoType: "inspection" },
  });
  const ship = (id: string, orderId: string, trackingNo: string, parentTrackingNo: string | null = null) => ({
    id, companyId: CO, orderId, trackingNo, parentTrackingNo, currentStatus: "loaded", warehouseId: "wh_zz_b3",
    batchNo: "ZZB3CU7777777", containerNo: "ZZB3CU7777777", remark: "运单内部备注SECRETREMARK", volumeM3: 1.2,
  });
  await prisma.shipment.createMany({
    data: [
      ship(`${P}s_a1`, `${P}o_a1`, "ZZB3A1"),
      ship(`${P}s_a1c`, `${P}o_a1`, "ZZB3A1-1", "ZZB3A1"),
      ship(`${P}s_b1`, `${P}o_b1`, "ZZB3B1"),
      ship(`${P}s_x1`, `${P}o_x1`, "ZZB3X1"),
    ],
  });
  await prisma.container.create({
    data: { id: `${P}ct`, companyId: CO, containerNo: "ZZB3CU7777777", containerType: "40HQ", loadingDate: T("2026-09-02T00:00:00Z"), currentStatus: "LOADING", remark: "柜子备注SECRETCT" },
  });
  // 混装柜：甲的子单、乙、湘泰客户的货在同一个柜
  await prisma.shipmentContainerItem.createMany({
    data: [`${P}s_a1c`, `${P}s_b1`, `${P}s_x1`].map((shipmentId, i) => ({ id: `${P}ci${i}`, shipmentId, containerId: `${P}ct`, loadedVolumeM3: 1, loadedPieceCount: 2 })),
  });
  const log = (id: string, shipmentId: string, remark: string, changedAt: string) => ({
    id, companyId: CO, shipmentId, operatorId: `${P}staff`, operatorRole: "staff", operatorName: "员工甲ZZB3",
    fromStatus: "inWarehouseCN", toStatus: "loaded", remark, nextStop: "泰国边境", changedAt: T(changedAt),
  });
  await prisma.statusLog.createMany({
    data: [
      log(`${P}l_a1`, `${P}s_a1`, "入库拍照完成", "2026-09-01T01:00:00Z"),
      log(`${P}l_a1c`, `${P}s_a1c`, "装入柜子 ZZB3CU7777777（分装 2件）", "2026-09-02T01:00:00Z"),
      log(`${P}l_b1`, `${P}s_b1`, "乙备注SECRETB", "2026-09-02T02:00:00Z"),
    ],
  });
  // 一车拉甲和乙的货，同一个派送单号
  await prisma.adminLastmileOrder.createMany({
    data: [
      { id: `${P}lm_a1`, companyId: CO, deliveryNo: "ZZB3DN001", shipmentId: `${P}s_a1`, carrierName: "自有车队", externalTrackingNo: "EXT-ZZB3", driverName: "司机王", licensePlate: "กข1234", phoneNumber: "0812345678", status: "SIGNED", signImageBase64: "aGVsbG8=" },
      { id: `${P}lm_b1`, companyId: CO, deliveryNo: "ZZB3DN001", shipmentId: `${P}s_b1`, carrierName: "自有车队", externalTrackingNo: "EXT-ZZB3", driverName: "乙司机SECRETB", status: "SIGNED" },
    ],
  });
  await prisma.clientNote.create({ data: { id: `${P}note`, companyId: CO, clientId: `${P}ca1`, content: "内部备注SECRETNOTE" } });

  // 仓库版集货：plan1 混着甲、乙、湘泰三家
  const plan = (id: string, planNo: string, status: string) => ({
    id, companyId: CO, planNo, destinationTh: "曼谷", status, createdBy: `${P}admin`, creatorName: "管理员SECRETADMIN", totalVolumeM3: 68,
  });
  await prisma.whrConsolidationPlan.createMany({
    data: [plan(`${P}plan1`, "WHRZZB301", "collecting"), plan(`${P}plan2`, "WHRZZB302", "collecting"), plan(`${P}plan3`, "WHRZZB303", "planning")],
  });
  const pc = (id: string, planId: string, clientId: string, prices: [number, number, number], deliveryAddress: string | null) => ({
    id, planId, companyId: CO, clientId, unitPriceNormal: prices[0], unitPriceInspection: prices[1], unitPriceSensitive: prices[2], deliveryAddress, totalVolumeM3: 3,
  });
  await prisma.whrConsolidationPlanCustomer.createMany({
    data: [
      pc(`${P}pc_a1`, `${P}plan1`, `${P}ca1`, [600, 650, 700], "甲泰国地址"),
      pc(`${P}pc_b1`, `${P}plan1`, `${P}cb1`, [450, 500, 550], "乙泰国地址SECRETB"),
      pc(`${P}pc_x1`, `${P}plan1`, `${P}cx`, [480, 520, 560], "湘泰地址SECRETX"),
      pc(`${P}pc_b2`, `${P}plan2`, `${P}cb1`, [450, 500, 550], null),
      pc(`${P}pc_a2`, `${P}plan3`, `${P}ca2`, [600, 650, 700], null),
    ],
  });
  const pa = (id: string, customerId: string, trackingNo: string, mark: string, status: string, extra: Record<string, unknown> = {}) => ({
    id, customerId, companyId: CO, trackingNo, mark, status, ...extra,
  });
  await prisma.whrConsolidationPrealert.createMany({
    data: [
      pa(`${P}pa_a1`, `${P}pc_a1`, "ZZB3P-A1", "ca1", "pending"),
      pa(`${P}pa_a1paid`, `${P}pc_a1`, "ZZB3P-A1P", "ca1", "paid", {
        totalFee: 600, paidAgentId: `${P}agA`, rebateAmount: 100, paymentReviewedAt: T("2026-09-03T00:00:00Z"), paymentReviewedBy: `${P}admin`,
        signedAt: T("2026-09-02T00:00:00Z"),
        warehouseReceiptProofs: [{ base64Path: "/images/zz_b3_sign.jpg", fileName: "sign.jpg", mime: "image/jpeg", uploadedAt: "2026-09-02T00:00:00Z", operatorName: "员工甲ZZB3" }],
        paymentProofs: [{ base64Path: "/images/zz_b3_pay_SECRETPAY.jpg" }],
      }),
      pa(`${P}pa_b1`, `${P}pc_b1`, "ZZB3P-B1", "cb1SECRETB", "received_pending_payment", { totalFee: 450 }),
      pa(`${P}pa_x1`, `${P}pc_x1`, "ZZB3P-X1", "cxSECRETX", "pending"),
      pa(`${P}pa_a2`, `${P}pc_a2`, "ZZB3P-A2", "ca2", "received_pending_payment", { totalFee: 300, signedAt: T("2026-09-04T00:00:00Z") }),
    ],
  });
  const item = (id: string, prealertId: string, productName: string, dims: [number | null, number | null, number | null], volumeM3: number | null) => ({
    id, prealertId, companyId: CO, productName, packageCount: 1, material: "布", cargoValue: "100", cargoType: "normal",
    lengthCm: dims[0], widthCm: dims[1], heightCm: dims[2], volumeM3,
  });
  await prisma.whrConsolidationPrealertItem.createMany({
    data: [
      item(`${P}it_a1`, `${P}pa_a1`, "甲品名WHR", [null, 40, 30], null), // 没填尺寸
      item(`${P}it_a1p`, `${P}pa_a1paid`, "甲已付品名", [100, 100, 100], 1),
      item(`${P}it_b1`, `${P}pa_b1`, "乙品名SECRETB", [100, 100, 100], 1),
      item(`${P}it_x1`, `${P}pa_x1`, "湘泰品名SECRETX", [null, null, null], null),
      item(`${P}it_a2`, `${P}pa_a2`, "甲二品名", [100, 50, 100], 0.5),
    ],
  });
  await prisma.whrConsolidationStatusLog.create({
    data: { id: `${P}wl1`, prealertId: `${P}pa_a1paid`, companyId: CO, operatorId: `${P}admin`, operatorRole: "admin", operatorName: "管理员SECRETADMIN", fromStatus: "received_pending_payment", toStatus: "paid", remark: "客户付款" },
  });
  await prisma.clientWhrPrice.create({
    data: { clientId: `${P}ca1`, companyId: CO, priceNormal: 600, priceInspection: 650, priceSensitive: 700, updatedBy: `${P}admin`, updatedByRole: "admin" },
  });
  await prisma.clientWalletAccount.createMany({
    data: [
      { clientId: `${P}ca1`, companyId: CO, currency: "CNY", balance: 1000 },
      { clientId: `${P}cb1`, companyId: CO, currency: "CNY", balance: 2000 },
      { clientId: `${P}cx`, companyId: CO, currency: "CNY", balance: 3000 },
    ],
  });
  await prisma.walletRecharge.createMany({
    data: [
      { id: `${P}r_a1`, companyId: CO, clientId: `${P}ca1`, currency: "CNY", amount: 500, paymentMethod: "WECHAT", proofImage: "/images/zz_b3_SECRETPROOF.jpg", status: "APPROVED", reviewRemark: "审核备注SECRETREVIEW", reviewedBy: `${P}admin` },
      { id: `${P}r_b1`, companyId: CO, clientId: `${P}cb1`, currency: "CNY", amount: 777.77, paymentMethod: "ALIPAY", proofImage: "/images/zz_b3_b.jpg", status: "PENDING" },
    ],
  });
  const d = T("2026-08-20T00:00:00Z");
  await prisma.agentRebateStatement.createMany({
    data: [
      { id: `${P}st_a`, companyId: CO, agentId: `${P}agA`, month: "2026-08", lineCount: 1, totalVolumeM3: 1, totalRebate: 100, status: "paid", paidAt: d, paidBy: `${P}admin` },
      { id: `${P}st_b`, companyId: CO, agentId: `${P}agB`, month: "2026-08", lineCount: 1, totalVolumeM3: 1, totalRebate: 50, status: "unpaid" },
    ],
  });
  const line = (id: string, statementId: string, prealertId: string, clientId: string, mark: string, productNames: string, rebate: number) => ({
    id, statementId, companyId: CO, prealertId, trackingNo: `T-${id}`, planNo: "WHRZZB301", clientId, mark, productNames,
    volumeNormalM3: 1, volumeInspectionM3: 0, volumeSensitiveM3: 0,
    clientPriceNormal: 600, clientPriceInspection: 650, clientPriceSensitive: 700,
    agentPriceNormal: 500, agentPriceInspection: 550, agentPriceSensitive: 600,
    rebateAmount: rebate, prealertCreatedAt: d, thailandReceivedAt: d,
  });
  await prisma.agentRebateLine.createMany({
    data: [
      line(`${P}ln_a`, `${P}st_a`, `${P}pa_a1paid`, `${P}ca1`, "ca1", "甲返现品名", 100),
      line(`${P}ln_b`, `${P}st_b`, `${P}pa_b1`, `${P}cb1`, "cb1", "乙返现SECRETB", 50),
    ],
  });
}

async function dbChecks(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url || url.includes("blocked")) {
    console.log("\n【真接口】跳过：没有 DATABASE_URL（CI 没有数据库，这一段只在本地连测试库跑）");
    return;
  }
  if (!url.includes("neon.tech") && process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("\n【真接口】跳过：DATABASE_URL 不是 Neon 测试库，怕连到生产库不跑（确认是测试库可设 AGENT_PORTAL_TEST_ALLOW_DB=1）");
    return;
  }
  if (!process.env.AUTH_SECRET) process.env.AUTH_SECRET = "zz_b3_local_test_secret";
  process.env.NODE_ENV = process.env.NODE_ENV || "test";

  console.log("\n【真接口】连测试库 + 起 HTTP 服务");
  const { prisma } = await import("../apps/api/src/db/prisma");
  const { createApp } = await import("../apps/api/src/server");
  const { signAuthToken } = await import("../apps/api/src/modules/auth/token");
  const { registerAgentPortalRoutes } = await import("../apps/api/src/modules/agent-portal/routes");
  const { registerAdminRoutes } = await import("../apps/api/src/modules/admin/routes");
  const { registerShipmentRoutes } = await import("../apps/api/src/modules/shipments/routes");
  const { registerOrderRoutes } = await import("../apps/api/src/modules/orders/routes");
  const { registerContainerRoutes } = await import("../apps/api/src/modules/containers/routes");
  const { registerWhrConsolidationClientRoutes } = await import("../apps/api/src/modules/whr-consolidation/client-routes");

  await cleanup(prisma);
  let server: { close: () => void } | null = null;
  try {
    await seed(prisma);

    const app = createApp();
    registerAgentPortalRoutes(app);
    registerAdminRoutes(app);
    registerShipmentRoutes(app);
    registerOrderRoutes(app);
    registerContainerRoutes(app);
    registerWhrConsolidationClientRoutes(app);
    // MinimalHttpApp.listen 不返回 server；等它起来，退出时整个进程结束
    await new Promise<void>((resolve) => app.listen(PORT, resolve));
    server = { close: () => undefined };

    const token = (userId: string, role: "agent" | "client" | "staff" | "admin") =>
      signAuthToken({ userId, companyId: CO, role, userName: userId });
    const A = token(`${P}login_a`, "agent");
    const B = token(`${P}login_b`, "agent");
    const tokens = { staff: token(`${P}staff`, "staff"), client: token(`${P}ca1`, "client"), admin: token(`${P}admin`, "admin") };

    const collected: string[] = [];
    const call = async (tk: string, method: "GET" | "POST", path: string, body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
        method,
        headers: { Authorization: `Bearer ${tk}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* 非 JSON 原样留着 */ }
      if (tk === A) collected.push(text);
      return { status: r.status, json, text };
    };
    const okData = async (tk: string, path: string) => {
      const r = await call(tk, "GET", path);
      assert.equal(r.status, 200, `${path} → ${r.status} ${r.text.slice(0, 300)}`);
      return r.json.data;
    };

    await check("/agent/me：只有自己的名字、logo、代理价", async () => {
      const d = await okData(A, "/agent/me");
      assert.deepEqual(d, { name: "代理甲ZZB3", logoUrl: "/images/zz_b3_logo.png", slug: null, customDomain: null, prices: { normal: 500, inspection: 550, sensitive: 600 } });
    });

    await check("/agent/clients：只有名下两个客户，价格不带操作人", async () => {
      const d = await okData(A, "/agent/clients");
      assert.deepEqual(d.items.map((i: any) => i.clientId), [`${P}ca1`, `${P}ca2`]);
      assert.deepEqual(d.agentPrices, { normal: 500, inspection: 550, sensitive: 600 });
      const ca1 = d.items.find((i: any) => i.clientId === `${P}ca1`);
      assert.deepEqual(Object.keys(ca1.price).sort(), ["inspection", "normal", "sensitive", "updatedAt"]);
      assert.equal(d.items.find((i: any) => i.clientId === `${P}ca2`).price, null, "没填价的给 null，页面标「未填价」");
    });

    await check("/agent/shipments：只有名下已审单（待审的不列），字段里没有柜号 / 备注 / 加收金额", async () => {
      const d = await okData(A, "/agent/shipments");
      assert.equal(d.total, 1);
      assert.deepEqual(d.items.map((i: any) => i.trackingNo), ["ZZB3A1"]);
      const it = d.items[0];
      for (const k of ["batchNo", "containerNo", "remark", "receivableAmountCny", "paidBy", "logisticsRecords"]) assert.ok(!(k in it), `不该有 ${k}`);
      assert.equal(it.lengthCm, "60");
      assert.equal(it.clientName, "甲客一");
      assert.deepEqual(d.clients.map((c: any) => c.clientId), [`${P}ca1`, `${P}ca2`]);
    });

    await check("/agent/shipments 拿别人的唛头 / 运单号筛选 → 空，不报错也不漏", async () => {
      const byClient = await okData(A, `/agent/shipments?clientId=${P}cb1`);
      assert.equal(byClient.total, 0);
      const byNo = await okData(A, "/agent/shipments?trackingNo=ZZB3X1");
      assert.equal(byNo.total, 0);
      const bad = await call(A, "GET", "/agent/shipments?page=1e400");
      assert.equal(bad.status, 400);
    });

    await check("/agent/shipments 状态分组在全集上筛、total 是真实数", async () => {
      const transit = await okData(A, "/agent/shipments?statusGroup=transit");
      assert.equal(transit.total, 1, "loaded 算在途");
      const delivered = await okData(A, "/agent/shipments?statusGroup=delivered");
      assert.equal(delivered.total, 0);
    });

    await check("/agent/shipments/export-data：只导名下；勾选里夹别人的 id 被丢掉；日期筛选生效", async () => {
      const all = await okData(A, "/agent/shipments/export-data");
      assert.deepEqual(all.items.map((i: any) => i.trackingNo), ["ZZB3A1"]);
      const picked = await okData(A, `/agent/shipments/export-data?orderIds=${P}o_b1,${P}o_x1`);
      assert.equal(picked.total, 0);
      const inRange = await okData(A, "/agent/shipments/export-data?dateFrom=2026-09-01&dateTo=2026-09-01");
      assert.equal(inRange.total, 1);
      const outRange = await okData(A, "/agent/shipments/export-data?dateFrom=2026-09-02");
      assert.equal(outRange.total, 0);
    });

    await check("/agent/shipments/track：自己的单给客户视角（柜号抹掉、无操作人、司机和签收照片照给）", async () => {
      const d = await okData(A, "/agent/shipments/track?trackingNo=ZZB3A1");
      assert.equal(d.viewerRole, "agent");
      assert.equal(d.timeline.length, 2, "父单轨迹合并子单");
      assert.ok(d.timeline.some((t: any) => t.remark.includes("已装柜")));
      for (const t of d.timeline) assert.deepEqual(Object.keys(t).sort(), ["changedAt", "fromStatus", "nextStop", "remark", "toStatus", "trackingNo"]);
      assert.equal(d.lastmile.driverName, "司机王");
      assert.equal(d.lastmile.phoneNumber, "0812345678");
      assert.ok(d.lastmile.signImageBase64.startsWith("data:image/jpeg;base64,"));
      assert.ok(!("deliveryNo" in d.lastmile));
      assert.equal(d.children[0].batchNo, null);
      // 子单查进来也行（同一张订单）
      const child = await okData(A, "/agent/shipments/track?trackingNo=ZZB3A1-1");
      assert.equal(child.containers.length, 1);
      assert.deepEqual(Object.keys(child.containers[0]).sort(), ["ata", "containerStatus", "customsClearedAt", "departureDate", "loadingDate"]);
    });

    await check("/agent/shipments/track：别家的单、湘泰的单、不存在的单 → 同一句 404", async () => {
      const b = await call(A, "GET", "/agent/shipments/track?trackingNo=ZZB3B1");
      const x = await call(A, "GET", `/agent/shipments/track?shipmentId=${P}s_x1`);
      const none = await call(A, "GET", "/agent/shipments/track?trackingNo=ZZB3-NOPE");
      assert.equal(b.status, 404);
      assert.equal(x.status, 404);
      assert.equal(none.status, 404);
      assert.equal(b.json.message, none.json.message, "不许区分「不存在」和「不是你的」");
      assert.equal(x.json.message, none.json.message);
      // 反过来：代理乙看代理甲的单也是 404
      const ba = await call(B, "GET", "/agent/shipments/track?trackingNo=ZZB3A1");
      assert.equal(ba.status, 404);
    });

    await check("/agent/whr/plans：混装计划里只有名下客户那一行，没有整柜方数和建柜人", async () => {
      const d = await okData(A, "/agent/whr/plans");
      const planNos = d.items.map((p: any) => p.planNo).sort();
      assert.deepEqual(planNos, ["WHRZZB301", "WHRZZB303"], "只有乙的计划 WHRZZB302 不出现");
      const p1 = d.items.find((p: any) => p.planNo === "WHRZZB301");
      assert.deepEqual(p1.customers.map((c: any) => c.clientId), [`${P}ca1`]);
      for (const k of ["totalVolumeM3", "usedVolumeM3", "creatorName", "createdBy"]) assert.ok(!(k in p1), `计划上不该有 ${k}`);
    });

    await check("/agent/whr/plan-detail：别人整行不出现；照片不夹带操作人；付款截图不给；返现给自己的", async () => {
      const d = await okData(A, `/agent/whr/plan-detail?planId=${P}plan1`);
      assert.deepEqual(d.customers.map((c: any) => c.clientId), [`${P}ca1`]);
      const paid = d.customers[0].prealerts.find((p: any) => p.trackingNo === "ZZB3P-A1P");
      assert.equal(paid.rebateAmount, 100);
      assert.deepEqual(paid.warehouseReceiptProofs, [{ base64Path: "/images/zz_b3_sign.jpg", fileName: "sign.jpg", mime: "image/jpeg", uploadedAt: "2026-09-02T00:00:00Z" }]);
      assert.ok(!("paymentProofs" in paid) && !("paymentReviewedBy" in paid));
      assert.deepEqual(Object.keys(paid.statusLogs[0]).sort(), ["createdAt", "fromStatus", "id", "remark", "toStatus"]);
    });

    await check("/agent/whr/plan-detail：只有别家客户的计划 / 不存在的计划 → 同一句 404；代理乙看甲独占的计划 404", async () => {
      const b = await call(A, "GET", `/agent/whr/plan-detail?planId=${P}plan2`);
      const none = await call(A, "GET", `/agent/whr/plan-detail?planId=${P}nope`);
      assert.equal(b.status, 404);
      assert.equal(none.status, 404);
      assert.equal(b.json.message, none.json.message);
      const ba = await call(B, "GET", `/agent/whr/plan-detail?planId=${P}plan3`);
      assert.equal(ba.status, 404);
      // 乙看混装计划只看到乙那一行
      const bMixed = await call(B, "GET", `/agent/whr/plan-detail?planId=${P}plan1`);
      assert.equal(bMixed.status, 200);
      assert.deepEqual(bMixed.json.data.customers.map((c: any) => c.clientId), [`${P}cb1`]);
      assert.ok(!bMixed.text.includes("甲泰国地址") && !bMixed.text.includes("湘泰地址SECRETX"));
    });

    await check("/agent/dashboard：三类卡住的单只有名下的", async () => {
      const d = await okData(A, "/agent/dashboard");
      assert.equal(d.clientCount, 2);
      assert.deepEqual(d.missingSize.map((p: any) => p.trackingNo), ["ZZB3P-A1"], "湘泰客户那张没填尺寸的不出现");
      assert.deepEqual(d.unpaid.map((p: any) => p.trackingNo), ["ZZB3P-A2"], "乙那张待付款不出现");
      assert.deepEqual(d.missingAddress.map((r: any) => `${r.planNo}/${r.clientId}`), [`WHRZZB303/${P}ca2`], "乙在 plan2 没填地址不出现");
    });

    await check("/agent/wallet：只有名下余额和充值，充值不带截图 / 审核备注 / 审核人", async () => {
      const d = await okData(A, "/agent/wallet");
      assert.deepEqual(d.balances.map((b: any) => [b.clientId, b.balance]), [[`${P}ca1`, 1000], [`${P}ca2`, 0]]);
      assert.equal(d.recharges.total, 1);
      assert.deepEqual(Object.keys(d.recharges.items[0]).sort(), ["amount", "clientId", "clientName", "createdAt", "currency", "id", "paymentMethod", "status", "updatedAt"]);
      const other = await okData(A, `/agent/wallet?clientId=${P}cb1`);
      assert.equal(other.recharges.total, 0);
    });

    await check("/agent/rebates：只有自己的返现单；乙的单明细 404；自己的明细不带内部键", async () => {
      const list = await okData(A, "/agent/rebates");
      assert.deepEqual(list.items.map((s: any) => s.id), [`${P}st_a`]);
      assert.ok(!("paidBy" in list.items[0]));
      const detail = await okData(A, `/agent/rebates/detail?statementId=${P}st_a`);
      assert.equal(detail.lines.length, 1);
      assert.equal(detail.lines[0].rebateAmount, 100);
      const b = await call(A, "GET", `/agent/rebates/detail?statementId=${P}st_b`);
      const none = await call(A, "GET", `/agent/rebates/detail?statementId=${P}nope`);
      assert.equal(b.status, 404);
      assert.equal(b.json.message, none.json.message);
    });

    await check("POST /agent/clients/price：别家客户 404、湘泰客户 404、低于代理价 400 且没写库", async () => {
      const b = await call(A, "POST", "/agent/clients/price", { clientId: `${P}cb1`, prices: { normal: 900, inspection: 900, sensitive: 900 } });
      assert.equal(b.status, 404, b.text);
      const x = await call(A, "POST", "/agent/clients/price", { clientId: `${P}cx`, prices: { normal: 900, inspection: 900, sensitive: 900 } });
      assert.equal(x.status, 404, x.text);
      const low = await call(A, "POST", "/agent/clients/price", { clientId: `${P}ca2`, prices: { normal: 499, inspection: 560, sensitive: 610 } });
      assert.equal(low.status, 400, low.text);
      assert.ok(low.json.message.includes("500"), low.json.message);
      assert.equal(await prisma.clientWhrPrice.findUnique({ where: { clientId: `${P}ca2` } }), null);
      const cbPrice = await prisma.clientWhrPrice.findUnique({ where: { clientId: `${P}cb1` } });
      assert.equal(cbPrice, null, "别家客户的价没被写进去");
    });

    await check("POST /agent/clients/price：合法价存进去（操作人记 agent），没付款的单按新价重算", async () => {
      const r = await call(A, "POST", "/agent/clients/price", { clientId: `${P}ca2`, prices: { normal: 520, inspection: 560, sensitive: 610 } });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.data.updatedPlanRows, 1);
      assert.deepEqual({ ...r.json.data.price, updatedAt: "x" }, { normal: 520, inspection: 560, sensitive: 610, updatedAt: "x" });
      const saved = await prisma.clientWhrPrice.findUnique({ where: { clientId: `${P}ca2` } });
      assert.equal(saved?.updatedBy, `${P}login_a`);
      assert.equal(saved?.updatedByRole, "agent");
      const pa2 = await prisma.whrConsolidationPrealert.findUnique({ where: { id: `${P}pa_a2` }, select: { totalFee: true } });
      assert.equal(Number(pa2?.totalFee), 260, "0.5 方普货 × 520");
      const pcA2 = await prisma.whrConsolidationPlanCustomer.findUnique({ where: { id: `${P}pc_a2` }, select: { unitPriceNormal: true } });
      assert.equal(Number(pcA2?.unitPriceNormal), 520);
    });

    await check("agent 令牌打 /admin/* /staff/* /client/* 一律 403", async () => {
      for (const path of ["/admin/users", "/staff/shipments", "/client/orders", "/client/shipments/track?trackingNo=ZZB3A1", "/client/whr-consolidation/plans"]) {
        const r = await call(A, "GET", path);
        assert.equal(r.status, 403, `${path} → ${r.status}`);
      }
    });

    await check("员工 / 客户 / 管理员令牌打 /agent/* 一律 403", async () => {
      for (const tk of Object.values(tokens)) {
        for (const path of ["/agent/me", "/agent/shipments", `/agent/whr/plan-detail?planId=${P}plan1`]) {
          const r = await call(tk, "GET", path);
          assert.equal(r.status, 403, `${path} → ${r.status}`);
        }
        const w = await call(tk, "POST", "/agent/clients/price", { clientId: `${P}ca1`, prices: { normal: 900, inspection: 900, sensitive: 900 } });
        assert.equal(w.status, 403);
      }
      const anon = await fetch(`http://127.0.0.1:${PORT}/agent/me`);
      assert.equal(anon.status, 401);
    });

    await check("客户改归属当场生效：ca1 挪到代理乙名下后，代理甲立刻 404", async () => {
      await prisma.user.update({ where: { id: `${P}ca1` }, data: { agentId: `${P}agB` } });
      try {
        const r = await call(A, "GET", "/agent/shipments/track?trackingNo=ZZB3A1");
        assert.equal(r.status, 404);
        const list = await okData(A, "/agent/shipments");
        assert.equal(list.total, 0);
      } finally {
        await prisma.user.update({ where: { id: `${P}ca1` }, data: { agentId: `${P}agA` } });
      }
    });

    await check("代理甲所有响应合在一起：别家 / 湘泰 / 内部信息一个字都没有", () => {
      const all = collected.join("\n");
      const hits = MUST_NOT_LEAK.filter((s) => all.includes(s));
      assert.deepEqual(hits, [], `泄漏：${hits.join("、")}`);
      assert.ok(all.length > 2000, "确实收集到了响应");
    });
  } finally {
    await cleanup(prisma).catch((e: unknown) => console.log("  ⚠️ 清理测试数据失败：", e));
    const left = await prisma.user.count({ where: { companyId: CO } });
    console.log(left === 0 ? "  🧹 测试数据已清干净" : `  ⚠️ 还剩 ${left} 个测试用户没删掉`);
    await prisma.$disconnect();
    void server;
  }
}

(async () => {
  await pureChecks();
  await dbChecks();
  console.log(`\n共 ${total} 项，失败 ${failures.length} 项`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  ❌ ${f}`);
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
