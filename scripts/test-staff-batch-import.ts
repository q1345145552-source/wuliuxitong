import assert from "node:assert/strict";
import fs from "node:fs";
import { cargoTypeLabel, parseCargoType, strictestCargoType } from "../packages/shared-types/cargo-type";
import {
  BATCH_SHEET_TO_JSON_OPTIONS,
  lastRowWithCells,
  formatStaffBatchErrorLocation,
  parseStaffBatchRows,
} from "../apps/web/src/modules/staff/batchOrderImport";

function buildRows(orderCount: number): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let i = 1; i <= orderCount; i += 1) {
    const trackingNo = `UTMULTI${String(i).padStart(5, "0")}`;
    const common = {
      "唛头 *": "TEST413CLIENT",
      "运单号 *": trackingNo,
      "仓库 *": "义乌仓",
      "到仓日期 *（YYYY-MM-DD）": "2026-08-27",
      "运输方式 *（海运/陆运）": "海运",
      "包装类型（箱/袋，默认箱）": "箱",
    };
    rows.push({
      ...common,
      "品名 *": `测试桌-${i}`,
      "箱数 *": 2,
      "长cm（数字）": 100,
      "宽cm（数字）": 50,
      "高cm（数字）": 20,
      "单箱重量kg *（数字）": 10,
      产品数量: 2,
    });
    rows.push({
      ...common,
      "品名 *": `测试桌-${i}`,
      "箱数 *": 3,
      "长cm（数字）": 120,
      "宽cm（数字）": 60,
      "高cm（数字）": 25,
      "单箱重量kg *（数字）": 12,
      产品数量: 3,
    });
    rows.push({
      ...common,
      "品名 *": `测试椅-${i}`,
      "箱数 *": 4,
      "长cm（数字）": 60,
      "宽cm（数字）": 55,
      "高cm（数字）": 90,
      "单箱重量kg *（数字）": 8,
      产品数量: 4,
    });
  }
  return rows;
}

const bulk = parseStaffBatchRows(buildRows(100));
assert.equal(bulk.sourceRowCount, 300);
assert.deepEqual(bulk.issues, []);
assert.equal(bulk.orders.length, 100);
assert.equal(bulk.orders.every((order) => order.products.length === 3), true);

/**
 * ⚠️ 原来只逐字核对**第 1 单**，剩下 99 单只看了「有没有 3 行明细」。
 * 解析器只要在第 2 单往后串行（把上一单的明细带过来、序号错位、公共字段继承错），
 * 100 单里 99 单是错的也照样绿。2026-08-28 补严：**100 单逐单核对**。
 *
 * 每单的数字都一样（箱数 2+3+4=9、重量 2×10+3×12+4×8=88、
 * 体积 2×1.00×0.50×0.20 + 3×1.20×0.60×0.25 + 4×0.60×0.55×0.90 = 1.928），
 * 只有品名带序号 —— 所以品名是唯一能抓出「串单」的那一列，必须逐单比。
 */
for (let i = 1; i <= 100; i += 1) {
  const order = bulk.orders[i - 1]!;
  const where = `第 ${i} 单`;
  assert.equal(order.trackingNo, `UTMULTI${String(i).padStart(5, "0")}`, `${where} 运单号不对`);
  assert.equal(order.packageCount, 9, `${where} 箱数不对`);
  /**
   * ⚠️ 产品数量 = Σ(箱数 × 单箱数量) = 2×2 + 3×3 + 4×4 = **29**。
   *
   * 这一行原来断言的是 9（= 2+3+4），把**错的答案写死成了期望值** ——
   * 解析器少乘了箱数，测试却照着解析器的输出写，等于给 bug 盖了个章。
   * 2026-08-28 老板在真页面上实测出来的：他填 2/3/4 箱、每箱 2/3/4 个，
   * 系统报 9，实际应该是 29。
   *
   * 口径见 apps/api/src/modules/orders/routes.ts:833 的注释：
   * 产品行上的这个字段是**单箱数量**，订单级才是总数。
   * 同一个函数里重量和体积都乘了箱数，唯独数量没乘。
   */
  assert.equal(order.productQuantity, 29, `${where} 产品数量不对`);
  assert.equal(order.weightKg, 88, `${where} 重量不对`);
  assert.ok(Math.abs((order.volumeM3 ?? 0) - 1.928) < 1e-9, `${where} 体积不对：${order.volumeM3}`);
  assert.deepEqual(
    order.products.map((product) => ({
      itemName: product.itemName,
      packageCount: product.packageCount,
      lengthCm: product.lengthCm,
      widthCm: product.widthCm,
      heightCm: product.heightCm,
      weightKg: product.weightKg,
    })),
    [
      { itemName: `测试桌-${i}`, packageCount: 2, lengthCm: 100, widthCm: 50, heightCm: 20, weightKg: 10 },
      { itemName: `测试桌-${i}`, packageCount: 3, lengthCm: 120, widthCm: 60, heightCm: 25, weightKg: 12 },
      { itemName: `测试椅-${i}`, packageCount: 4, lengthCm: 60, widthCm: 55, heightCm: 90, weightKg: 8 },
    ],
    `${where} 的明细行串了`,
  );
}

/**
 * 后续明细行可以省略**公共字段**（唛头/仓库/日期/运输方式），继承上一行。
 * ⚠️ 但「每箱几个」是**逐行的数据**、不是公共字段，
 *    所以这一行也得填 —— 2026-08-28 加了「要么全填要么全空」之后，
 *    第一行填了第二行不填会被判成填漏（见下面那组用例）。
 *    这里把它补上，用一个跟别的数都不一样的 5：
 *    第 1 行 2 箱 × 每箱 2 个 = 4，第 2 行 1 箱 × 每箱 5 个 = 5，合计 9。
 */
const inherited = parseStaffBatchRows([
  ...buildRows(1).slice(0, 1),
  {
    "品名 *": "后续明细可省略公共字段",
    "箱数 *": 1,
    "包装类型（箱/袋，默认箱）": "",
    "长cm（数字）": 10,
    "宽cm（数字）": 20,
    "高cm（数字）": 30,
    "单箱重量kg *（数字）": 2,
    产品数量: 5,
  },
]);
assert.deepEqual(inherited.issues, []);
assert.equal(inherited.orders.length, 1);
assert.equal(inherited.orders[0].products.length, 2);
assert.equal(inherited.orders[0].packageCount, 3);
assert.equal(inherited.orders[0].productQuantity, 9, "继承行的数量没算对（2×2 + 1×5 = 9）");

const conflict = parseStaffBatchRows([
  ...buildRows(1).slice(0, 1),
  {
    ...buildRows(1)[1],
    "仓库 *": "广州仓",
  },
]);
assert.equal(conflict.orders.length, 0);
assert.equal(conflict.issues.some((issue) => issue.message.includes("仓库")), true);

// 报错必须让员工一眼看出是哪张单、哪个客户唛头，不用再回 Excel 反查。
assert.equal(
  formatStaffBatchErrorLocation("Excel 第7、8、9行", "SZ260802947", "XHH-7752"),
  "Excel 第7、8、9行（运单号 SZ260802947，唛头 XHH-7752）",
);
assert.equal(
  formatStaffBatchErrorLocation("Excel 第2行", undefined, undefined),
  "Excel 第2行（运单号 —，唛头 —）",
);
assert.equal(conflict.issues[0]?.clientId, "TEST413CLIENT", "解析错误丢了对应唛头");


// 不只是客户匹配失败：运输方式、箱数、尺寸等任何解析错误也要带同一组定位信息。
const otherFieldErrors = parseStaffBatchRows([{
  "唛头 *": "XHH-OTHER",
  "运单号 *": "ERR-OTHER-001",
  "仓库 *": "义乌仓",
  "品名 *": "测试品",
  "箱数 *": 0,
  "长cm（数字）": 10,
  // 2026-08-29 起「单箱重量kg」是必填列 —— 整列不存在会先报一条整表错误，
  // 行级错误根本走不到，所以这里必须把列摆上（值故意留空，另有用例盯必填）。
  "单箱重量kg *（数字）": 3,
  "到仓日期 *（YYYY-MM-DD）": "2026-08-29",
  "运输方式 *（海运/陆运）": "空运",
}]);
assert.ok(otherFieldErrors.issues.length >= 3, "没有造出多个字段解析错误");
for (const issue of otherFieldErrors.issues) {
  assert.equal(issue.trackingNo, "ERR-OTHER-001", `错误没带运单号：${issue.message}`);
  assert.equal(issue.clientId, "XHH-OTHER", `错误没带唛头：${issue.message}`);
}

// 就算运单号本身漏填，只要这一行有唛头，提示里也要把唛头保留下来。
const missingTracking = parseStaffBatchRows([{
  "唛头 *": "XHH-NO-TRACKING",
  "运单号 *": "",
  "仓库 *": "义乌仓",
  "品名 *": "测试品",
  "箱数 *": 1,
  "单箱重量kg *（数字）": 1,
  "到仓日期 *（YYYY-MM-DD）": "2026-08-29",
  "运输方式 *（海运/陆运）": "海运",
}]);
assert.equal(missingTracking.issues[0]?.trackingNo, undefined);
assert.equal(missingTracking.issues[0]?.clientId, "XHH-NO-TRACKING", "缺运单号时把这一行的唛头也丢了");

/**
 * 新旧两个表头都要认，而且都必须**乘箱数**。
 * 模板 2026-08-28 从「产品数量」改成「单箱数量（每箱几个）」，
 * 但老模板下载过、正在用的文件还是旧表头 —— 少认一个，那些文件的数量会整列变空。
 *
 * 用互不相同的数字：5 箱 × 每箱 7 个 = 35，2 箱 × 每箱 3 个 = 6，合计 41。
 * （41 和 5/7/2/3/35/6 都不一样，算错了一眼就看得出来）
 */
for (const [表头, 说明] of [
  ["每箱几个", "新表头"],
  ["产品数量", "老表头（老模板下载过的文件）"],
] as Array<[string, string]>) {
  const common = {
    "唛头 *": "TESTQTY",
    "运单号 *": "UTQTY00001",
    "仓库 *": "义乌仓",
    "到仓日期 *（YYYY-MM-DD）": "2026-08-27",
    "运输方式 *（海运/陆运）": "海运",
  };
  const parsed = parseStaffBatchRows([
    { ...common, "品名 *": "甲", "箱数 *": 5, "单箱重量kg *（数字）": 1, [表头]: 7 },
    { ...common, "品名 *": "乙", "箱数 *": 2, "单箱重量kg *（数字）": 1, [表头]: 3 },
  ]);
  assert.deepEqual(parsed.issues, [], `${说明}：解析报错了`);
  assert.equal(parsed.orders.length, 1, `${说明}：没并成一张单`);
  assert.equal(parsed.orders[0].packageCount, 7, `${说明}：箱数不对`);
  assert.equal(
    parsed.orders[0].productQuantity,
    41,
    `${说明}：产品数量应该是 5×7 + 2×3 = 41（漏乘箱数的话会得到 10）`,
  );
}

/**
 * ⚠️ 新旧两列**同时出现**时，取值不许受列顺序影响（2026-08-28 复核实测报的）。
 *
 * findValue 是「按列顺序找第一个包含任一关键词的列」。
 * 表里同时有旧列「产品数量」和新列「每箱几个」时，
 * 一次性查两个关键词会**看哪一列排在前面**，同一份数据能算出两个不同的总数 ——
 * 复核实测是 10 和 200，**有报大风险**。规矩定死：新列优先，跟列顺序无关。
 */
for (const [顺序说明, buildRow] of [
  [
    "新列在前",
    (n: number, q: number, legacy: number) => ({
      "每箱几个": q, 产品数量: legacy, "品名 *": `甲${n}`, "箱数 *": n,
    }),
  ],
  [
    "旧列在前",
    (n: number, q: number, legacy: number) => ({
      产品数量: legacy, "每箱几个": q, "品名 *": `甲${n}`, "箱数 *": n,
    }),
  ],
] as Array<[string, (n: number, q: number, legacy: number) => Record<string, unknown>]>) {
  const common = {
    "唛头 *": "TESTBOTH",
    "运单号 *": "UTBOTH00001",
    "仓库 *": "义乌仓",
    "到仓日期 *（YYYY-MM-DD）": "2026-08-27",
    "运输方式 *（海运/陆运）": "海运",
    "单箱重量kg *（数字）": 1,
  };
  // 新列填 7，旧列故意填一个完全不同的 99；5 箱 → 只可能是 5×7=35，绝不该是 5×99
  const parsed = parseStaffBatchRows([{ ...common, ...buildRow(5, 7, 99) }]);
  assert.deepEqual(parsed.issues, [], `${顺序说明}：解析报错了`);
  assert.equal(
    parsed.orders[0].productQuantity,
    35,
    `${顺序说明}：取值受了列顺序影响（应该固定认新列 5×7=35，认成旧列会得到 495）`,
  );
}

/**
 * ⚠️ 每箱几个「要么全填、要么全空」（2026-08-28 补）。
 * 原来只要有一行填了，其余空行就按 0 静默计入 —— 总数偏小而且没人知道。
 * 跟单箱重量、尺寸同一个规矩：数字算错比导入失败严重得多。
 */
{
  const common = {
    "唛头 *": "TESTPART",
    "运单号 *": "UTPART00001",
    "仓库 *": "义乌仓",
    "到仓日期 *（YYYY-MM-DD）": "2026-08-27",
    "运输方式 *（海运/陆运）": "海运",
    "单箱重量kg *（数字）": 1,
  };
  const partial = parseStaffBatchRows([
    { ...common, "品名 *": "甲", "箱数 *": 5, "每箱几个": 7 },
    { ...common, "品名 *": "乙", "箱数 *": 2 }, // 这一行没填数量
  ]);
  assert.equal(partial.orders.length, 0, "部分填写还让它过了");
  assert.equal(
    partial.issues.some((i) => i.message.includes("每箱几个")),
    true,
    `没报「要么全填要么全空」：${JSON.stringify(partial.issues)}`,
  );

  // 全空是允许的（这一列本来就是选填）
  const allEmpty = parseStaffBatchRows([
    { ...common, "品名 *": "甲", "箱数 *": 5 },
    { ...common, "品名 *": "乙", "箱数 *": 2 },
  ]);
  assert.deepEqual(allEmpty.issues, [], "全部留空反而被拦了");
  assert.equal(allEmpty.orders[0].productQuantity, undefined, "全空时不该编出一个数");
}

/* ==========================================================================
   后端那句中文提示 —— 真调 POST /staff/orders（2026-08-29 加）
   --------------------------------------------------------------------------
   为什么非加不可：这句「唛头不存在或不属于当前公司」原来**一条测试都没有**。
   我把它改回 `invalid clientId` 之后，13 个测试脚本 + 三个类型检查
   **全都没红**（实测过）。也就是谁哪天顺手改掉，没人会知道，
   直到员工又在页面上看见一句英文。

   ⚠️ 为什么不扫源码：扫源码只能证明「这几个字出现过」，证明不了路由真的会返回它
   （test-product-rows.ts 第 11 项那段注释记的就是这个教训 —— 把校验包进
   `if (false)` 照样全绿）。所以这里真把路由注册进假 app，真调 handler，
   看它真正吐出来的状态码和提示语。

   ⚠️ 怎么做到不连数据库：这条检查前面**唯一**的数据库调用就是
   `prisma.user.findUnique`（routes.ts:975）。而 apps/api/src/db/prisma.ts 是
   `globalThis.__prisma ?? new PrismaClient()` —— 所以只要在 import 之前
   把 `globalThis.__prisma` 换成假的，PrismaClient 根本不会被 new 出来，
   全程零连接。下面那行被挡死的 DATABASE_URL 是第二道保险：
   万一哪天这条路上多了一次真库调用，会当场炸出来，而不是安安静静连上去。
   ========================================================================== */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";
process.env.NODE_ENV = "test";   // db/prisma.ts 只在非 production 下认 globalThis.__prisma

async function checkInvalidClientIdMessage(): Promise<void> {
  let findUniqueCalls = 0;
  /**
   * ⚠️ 假 prisma 必须**从头到尾是同一个对象**。
   * routes.ts 是 `import { prisma } from "../../db/prisma"`，模块第一次被 import 时
   * 就把这个对象抓走了 —— 后面再给 globalThis.__prisma 赋一个新对象，路由里拿到的
   * 还是旧的那个（我第一版就是这么写的，结果日期用例全被唛头那道闸拦下）。
   * 所以换行为只能换这个 clientRow 变量，不能换对象。
   */
  let clientRow: unknown = null;   // null = 查无此唛头
  (globalThis as any).__prisma = {
    user: {
      async findUnique() { findUniqueCalls += 1; return clientRow; },
    },
  };

  type Handler = (req: any, res: any) => Promise<void> | void;
  const routes = new Map<string, Handler>();
  const fakeApp = {
    get(p: string, h: Handler) { routes.set(`GET ${p}`, h); },
    post(p: string, h: Handler) { routes.set(`POST ${p}`, h); },
    put(p: string, h: Handler) { routes.set(`PUT ${p}`, h); },
    patch(p: string, h: Handler) { routes.set(`PATCH ${p}`, h); },
    delete(p: string, h: Handler) { routes.set(`DELETE ${p}`, h); },
    listen() {},
  };
  const orders = await import("../apps/api/src/modules/orders/routes");
  (orders as any).registerOrderRoutes(fakeApp);

  const handler = routes.get("POST /staff/orders");
  assert.ok(handler, "没注册到 POST /staff/orders");

  let status = 0;
  let payload: { message?: string } = {};
  const res: any = {
    status(code: number) { status = code; return res; },
    json(value: unknown) { payload = value as { message?: string }; },
  };
  await handler!({
    method: "POST", path: "", query: {}, headers: {},
    auth: { userId: "STAFF_TEST", companyId: "c_001", role: "staff", name: "测试员工" },
    body: {
      clientId: "__NOT_A_REAL_MARK__",
      warehouseId: "wh_yiwu_01",
      transportMode: "sea",
      arrivedAt: "2026-08-29",
      trackingNo: "TEST-NO-CREATE",
      products: [{ itemName: "测试品", packageCount: 1 }],
    },
  }, res);

  assert.equal(findUniqueCalls, 1, "根本没走到查唛头那一步，这条用例白测了");
  assert.equal(status, 400, `唛头不存在应该 400，实际 ${status}`);
  /**
   * ⚠️ 只断言 400 是不够的 —— 这个请求要是缺了别的必填项，
   * 上面那道「missing required fields」也是 400（product-rows 那边栽过同样的坑）。
   * 所以必须连提示语一起对，确认是**这道闸**发的。
   */
  assert.equal(
    payload.message,
    "唛头不存在或不属于当前公司，请核对客户唛头",
    `提示语不对（别改回英文，员工看不懂）：${JSON.stringify(payload.message)}`,
  );

  /* ------------------------------------------------------------------
     日期这道闸（2026-08-29 加）
     原来只判 `Number.isNaN(new Date(x+"T00:00:00").getTime())`，
     实测 "2026"、"2026-08"、"2026-02-31"、"2026-02-30" **全都被认为合法**
     （2月31号会滚成3月2号），而 shipDate 存的是原文，
     数据库里就真躺着 shipDate="2026" 这种东西。
     ⚠️ 唛头改成能查到，好让请求走过唛头那道闸、真正落到日期这道闸上。
     ------------------------------------------------------------------ */
  clientRow = { id: "C1", companyId: "c_001", role: "client" };
  async function callWith(body: Record<string, unknown>): Promise<{ status: number; message: string }> {
    let st = 0;
    let pl: { message?: string } = {};
    const r: any = { status(c: number) { st = c; return r; }, json(v: unknown) { pl = v as { message?: string }; } };
    await handler!({
      method: "POST", path: "", query: {}, headers: {},
      auth: { userId: "STAFF_TEST", companyId: "c_001", role: "staff", name: "测试员工" },
      body: {
        clientId: "C1", warehouseId: "wh_yiwu_01", transportMode: "sea",
        arrivedAt: "2026-08-29", trackingNo: "TEST-NO-CREATE",
        products: [{ itemName: "测试品", packageCount: 1 }],
        ...body,
      },
    }, r);
    return { status: st, message: pl.message ?? "" };
  }

  for (const bad of ["2026", "2026-08", "2026-02-31", "2026-02-30", "2026/08/29", "2026-8-9", "20260829"]) {
    const out = await callWith({ arrivedAt: bad });
    assert.equal(out.status, 400, `到仓日期「${bad}」居然被放行了（status ${out.status}）`);
    assert.ok(
      out.message.includes("不是有效日期"),
      `到仓日期「${bad}」是被别的闸拦下的，不是日期这道：${JSON.stringify(out.message)}`,
    );
  }

  /* 缺必填项要中文而且点名（原来是英文 "missing required fields"） */
  const missing = await callWith({ warehouseId: "", transportMode: undefined });
  assert.equal(missing.status, 400);
  assert.ok(missing.message.includes("缺少必填项"), `没换成中文：${JSON.stringify(missing.message)}`);
  assert.ok(missing.message.includes("仓库"), `没点名缺哪一项：${JSON.stringify(missing.message)}`);
  assert.ok(missing.message.includes("运输方式"), `没点名缺哪一项：${JSON.stringify(missing.message)}`);

  /* ------------------------------------------------------------------
     货型这道闸（2026-09-11 加）
     原来四个写入口都是 `body.cargoType?.trim() || "normal"` —— 传什么存什么。
     传「商检」会原样存进库，而三端显示用的 cargoTypeLabelOf 认不出来就显示「普货」：
     单子上白写一个错货型，没人会发现。
     ------------------------------------------------------------------ */
  /** 非法货型必须在这道闸上就被 400 拦下 —— 放过去就会往下走到真写库那一段 */
  async function expectCargoReject(body: Record<string, unknown>, label: string) {
    let out: { status: number; message: string };
    try {
      out = await callWith(body);
    } catch (error) {
      // 闸没拦住 → 请求继续往下走，倒在假 prisma 上。这正是「校验失效」的样子
      throw new Error(`${label} 没被货型这道闸拦住，请求继续往下走了：${error instanceof Error ? error.message : error}`);
    }
    assert.equal(out.status, 400, `${label} 被放行了（status ${out.status}）`);
    assert.ok(out.message.includes("货型"), `${label} 是别的闸拦的，不是货型这道：${JSON.stringify(out.message)}`);
    return out;
  }

  // 「普货 」末尾的空格会被 trim 掉，剩下「普货」仍然不是库里那三个值之一
  for (const bad of ["商检", "xyz", "NORMAL_", "普货 "]) {
    const out = await expectCargoReject({ cargoType: bad }, `整票货型「${bad}」`);
    assert.ok(out.message.includes(bad.trim()), `报错里没回显填的原文：${JSON.stringify(out.message)}`);
  }

  /** 产品行上的货型也要校验，而且要点名第几条 */
  {
    const out = await expectCargoReject(
      { products: [{ itemName: "测试品", packageCount: 1, cargoType: "商检" }] },
      "产品行货型「商检」",
    );
    assert.ok(out.message.includes("第 1 条产品"), `没点名是第几条产品：${JSON.stringify(out.message)}`);
  }

  /** 合法的三个值不许被这道闸拦下（后面会因为假 prisma 没实现而抛错，那是正常的） */
  for (const good of ["normal", "inspection", "sensitive", "Inspection", undefined]) {
    let out: { status: number; message: string } | null = null;
    try {
      out = await callWith({ cargoType: good });
    } catch {
      continue; // 过了这道闸、倒在后面的假 prisma 上 —— 正是想要的结果
    }
    if (out && out.status === 400) {
      assert.ok(
        !out.message.includes("货型"),
        `合法货型 ${JSON.stringify(good)} 被货型这道闸拦下了：${JSON.stringify(out.message)}`,
      );
    }
  }

  delete (globalThis as any).__prisma;
}

/* ==========================================================================
   2026-08-29 加固：老板拍板「全部修」的六类问题，每一类都在这里钉住
   --------------------------------------------------------------------------
   下面每一条对应一个**实测出来**的老毛病，不是设想的。
   ========================================================================== */
const FULL: Record<string, unknown> = {
  "唛头 *": "MK001",
  "运单号 *": "T001",
  "仓库 *": "义乌仓",
  "品名 *": "玩具",
  "箱数 *": 5,
  "长cm（数字）": 100,
  "宽cm（数字）": 50,
  "高cm（数字）": 20,
  "单箱重量kg *（数字）": 10,
  "到仓日期 *（YYYY-MM-DD）": "2026-08-29",
  "运输方式 *（海运/陆运）": "海运",
  "每箱几个": 7,
};
/** 基准答案：5 箱 / 每箱7个×5箱=35 / 10kg×5=50 / 1×0.5×0.2×5=0.5 m³ */
function one(row: Record<string, unknown>) {
  return parseStaffBatchRows([row]);
}
function assertBaseline(label: string, r: ReturnType<typeof parseStaffBatchRows>): void {
  assert.deepEqual(r.issues, [], `${label}：不该报错，实际报了 ${JSON.stringify(r.issues.map((i) => i.message))}`);
  const o = r.orders[0];
  assert.ok(o, `${label}：没建出订单`);
  assert.equal(o.packageCount, 5, `${label}：箱数错了`);
  assert.equal(o.productQuantity, 35, `${label}：总数错了`);
  assert.equal(o.weightKg, 50, `${label}：重量错了`);
  assert.equal(o.volumeM3, 0.5, `${label}：方数错了`);
}

assertBaseline("原模板", one({ ...FULL }));

/**
 * ① 员工自己往表里加一列，不许影响任何数字。
 *
 * 原来表头是**包含匹配**、取第一个命中的列，所以加在模板列**左边**的自造列会把它顶掉。
 * 实测（就是这几个数）：加一列「总箱数」=99 → 箱数 99、总数 693、重量 990、方数 9.9，
 * 差 19.8 倍，而且一条提示都没有；同一列加在右边则完全正常。方数是算钱的。
 */
for (const [label, extra] of [
  ["总箱数", { "总箱数": 99 }],
  ["货物长度cm", { "货物长度cm": 999 }],
  ["客户品名备注", { "客户品名备注": "客户瞎写的" }],
  ["运输方式备注", { "运输方式备注": "空运" }],
  ["单箱重量备注", { "单箱重量备注": 888 }],
  ["到仓日期备注", { "到仓日期备注": "2020-01-01" }],
] as [string, Record<string, unknown>][]) {
  assertBaseline(`左边加一列「${label}」`, one({ ...extra, ...FULL }));
  assertBaseline(`右边加一列「${label}」`, one({ ...FULL, ...extra }));
}

/** 同一个字段命中两列 → 报整表错误让员工自己删，不许自己挑一个 */
const dupCol = one({ ...FULL, "箱数": 99 });
assert.equal(dupCol.orders.length, 0, "两列都叫箱数还照样建单了");
assert.equal(dupCol.issues.length, 1, `重复列应该只报一条，实际 ${JSON.stringify(dupCol.issues.map((i) => i.message))}`);
assert.equal(dupCol.issues[0].kind, "file");
assert.ok(dupCol.issues[0].message.includes("请只保留一列"), dupCol.issues[0].message);

/** 缺一整列 → 一条整表错误，不许刷几千行 */
const missingCol = parseStaffBatchRows([{ "唛头 *": "MK", "运单号 *": "T", "品名 *": "甲", "箱数 *": 1 }]);
assert.ok(missingCol.issues.every((i) => i.kind === "file"), "缺列应该全是整表级错误");
assert.ok(missingCol.issues.some((i) => i.message.includes("单箱重量kg")), "没报缺「单箱重量kg」这一列");
assert.equal(missingCol.orders.length, 0);

/**
 * ② 数字：带单位照认，看不懂的当场报错并回显原文，全角先转半角。
 * 原来是把非数字字符全抹掉：「1米」→1cm（方数差 100 倍）、「40*30」→4030、「１2」→2（少 6 倍），全部静默。
 */
for (const good of [100, "100", "100cm", "100 厘米", "１００", "100.0"]) {
  assertBaseline(`长cm=${good}`, one({ ...FULL, "长cm（数字）": good }));
}
for (const bad of ["1米", "40*30", "一百", "100~120"]) {
  const r = one({ ...FULL, "长cm（数字）": bad });
  assert.equal(r.orders.length, 0, `长cm=「${bad}」不该放行`);
  assert.ok(
    r.issues.some((i) => i.message.includes(`「${bad}」`) && i.message.includes("只能填数字")),
    `长cm=「${bad}」的提示没回显原文：${JSON.stringify(r.issues.map((i) => i.message))}`,
  );
  assert.ok(!r.issues.some((i) => i.message.includes("同时填写")), `长cm=「${bad}」多报了一条「长宽高需要同时填写」`);
}
for (const [raw, want] of [["12", 12], ["１2", 12], ["1２", 12], ["１２", 12], ["5箱", 5], ["1,200", 1200]] as [string, number][]) {
  const o = one({ ...FULL, "箱数 *": raw }).orders[0];
  assert.ok(o, `箱数=「${raw}」没建出订单`);
  assert.equal(o.packageCount, want, `箱数=「${raw}」读成了 ${o.packageCount}`);
}

/**
 * ③ 日期：常见写法全认，认不出**在解析阶段**就报中文错。
 * 原来只认 5 位序列号，别的一律透传 → 100 张单排队跑完才一张张失败，还是英文 invalid arrivedAt。
 */
for (const [raw, want] of [
  ["2026-08-29", "2026-08-29"], ["2026/08/29", "2026-08-29"], ["2026.08.29", "2026-08-29"],
  ["2026-8-9", "2026-08-09"], ["2026年8月29日", "2026-08-29"], ["20260829", "2026-08-29"],
  [46265, "2026-08-31"], [46265.5, "2026-08-31"],
] as [string | number, string][]) {
  const o = one({ ...FULL, "到仓日期 *（YYYY-MM-DD）": raw }).orders[0];
  assert.ok(o, `日期「${raw}」没认出来`);
  assert.equal(o.arrivedAt, want, `日期「${raw}」转成了 ${o.arrivedAt}`);
}
for (const bad of ["2026", "2026-08", "2026-02-31", "29/08/2026", "下周三", ""]) {
  const r = one({ ...FULL, "到仓日期 *（YYYY-MM-DD）": bad });
  assert.equal(r.orders.length, 0, `日期「${bad}」不该放行到后端`);
  assert.ok(r.issues.length > 0, `日期「${bad}」一条错都没报`);
}

/** ④ 仓库：只认那四个（标准名、裸城市名或 id），别的当场报错并列出可选值。
 *  2026-09-02（25a613a）加了裸城市名别名——仓库《上传系统数据》真表里写的就是
 *  不带「仓」字的城市名。当时改了解析器却没改这个测试，"义乌" 还留在下面的
 *  「该被拒绝」清单里，CI 从那天起一直红着（2026-09-03 发现并修）。 */
for (const good of ["义乌仓", "广州仓", "东莞仓", "深圳仓", "wh_yiwu_01",
                    "义乌", "广州", "东莞", "深圳"]) {
  const r = one({ ...FULL, "仓库 *": good });
  assert.equal(r.issues.length, 0, `仓库「${good}」被误伤：${JSON.stringify(r.issues.map((i) => i.message))}`);
}
// 「義烏倉」是繁体、「杭州仓」没这个仓、id 也不存在 —— 这三类照旧当场报错。
// ⚠️ 别把「义乌」加回来：它是 2026-09-02 拍板收进来的合法别名（见上）。
for (const bad of ["義烏倉", "杭州仓", "wh_hangzhou_01"]) {
  const r = one({ ...FULL, "仓库 *": bad });
  assert.equal(r.orders.length, 0, `仓库「${bad}」被静默存进去了`);
  assert.ok(r.issues.some((i) => i.message.includes("只能填")), `仓库「${bad}」没列出可选值`);
  assert.equal(r.issues.length, 1, `仓库「${bad}」重复报错：${JSON.stringify(r.issues.map((i) => i.message))}`);
}

/** ⑤ 单箱重量必填（老板 2026-08-29 拍板；模板本来就标了 *，只有代码当选填） */
const noWeight = one({ ...FULL, "单箱重量kg *（数字）": "" });
assert.equal(noWeight.orders.length, 0, "单箱重量留空还建单了");
assert.equal(noWeight.issues.length, 1, `重量漏填只该报一条：${JSON.stringify(noWeight.issues.map((i) => i.message))}`);
assert.ok(noWeight.issues[0].message.includes("单箱重量kg为必填"), noWeight.issues[0].message);

/**
 * ⑥ 中间夹一行空白：跳过，不继承运单号、不产生错误、不拖废上一张单。
 * 原来那一行会继承上一行的运单号，然后因为没品名没箱数把**上一张完全填对的单**整个作废，
 * 报错还挂在那张单上（实测 T002 直接消失）。
 */
const blank = Object.fromEntries(Object.keys(FULL).map((k) => [k, ""]));
const withBlank = parseStaffBatchRows([
  { ...FULL, "运单号 *": "T001", "品名 *": "甲" },
  { ...FULL, "运单号 *": "T002", "品名 *": "乙" },
  blank,
  { ...FULL, "运单号 *": "T003", "品名 *": "丙" },
]);
assert.deepEqual(withBlank.issues, [], "空行产生了错误");
assert.deepEqual(withBlank.orders.map((o) => o.trackingNo), ["T001", "T002", "T003"], "空行把单弄丢了");

/** 空行不许打乱行号：错误在数组第 4 个位置（Excel 第 5 行）就得说第 5 行 */
const rowNo = parseStaffBatchRows([
  { ...FULL, "运单号 *": "T001", "品名 *": "甲" },
  { ...FULL, "运单号 *": "T002", "品名 *": "乙" },
  blank,
  { ...FULL, "运单号 *": "T003", "品名 *": "丙", "箱数 *": "" },
]);
assert.ok(
  rowNo.issues.some((i) => i.rowNumber === 5 && i.message.includes("箱数")),
  `行号错了：${JSON.stringify(rowNo.issues.map((i) => ({ 行: i.rowNumber, 错: i.message })))}`,
);

/**
 * 读表参数：blankrows 一旦被删掉，空行会被 sheet_to_json 丢掉，上面那条行号就又错了。
 * ⚠️ 这一条只挡得住「有人把 blankrows 删了」，挡不住「有人绕开这个常量自己写参数」。
 */
assert.equal(BATCH_SHEET_TO_JSON_OPTIONS.blankrows, true, "blankrows 被去掉了，报错行号会全部错位");
assert.equal(BATCH_SHEET_TO_JSON_OPTIONS.defval, "");

/**
 * 读取范围必须收到「真正有单元格的最后一行」。
 *
 * ⚠️ 这条是我自己捅的娄子换来的：加了 blankrows:true 之后按 !ref 逐行产出，
 * 而老板真实在用的《副本上传系统数据东莞5月》!ref 是 A1:AF1048565、实际只有 67 行。
 * 实测不收范围：104 万行、**1934 MB**、多花 2.4 秒；收了之后 30 MB、0 毫秒。
 * 这个表是在浏览器里解析的，1.9GB 足够把标签页搞崩。
 */
assert.equal(lastRowWithCells(["!ref", "!cols", "A1", "B1", "A67", "AF68"]), 68, "末行算错了");
assert.equal(lastRowWithCells(["!ref"]), 0, "一个单元格都没有时应该返回 0");
assert.equal(lastRowWithCells(["A1", "Z1048565"]), 1048565, "大行号要认得出来");
// 元信息 key 不许被当成单元格（"!ref" 不能被 /^[A-Z]+(\d+)$/ 之外的方式误认）
assert.equal(lastRowWithCells(["!merges", "!margins", "C3"]), 3);

/* ==========================================================================
   仓库真实在用的《上传系统数据》表（2026-09-02 拿到真表后加）
   --------------------------------------------------------------------------
   真表表头：日期, 唛头, 仓库, 运输方式, 运单号, 货型, 品名, 尺寸, 件数, 国内单号,
   单项体积, 单项重量, 总体积, 总重量, 计费体积, 总计费体积, 单价, 单项价格,
   订单总价, 备注, 结算状态。
   跟系统模板差三处：箱数他们叫「件数」、到仓日期叫「日期」、没有单箱重量，
   只有行级总重「单项重量」（真表实测 195kg ÷ 13件 ≈ 15kg/箱 才合理）。
   其余列（尤其跨行累计的「总重量」）一律不认 —— 认了必错。
   ========================================================================== */
const WH_ROW: Record<string, unknown> = {
  日期: "2026-08-30",
  唛头: "WH-MARK01",
  仓库: "东莞仓",
  运输方式: "海运",
  运单号: "SITU9234141",
  货型: "商检",            // 2026-09-11 起解析器认这一列了（以前不认，导进来全变普货、要人工改）
  品名: "沙发",
  尺寸: "42.5*38*51.5",
  件数: 13,
  国内单号: "SF123456",
  单项体积: 1.08,
  单项重量: 195,
  总体积: 5.4,
  总重量: 999,             // ⚠️ 跨行的订单总重 —— 绝不能被认成任何重量（下面有专门用例盯它）
  计费体积: 1.1,
  总计费体积: 5.5,
  单价: 730,
  单项价格: 803,
  订单总价: 3940,
  备注: "易碎",
  结算状态: "未结算",
};

/** 整行原样解析：件数/日期/单项重量/尺寸 全认对，闲杂列一个都不许捣乱 */
{
  const r = parseStaffBatchRows([{ ...WH_ROW }]);
  assert.deepEqual(r.issues, [], `仓库表格式报错了：${JSON.stringify(r.issues.map((i) => i.message))}`);
  const o = r.orders[0];
  assert.ok(o, "仓库表格式没建出订单");
  assert.equal(o.packageCount, 13, "「件数」没被认成箱数");
  assert.equal(o.arrivedAt, "2026-08-30", "「日期」没被认成到仓日期");
  assert.equal(o.warehouseId, "wh_dongguan_01", "仓库没认对");
  assert.equal(o.products[0].weightKg, 15, `单项重量 195÷13件 应换算成 15kg/箱，实际 ${o.products[0].weightKg}`);
  assert.equal(o.weightKg, 195, `订单总重应该是 15×13=195，实际 ${o.weightKg}（=999 说明「总重量」被误认了）`);
  assert.deepEqual(
    [o.products[0].lengthCm, o.products[0].widthCm, o.products[0].heightCm],
    [42.5, 38, 51.5],
    "「尺寸」42.5*38*51.5 没拆成长宽高",
  );
  assert.ok(
    Math.abs((o.volumeM3 ?? 0) - (42.5 * 38 * 51.5 * 13) / 1e6) < 1e-9,
    `方数不对：${o.volumeM3}`,
  );
  assert.equal(o.products[0].domesticTrackingNo, "SF123456", "国内单号丢了");
  // 仓库真表里那一列就叫「货型」、填的是「商检」—— 2026-09-11 起必须认出来，不能再变普货
  assert.equal(o.products[0].cargoType, "inspection", `仓库表的「商检」没认出来：${o.products[0].cargoType}`);
  assert.equal(o.cargoType, "inspection", `运单这一层的货型不对：${o.cargoType}`);
}

/* ==========================================================================
   货型（2026-09-11 老板：批量上传运单的模板要加货型，不然默认普货）
   ========================================================================== */
const CARGO_BASE: Record<string, unknown> = {
  "唛头 *": "CARGOMARK",
  "运单号 *": "CARGO0001",
  "仓库 *": "义乌仓",
  "到仓日期 *（YYYY-MM-DD）": "2026-09-11",
  "运输方式 *（海运/陆运）": "海运",
  "品名 *": "沙发",
  "箱数 *": 2,
  "单箱重量kg *（数字）": 10,
};
const CARGO_COL = "货型（普货/商检/敏感，默认普货）";

/** 没有货型这一列（老模板下载过的文件）→ 照旧普货，不许报错 */
{
  const r = parseStaffBatchRows([{ ...CARGO_BASE }]);
  assert.deepEqual(r.issues, [], `没有货型列就报错了：${JSON.stringify(r.issues.map((i) => i.message))}`);
  assert.equal(r.orders[0].products[0].cargoType, "normal");
  assert.equal(r.orders[0].cargoType, "normal");
}

/** 三种写法 + 留空 + 全角/空格/英文 都要认对 */
{
  const cases: Array<[unknown, string]> = [
    ["普货", "normal"], ["商检", "inspection"], ["敏感", "sensitive"],
    ["", "normal"], ["   ", "normal"], [null, "normal"], [undefined, "normal"],
    ["　商检　", "inspection"], ["ｓｅｎｓｉｔｉｖｅ", "sensitive"], ["Inspection", "inspection"],
    ["普通", "normal"], ["敏感货", "sensitive"], ["商检货", "inspection"],
  ];
  for (const [raw, expected] of cases) {
    const r = parseStaffBatchRows([{ ...CARGO_BASE, [CARGO_COL]: raw }]);
    assert.deepEqual(r.issues, [], `货型 ${JSON.stringify(raw)} 报错了：${JSON.stringify(r.issues.map((i) => i.message))}`);
    assert.equal(r.orders[0].products[0].cargoType, expected, `货型 ${JSON.stringify(raw)} 应该是 ${expected}，实际 ${r.orders[0].products[0].cargoType}`);
    assert.equal(r.orders[0].cargoType, expected, `运单层货型 ${JSON.stringify(raw)} 不对`);
  }
}

/** 填了认不出来的字 → 当场报错，**绝不静默变普货**（商检货走普货，清关单据是另一套） */
{
  for (const bad of ["危险品", "普通货物", "商检/敏感", "1"]) {
    const r = parseStaffBatchRows([{ ...CARGO_BASE, [CARGO_COL]: bad }]);
    assert.equal(r.orders.length, 0, `货型「${bad}」认不出来却还是建单了 —— 它会被当成普货`);
    const msg = r.issues.map((i) => i.message).join("；");
    assert.ok(msg.includes(bad), `报错里没回显填的原文：${msg}`);
    assert.ok(msg.includes("普货") && msg.includes("商检") && msg.includes("敏感"), `报错里没告诉能填什么：${msg}`);
  }
}

/** 同一运单几行货型不一样 → 按行各自记，运单这一层取最严的（敏感 > 商检 > 普货） */
{
  const r = parseStaffBatchRows([
    { ...CARGO_BASE, "品名 *": "沙发", [CARGO_COL]: "普货" },
    { ...CARGO_BASE, "品名 *": "茶几", [CARGO_COL]: "商检" },
    { ...CARGO_BASE, "品名 *": "台灯", [CARGO_COL]: "敏感" },
  ]);
  assert.deepEqual(r.issues, [], `混合货型报错了：${JSON.stringify(r.issues.map((i) => i.message))}`);
  const o = r.orders[0];
  assert.deepEqual(o.products.map((p) => p.cargoType), ["normal", "inspection", "sensitive"], "每行的货型没各自记住");
  assert.equal(o.cargoType, "sensitive", `运单层该取最严的 sensitive，实际 ${o.cargoType}`);
  // 混合货型不许顺带把别的数字算错
  assert.equal(o.packageCount, 6, `箱数被货型影响了：${o.packageCount}`);
  assert.equal(o.itemName, "沙发 / 茶几 / 台灯", `品名拼错了：${o.itemName}`);
}

/**
 * 模板和解析器不许各走各的：把**真页面源码里**那一列的表头抠出来，拿它当 key 跑一遍解析。
 * 谁改了表头而另一边没跟上，这一条就红 —— 比单独 grep 一下「有没有这个字」实在。
 */
{
  const staffPage = fs.readFileSync("apps/web/src/app/staff/page.tsx", "utf8");
  const header = /"(货型[^"]*)":\s*""/.exec(staffPage);
  assert.ok(header, "员工端批量下单模板里找不到「货型」那一列");
  const r = parseStaffBatchRows([{ ...CARGO_BASE, [header![1]]: "商检" }]);
  assert.deepEqual(r.issues, [], `模板表头「${header![1]}」解析器不认：${JSON.stringify(r.issues.map((i) => i.message))}`);
  assert.equal(r.orders[0].products[0].cargoType, "inspection", `模板表头「${header![1]}」没解析成商检`);

  // 管理员端那张 12 列模板：表头里要有「货型」，导入时也要真把它读出来
  const adminPage = fs.readFileSync("apps/web/src/app/admin/page.tsx", "utf8");
  assert.ok(/const headers = \[[^\]]*"货型"/.test(adminPage), "管理员运单导入模板的表头里没有「货型」");
  assert.ok(adminPage.includes('r["货型"]'), "管理员导入没读「货型」这一列，填了也白填");
}

/** 两列都叫货型（比如员工自己又加了一列「货物类型」）→ 按重复列拦下，不猜 */
{
  const r = parseStaffBatchRows([{ ...CARGO_BASE, [CARGO_COL]: "商检", 货物类型: "普货" }]);
  assert.equal(r.orders.length, 0, "两列货型还放行了");
  assert.ok(
    r.issues.some((i) => i.kind === "file" && i.message.includes("货型")),
    `应该报货型列重复：${JSON.stringify(r.issues.map((i) => i.message))}`,
  );
}

/** 「总重量」表头绝不能被认成重量：删掉「单项重量」后只剩「总重量」→ 必须按缺列拦下 */
{
  const rest = { ...WH_ROW };
  delete rest["单项重量"];
  const r = parseStaffBatchRows([rest]);
  assert.equal(r.orders.length, 0, "没有单项重量、只剩「总重量」还建单了 —— 跨行的总重被误认了");
  assert.ok(
    r.issues.some((i) => i.kind === "file" && i.message.includes("单箱重量kg")),
    `应该报缺「单箱重量kg」这一列：${JSON.stringify(r.issues.map((i) => i.message))}`,
  );
}

/** 两列都填但对不上（10×13=130 vs 195，差远超 1%）→ 报错让员工核对，不悄悄选边 */
{
  const r = parseStaffBatchRows([{ ...WH_ROW, 单箱重量kg: 10 }]);
  assert.equal(r.orders.length, 0, "单箱重量×件数 跟单项重量对不上还放行了");
  assert.ok(
    r.issues.some((i) => i.message.includes("对不上") && i.message.includes("130") && i.message.includes("195")),
    `核对提示没把两边的数都摆出来：${JSON.stringify(r.issues.map((i) => i.message))}`,
  );
}

/** 两列都填且一致（15×13=195）→ 放行，用员工亲手填的单箱重量 */
{
  const r = parseStaffBatchRows([{ ...WH_ROW, 单箱重量kg: 15 }]);
  assert.deepEqual(r.issues, [], `两列一致还报错：${JSON.stringify(r.issues.map((i) => i.message))}`);
  assert.equal(r.orders[0].products[0].weightKg, 15);
}

/** 换算除不尽 → 四舍五入到 2 位：196÷13=15.0769… → 15.08；195.05÷13=15.0038… → 15 */
{
  const up = parseStaffBatchRows([{ ...WH_ROW, 单项重量: 196 }]);
  assert.deepEqual(up.issues, [], `196÷13 报错了：${JSON.stringify(up.issues.map((i) => i.message))}`);
  assert.equal(up.orders[0].products[0].weightKg, 15.08, `进位口径不对：${up.orders[0].products[0].weightKg}`);
  const down = parseStaffBatchRows([{ ...WH_ROW, 单项重量: 195.05 }]);
  assert.equal(down.orders[0].products[0].weightKg, 15, `舍位口径不对：${down.orders[0].products[0].weightKg}`);
}

/** 换算出的单箱重会被抹成 0（0.04÷13≈0.003）→ 报错回显原文和算式，不许静默存 0 */
{
  const r = parseStaffBatchRows([{ ...WH_ROW, 单项重量: 0.04 }]);
  assert.equal(r.orders.length, 0, "单箱重换算出 0 还放行了");
  const msg = r.issues.map((i) => i.message).join("；");
  assert.ok(
    msg.includes("0.04") && msg.includes("13"),
    `提示没带原文和算式：${msg}`,
  );
}

/** 只有「单项重量」列而这一格空着 → 必填提示要按这张表的叫法说，别提他表里没有的列 */
{
  const r = parseStaffBatchRows([{ ...WH_ROW, 单项重量: "" }]);
  assert.equal(r.orders.length, 0, "单项重量留空还建单了");
  assert.ok(
    r.issues.some((i) => i.message.includes("单项重量为必填")),
    `没按「单项重量」报必填：${JSON.stringify(r.issues.map((i) => i.message))}`,
  );
}

/** 「尺寸」认不出 → 报错回显原文；× 和 x 当分隔符也认；留空 = 不填长宽高，照样放行 */
{
  const bad = parseStaffBatchRows([{ ...WH_ROW, 尺寸: "42.5*38" }]);
  assert.equal(bad.orders.length, 0, "尺寸只有两个数还放行了");
  assert.ok(
    bad.issues.some((i) => i.message.includes("「42.5*38」")),
    `尺寸报错没回显原文：${JSON.stringify(bad.issues.map((i) => i.message))}`,
  );
  for (const sep of ["42.5×38×51.5", "42.5x38x51.5"]) {
    const r = parseStaffBatchRows([{ ...WH_ROW, 尺寸: sep }]);
    assert.deepEqual(r.issues, [], `尺寸「${sep}」被误伤：${JSON.stringify(r.issues.map((i) => i.message))}`);
    assert.equal(r.orders[0].products[0].widthCm, 38, `尺寸「${sep}」没拆对`);
  }
  const empty = parseStaffBatchRows([{ ...WH_ROW, 尺寸: "" }]);
  assert.deepEqual(empty.issues, [], "尺寸留空被拦了（长宽高本来就是选填）");
  assert.equal(empty.orders[0].volumeM3, undefined, "尺寸留空不该编出方数");
}

/** 「尺寸」和单独的长/宽/高同一行都填 → 报错让员工留一种，不悄悄选边 */
{
  const r = parseStaffBatchRows([{ ...WH_ROW, 长cm: 100, 宽cm: 50, 高cm: 20 }]);
  assert.equal(r.orders.length, 0, "尺寸和长宽高同时填还放行了");
  assert.ok(
    r.issues.some((i) => i.message.includes("只保留一种")),
    `没报「只保留一种写法」：${JSON.stringify(r.issues.map((i) => i.message))}`,
  );
}

/** 系统模板的「箱数」和仓库表的「件数」同时出现 → 按重复列报整表错误，不悄悄挑一个 */
{
  const r = parseStaffBatchRows([{ ...WH_ROW, 箱数: 99 }]);
  assert.equal(r.orders.length, 0, "箱数和件数两列并存还建单了");
  assert.ok(
    r.issues.some((i) => i.kind === "file" && i.message.includes("请只保留一列")),
    `没按重复列报错：${JSON.stringify(r.issues.map((i) => i.message))}`,
  );
}

/* ==========================================================================
   货型的共享函数 + 三端接入（2026-09-11 老板：「直接给我去修了」那三件）
   ========================================================================== */

/** 拼给列表/导出看的货型标签：多条产品行去重拼起来，老单退回运单自己的 */
{
  assert.equal(cargoTypeLabel(["normal", "normal"]), "普货");
  assert.equal(cargoTypeLabel(["normal", "inspection"]), "普货 / 商检货");
  assert.equal(cargoTypeLabel(["sensitive", "inspection", "sensitive"]), "敏感货 / 商检货", "没去重或顺序不稳");
  assert.equal(cargoTypeLabel([], "inspection"), "商检货", "没有产品行时要退回运单自己的货型");
  assert.equal(cargoTypeLabel([], null), "普货", "什么都没有时按普货");
  // 库里万一躺着脏值，按普货显示，别在导出里冒出第四种说法
  assert.equal(cargoTypeLabel(["商检"]), "普货", "脏值应该按普货显示");
  assert.equal(cargoTypeLabel([undefined, null]), "普货");
}

/** 最严那个：敏感 > 商检 > 普货 */
{
  assert.equal(strictestCargoType(["normal", "inspection", "sensitive"]), "sensitive");
  assert.equal(strictestCargoType(["normal", "inspection"]), "inspection");
  assert.equal(strictestCargoType(["normal"]), "normal");
  assert.equal(strictestCargoType([]), "normal");
}

/** parseCargoType：空=普货且标记没填；认不出来返回 null */
{
  assert.deepEqual(parseCargoType(""), { value: "normal", filled: false });
  assert.deepEqual(parseCargoType("  "), { value: "normal", filled: false });
  assert.deepEqual(parseCargoType("商检"), { value: "inspection", filled: true });
  assert.equal(parseCargoType("危险品"), null);
}

/** 客户端：预报单表单和客户导入模板都要有货型，而且不能再写死 normal */
{
  const clientPage = fs.readFileSync("apps/web/src/app/client/page.tsx", "utf8");
  assert.ok(!/cargoType: "normal" \}\)\)/.test(clientPage), "客户预报单提交还在写死 cargoType: \"normal\"");
  assert.ok(clientPage.includes("cargoType: p.cargoType || \"normal\""), "客户预报单没把每条产品行自己的货型发出去");
  assert.ok(/<select value=\{p\.cargoType/.test(clientPage), "客户端产品行里没有货型下拉");
  assert.ok(/<select value=\{form\.cargoType/.test(clientPage), "客户端没有整票货型下拉（没分产品行时用）");

  const clientImports = fs.readFileSync("apps/web/src/app/client/imports/page.tsx", "utf8");
  const header = /"(货型[^"]*)":\s*""/.exec(clientImports);
  assert.ok(header, "客户端批量下单模板里没有货型这一列");
  // 客户端导入那边的表头是**包含匹配**（findCol 用 k.includes），所以只要含「货型」就够
  assert.ok(header![1].includes("货型"), `客户端模板表头对不上：${header![1]}`);
  assert.ok(clientImports.includes('findCol(row, ["货型"])'), "客户端导入没读货型这一列，填了也白填");
  assert.ok(clientImports.includes("badCargoRows"), "客户端导入没拦住认不出来的货型");
}

/** 运单列表的 Excel 导出要有货型这一列（员工端 + 管理端） */
{
  for (const [label, file] of [["员工端", "apps/web/src/app/staff/page.tsx"], ["管理端", "apps/web/src/app/admin/page.tsx"]] as Array<[string, string]>) {
    const code = fs.readFileSync(file, "utf8");
    assert.ok(/货型: cargoTypeLabel\(/.test(code), `${label}运单列表导出没有货型这一列`);
  }
}

console.log("staff batch import parser: 100 orders / 300 rows passed");

checkInvalidClientIdMessage()
  .then(() => {
    console.log("staff batch import: 后端「无效唛头」中文提示 passed（真调路由，未连库）");
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
