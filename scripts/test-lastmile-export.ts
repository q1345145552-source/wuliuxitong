/**
 * 整柜拆柜派送清单导出的自测（不连数据库、不连网络、不写文件）。
 *
 * 为什么要有这个：2026-08-28 老板实测发现「多尺寸的单子，Excel 长宽高三格全是空白」，
 * 而单尺寸的能导出来 —— 这个模块**一个测试都没有**，所以没人发现。
 *
 * 根因链条（三环，缺一环这三列就是空的）：
 *   ① 后端 loading-manifests/routes.ts:397 给每票货的 products 恒定是空数组
 *      （柜内多是分柜子单，展开产品行会把件数重复算回整票）；
 *      —— 2026-10-07 起整张订单都在一票时会带产品行按产品展开，见第 20~24 项；
 *   ② 于是前端只能用**运单级**的长宽高，而后端把一票货里的多个尺寸合并成
 *      「60/50」这种字符串（orders/routes.ts:1657）；
 *   ③ 前端原来「只认数字」，字符串一律丢成 null → 三格空白。
 *
 * 这个脚本只测第 ③ 环（前端这一层是纯计算，测得动）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
// ⚠️ jszip 只装在 apps/web 下（前端依赖），根目录没有 —— 必须走相对路径引，
// 否则脚本从仓库根目录跑起来会 MODULE_NOT_FOUND。
import JSZip from "../apps/web/node_modules/jszip";
import {
  buildLastmileTemplateWorkbook,
  expandTemplateLines,
  type LastmileExportData,
} from "../apps/web/src/modules/lastmile/exportDispatchWorkbooks";

const failures: string[] = [];
function check(name: string, body: () => void): void {
  try {
    body();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(name);
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${message.split("\n").join("\n     ")}`);
  }
}

/** 造一份跟后端 /loading-manifests 返回结构一致的数据（products 为空 = 货拆在几个柜、不展开产品行的那种） */
function buildData(dims: {
  lengthCm: number | string | null;
  widthCm: number | string | null;
  heightCm: number | string | null;
}): LastmileExportData {
  return {
    // ⚠️ scope 必须是 "container"：buildLastmileTemplateWorkbook 靠它决定走整柜模板
    // 还是客户签收模板，不设的话会去客户模板那条路，报「缺少中文或泰文工作表」
    scope: "container",
    containerNo: "CN2026001",
    origin: "义乌",
    destination: "曼谷",
    carrierInfo: "",
    customers: [
      {
        clientId: "TESTCLIENT",
        // 导出类型里已经没有客户名字这一项了（2026-09-19 删掉），这里故意塞一个：
        // 万一后端哪天又把名字发过来，第 18 项要证明生成器也不会把它印到纸上
        clientName: "测试客户",
        contactName: "张三",
        contactPhone: "0800000000",
        address: "曼谷某路 1 号",
        shipments: [
          {
            lastmileOrderId: "lm_1",
            trackingNo: "SZ260801388",
            parentTrackingNo: "",
            itemName: "耳机",
            packageCount: 7,
            packageUnit: "箱",
            weightKg: 88,
            volumeM3: 1.928,
            ...dims,
            remark: "",
            status: "loaded",
            containerNos: ["CN2026001"],
            receiverName: "李四",
            receiverPhone: "0811111111",
            receiverAddress: "曼谷某路 2 号",
            // 不展开产品行时后端给的就是空数组（整张订单的货全在这一票时才会带产品行，见第 20 项起）
            products: [],
          },
        ],
      },
    ],
  } as unknown as LastmileExportData;
}

/** 异步版的 check：真模板那几项要解压 zip */
async function checkAsync(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(name);
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${message.split("\n").join("\n     ")}`);
  }
}

console.log("整柜拆柜派送清单导出");

check("1) 单一尺寸：长宽高照常带出来（这条本来就是好的，防改坏）", () => {
  const [line] = expandTemplateLines(buildData({ lengthCm: 60, widthCm: 40, heightCm: 30 }));
  assert.ok(line, "没生成明细行");
  assert.equal(line.lengthCm, 60, "长不对");
  assert.equal(line.widthCm, 40, "宽不对");
  assert.equal(line.heightCm, 30, "高不对");
});

check("2) 多尺寸「60/50」：不许再变成空白", () => {
  // 三个方向都用互不相同的值，串了一眼就看得出来
  const [line] = expandTemplateLines(
    buildData({ lengthCm: "60/50", widthCm: "40/35", heightCm: "30/25" }),
  );
  assert.ok(line, "没生成明细行");
  assert.equal(line.lengthCm, "60/50", `长被丢掉了（拿到 ${JSON.stringify(line.lengthCm)}）`);
  assert.equal(line.widthCm, "40/35", `宽被丢掉了（拿到 ${JSON.stringify(line.widthCm)}）`);
  assert.equal(line.heightCm, "30/25", `高被丢掉了（拿到 ${JSON.stringify(line.heightCm)}）`);
});

check("3) 多尺寸时方数仍按后端给的实际装柜体积，不拿字符串去算", () => {
  // 「60/50」拿去做乘法会得到 NaN，印在客户签收单上就是一个假数
  const [line] = expandTemplateLines(
    buildData({ lengthCm: "60/50", widthCm: "40/35", heightCm: "30/25" }),
  );
  assert.equal(line.volumeM3, 1.928, `方数不对（拿到 ${line.volumeM3}）`);
  assert.ok(!Number.isNaN(Number(line.volumeM3)), "方数算成了 NaN");
  assert.equal(line.weightKg, 88, `重量不对（拿到 ${line.weightKg}）`);
});

check("4) 没填尺寸时仍然留空，不许印成 0", () => {
  const [line] = expandTemplateLines(buildData({ lengthCm: null, widthCm: null, heightCm: null }));
  assert.equal(line.lengthCm, null, "空尺寸被填成了别的值");
  assert.equal(line.widthCm, null, "空尺寸被填成了别的值");
  assert.equal(line.heightCm, null, "空尺寸被填成了别的值");
});

check("5) 空字符串按「没填」处理，不许写成一个空格子里的空串", () => {
  const [line] = expandTemplateLines(buildData({ lengthCm: "  ", widthCm: "", heightCm: null }));
  assert.equal(line.lengthCm, null, "只有空格的尺寸没当成没填");
  assert.equal(line.widthCm, null, "空串没当成没填");
});


// ══════════════════════════════════════════════════════════════════════
// 下面这几项走**完整链路**：真模板 xlsx → buildLastmileTemplateWorkbook → 解压读 XML。
//
// ⚠️ 上一版是自己造一张最小工作表 XML 喂给内部函数。复核实测证明那样**太干净**：
// 把「写值时保留样式属性」删掉，9 项照样全绿 —— 因为我造的格子本来就没样式。
// 而且那样测不到模板自带的东西（比如 G35/H35/I35 那三个 SUM），
// 正是那三个 SUM 让导出文件里印出了三个 0。
// 现在直接用 apps/web/public/templates 里的真文件，不再为测试导出内部类。
// ══════════════════════════════════════════════════════════════════════

const TEMPLATE = path.join(
  __dirname,
  "..",
  "apps",
  "web",
  "public",
  "templates",
  "lastmile",
  "internal-dispatch-template.xlsx",
);

async function renderRealWorkbook(dims: {
  lengthCm: number | string | null;
  widthCm: number | string | null;
  heightCm: number | string | null;
}): Promise<{ sheet: string; shared: string }> {
  const bytes = await buildLastmileTemplateWorkbook(buildData(dims), fs.readFileSync(TEMPLATE));
  const zip = await JSZip.loadAsync(bytes);
  const sheetName = Object.keys(zip.files).find((n) => /^xl\/worksheets\/sheet1\.xml$/.test(n));
  assert.ok(sheetName, `解压后找不到工作表：${Object.keys(zip.files).join(", ")}`);
  const sheet = await zip.file(sheetName)!.async("string");
  const sharedFile = zip.file("xl/sharedStrings.xml");
  const shared = sharedFile ? await sharedFile.async("string") : "";
  return { sheet, shared };
}

/** 把某个格子的 XML 抠出来（非贪婪，否则会一口气吃到下一个 </c>） */
function cellXml(xml: string, ref: string): string {
  const m = xml.match(new RegExp(`<c\\b[^>]*?\\br="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`));
  assert.ok(m, `找不到单元格 ${ref}`);
  return m[0];
}

/** 按共享字符串下标把文字捞出来，确认客户在 Excel 里看到的就是这个 */
function sharedText(shared: string, index: number): string {
  const items = [...shared.matchAll(/<si>\s*<t[^>]*>([\s\S]*?)<\/t>\s*<\/si>/g)].map((m) => m[1]);
  return items[index] ?? "";
}


// ══════════════════════════════════════════════════════════════════════
// 第 20~24 项：按产品展开（2026-10-07，老板：整柜派送清单「没有分详细」）
//   分柜子单只要「整张订单的货全在这一票」，后端就带上产品行 + productLinesKeepTotals，
//   Excel 里一个产品一行。方数/重量只分摊、不重算 —— 加起来必须还是本票的合计。
//   数字取自 TRHU4325852 柜的 YW0001585：镀膜剂 50 箱 + 喷头 4 箱，2.334 方、1140 kg。
// ══════════════════════════════════════════════════════════════════════

function buildSplitWholeData(
  over: Record<string, unknown> = {},
  products?: Array<Record<string, unknown>>,
): LastmileExportData {
  const data = buildData({ lengthCm: "51.5/56.5", widthCm: "34/43", heightCm: "22.5/37.5" }) as any;
  Object.assign(data.customers[0].shipments[0], {
    trackingNo: "YW0001585-1",
    parentTrackingNo: "YW0001585",
    itemName: "镀膜剂 / 喷头",
    packageCount: 54,
    volumeM3: 2.334,
    weightKg: 1140,
    products: products ?? [
      { itemName: "镀膜剂", packageCount: 50, lengthCm: 51.5, widthCm: 34, heightCm: 22.5, weightKg: 22 },
      { itemName: "喷头", packageCount: 4, lengthCm: 56.5, widthCm: 43, heightCm: 37.5, weightKg: 10 },
    ],
    productLinesKeepTotals: true,
    ...over,
  });
  return data as LastmileExportData;
}
/** 按 3 位小数比合计（方数在库里就是 3 位），避免 0.1+0.2 这种浮点尾巴 */
const total3 = (values: Array<number | null>): number => Math.round(values.reduce<number>((sum, v) => sum + (v ?? 0), 0) * 1000) / 1000;

check("20) 整票在一柜的分柜单：一个产品一行，件数/长宽高是产品自己的，方数/重量合计一分不差", () => {
  const lines = expandTemplateLines(buildSplitWholeData());
  assert.deepEqual(lines.map((l) => l.itemName), ["镀膜剂", "喷头"]);
  assert.deepEqual(lines.map((l) => l.packageCount), [50, 4]);
  assert.deepEqual(lines.map((l) => [l.lengthCm, l.widthCm, l.heightCm]), [[51.5, 34, 22.5], [56.5, 43, 37.5]], "长宽高要按产品配好对，不能再是「51.5/56.5」");
  assert.deepEqual(lines.map((l) => l.trackingNo), ["YW0001585-1", "YW0001585-1"]);
  // 方数按各产品「件数×长×宽×高」占比分：镀膜剂 1.969875、喷头 0.364425 → 分 2.334
  assert.deepEqual(lines.map((l) => l.volumeM3), [1.97, 0.364]);
  assert.equal(total3(lines.map((l) => l.volumeM3)), 2.334, "方数合计变了（应是本票的实际装柜体积）");
  // 重量按「件数×单件重」占比分：1100 : 40
  assert.deepEqual(lines.map((l) => l.weightKg), [1100, 40]);
  assert.equal(total3(lines.map((l) => l.weightKg)), 1140, "重量合计变了");
});

check("21) 有产品缺尺寸 / 缺单件重：整票退回按件数分，合计照样不差（除不尽的也不多不少）", () => {
  const lines = expandTemplateLines(buildSplitWholeData({ packageCount: 10, volumeM3: 1.001, weightKg: 10 }, [
    { itemName: "A", packageCount: 3, lengthCm: 40, widthCm: 30, heightCm: 20, weightKg: 1 },
    { itemName: "B", packageCount: 3, lengthCm: null, widthCm: 30, heightCm: 20, weightKg: null },
    { itemName: "C", packageCount: 4, lengthCm: 40, widthCm: 30, heightCm: 20, weightKg: 1 },
  ]));
  // 按件数 3:3:4 分 1.001 → 0.3 / 0.301 / 0.4（累计取整，最后一行不吃全部零头）
  assert.deepEqual(lines.map((l) => l.volumeM3), [0.3, 0.301, 0.4]);
  assert.equal(total3(lines.map((l) => l.volumeM3)), 1.001);
  assert.deepEqual(lines.map((l) => l.weightKg), [3, 3, 4]);
  assert.equal(lines[1].lengthCm, null, "没填的长就是空，不编");
});

check("22) 本票方数/重量本来就没填：展开后每行也留空，不许印成 0", () => {
  const lines = expandTemplateLines(buildSplitWholeData({ volumeM3: null, weightKg: null }));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => l.volumeM3), [null, null]);
  assert.deepEqual(lines.map((l) => l.weightKg), [null, null]);
});

check("23) 不带标记的产品行（没分过柜的整票）照旧按产品行自己算 —— 老路不许被改", () => {
  const lines = expandTemplateLines(buildSplitWholeData({ productLinesKeepTotals: undefined }));
  assert.deepEqual(lines.map((l) => l.volumeM3), [1.969875, 0.364425], "老路的方数是按尺寸重算的");
  assert.deepEqual(lines.map((l) => l.weightKg), [1100, 40]);
});

// ══════════════════════════════════════════════════════════════════════
// 第 10~13 项：复核独立变异实测出来的两块**没有任何测试**的地方
//   · 超过 25 行会走「克隆工作表」那条路 —— 破坏它，9 项全绿
//   · 客户签收模板（中英泰那张）整条路 —— 破坏它，9 项全绿
// ══════════════════════════════════════════════════════════════════════

const CUSTOMER_TEMPLATE = path.join(
  __dirname, "..", "apps", "web", "public", "templates", "lastmile", "customer-receipt-template.xlsx",
);

/**
 * ⚠️ 客户签收模板的 XML 带 `x:` 前缀（`<x:c r="B6">`），整柜模板不带。
 * 生产代码用 xmlPrefix() 处理了这个差异，测试的正则也必须一起兼容 ——
 * 写这两项时我第一版没加，抠出来全是「找不到单元格」，差点当成 bug 报出去。
 */
function cellXmlAnyNs(xml: string, ref: string): string {
  const m = xml.match(
    new RegExp(`<(?:\\w+:)?c\\b[^>]*?\\br="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</(?:\\w+:)?c>)`),
  );
  assert.ok(m, `找不到单元格 ${ref}`);
  return m[0];
}

/**
 * ⚠️ 必须把**每一个** `<si>` 都数上，哪怕它里面是富文本（多个 `<r><t>`）或者是空的。
 * 第一版写成「<si> 后面紧跟 <t>」的整块匹配，富文本那几条被跳过 → 下标整体错位，
 * 抠出来的是别的格子的文字（实测：想读运单号，读到的是地址）。
 * 下标错位是最阴的一种假绿：断言看起来在比对，比的却是另一格。
 */
function sharedTextAnyNs(shared: string, index: number): string {
  const blocks = [...shared.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) => m[1]);
  const block = blocks[index];
  if (block === undefined) return "";
  // 富文本会被拆成多段 <t>，拼起来才是客户看到的整句
  return [...block.matchAll(/<(?:\w+:)?t[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => m[1]).join("");
}

/** 从某个格子里读出「客户在 Excel 里看到的东西」——数字格读数，文本格查共享串 */
function cellValue(sheet: string, shared: string, ref: string): string {
  const cell = cellXmlAnyNs(sheet, ref);
  const v = cell.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1];
  if (v === undefined) return "";
  return /t="s"/.test(cell) ? sharedTextAnyNs(shared, Number(v)) : v;
}

/**
 * 造 n 票货。
 * ⚠️ 每一票的件数、方数、重量都**互不相同**（件数 = i+1，方数/重量按下标递增）——
 * 拿相同的数造数据，序号错位、页与页串行、合计漏加这些毛病一个都测不出来。
 */
function buildDataWithLines(n: number, over: Partial<Record<string, unknown>> = {}): LastmileExportData {
  const data = buildData({ lengthCm: 60, widthCm: 40, heightCm: 30 }) as any;
  const proto = data.customers[0].shipments[0];
  data.customers[0].shipments = Array.from({ length: n }, (_, i) => ({
    ...proto,
    lastmileOrderId: `lm_${i + 1}`,
    trackingNo: `SZ${String(i + 1).padStart(9, "0")}`,
    itemName: `货品${i + 1}`,
    packageCount: i + 1,
    volumeM3: Number((0.1 * (i + 1)).toFixed(3)),
    weightKg: 10 * (i + 1),
  }));
  Object.assign(data, over);
  return data as LastmileExportData;
}

/** 工作表里全部合并区域（A1:B2 这种），按出现顺序 */
function mergeRefs(sheet: string): string[] {
  return [...sheet.matchAll(/<(?:\w+:)?mergeCell\b[^>]*\bref="([^"]+)"/g)].map((m) => m[1]);
}

/** 任意两个合并区域不许重叠（重叠 = Excel 打开报文件损坏） */
function assertNoOverlap(refs: string[]): void {
  const col = (s: string) => s.split("").reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
  const boxes = refs.map((ref) => {
    const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref);
    assert.ok(m, `认不出合并区域 ${ref}`);
    return { ref, c1: col(m![1]), r1: Number(m![2]), c2: col(m![3]), r2: Number(m![4]) };
  });
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i], b = boxes[j];
      assert.ok(!(a.c1 <= b.c2 && b.c1 <= a.c2 && a.r1 <= b.r2 && b.r1 <= a.r2), `合并区域重叠：${a.ref} 和 ${b.ref}`);
    }
  }
}

/** 第 style 号单元格样式指向的 <border> 原文（读 styles.xml 的 cellXfs → borderId → borders） */
function borderXmlOf(stylesXml: string, style: number): string {
  // 客户签收单模板的样式表带 x: 前缀（<x:xf>），整柜的不带，两种都要认
  const xfs = [...(/<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(stylesXml)?.[1] ?? "").matchAll(/<(?:\w+:)?xf\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?xf>)/g)].map((m) => m[0]);
  const borders = [...(/<(?:\w+:)?borders\b[^>]*>([\s\S]*?)<\/(?:\w+:)?borders>/.exec(stylesXml)?.[1] ?? "").matchAll(/<(?:\w+:)?border\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?border>)/g)].map((m) => m[0]);
  assert.ok(xfs[style], `样式表里没有第 ${style} 号样式`);
  const border = borders[Number(/\bborderId="(\d+)"/.exec(xfs[style])?.[1] ?? 0)];
  assert.ok(border, `第 ${style} 号样式指向的边框不存在`);
  return border;
}

/** 某一条边的原文（含线型、颜色），没写这条边返回空串 —— 比外圈边框要连线型颜色一起比 */
function borderEdgeXml(stylesXml: string, style: number, edge: "top" | "bottom" | "left" | "right"): string {
  return new RegExp(`<(?:\\w+:)?${edge}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/(?:\\w+:)?${edge}>)`).exec(borderXmlOf(stylesXml, style))?.[0] ?? "";
}

/** 第 style 号单元格样式的四条边有没有画线 */
function cellBorder(stylesXml: string, style: number): { top: boolean; bottom: boolean; left: boolean; right: boolean } {
  const border = borderXmlOf(stylesXml, style);
  const has = (edge: string) => new RegExp(`<(?:\\w+:)?${edge}\\b[^>]*\\bstyle="[^"]+"`).test(border);
  return { top: has("top"), bottom: has("bottom"), left: has("left"), right: has("right") };
}

/** 取某一行的行高（没写 ht 就返回 null） */
function rowHeight(sheet: string, row: number): number | null {
  const rowTag = new RegExp(`<(?:\\w+:)?row\\b[^>]*\\br="${row}"[^>]*>`).exec(sheet);
  if (!rowTag) return null;
  const ht = /\bht="([\d.]+)"/.exec(rowTag[0]);
  return ht ? Number(ht[1]) : null;
}

/**
 * 生产上真实存在的最长品名（14 个产品、116 个字，WD000254 / SZ260702562-1）。
 * 老板 2026-09-11 第三次报「导出的单品类不全」就是这一类 —— 格子里字是全的，
 * 行高写死导致纸上只看得到前两个名字。
 */
const LONG_NAME = "排气管防摔棒 / 160线束夹支架 / 改装手把胶套 / 气门芯盖 / 龙头压码 / 机油滤芯盖放油螺丝 / 车把堵头 / 后备箱储物盒 / 后备箱垫 / 多功能前挂钩+带钩 / 车把挂钩 / 电门锁盖 / 后备箱隔物板 / 包装袋";
const MEDIUM_NAME = "前仓垫 / 反光牌 / 夜间警示灯 / 屏幕膜 / 方向套盘 / 电门锁盖 / 车把组合 / 防摔棒 / 隔音棉";

/** 三票货：一个超长品名、一个中等、一个短的（短的用来盯「没事别改行高」） */
function buildMixedNameData(scope: "customer" | "container"): LastmileExportData {
  const data = buildDataWithLines(3, { scope }) as any;
  data.customers[0].shipments[0].itemName = LONG_NAME;
  data.customers[0].shipments[1].itemName = MEDIUM_NAME;
  data.customers[0].shipments[2].itemName = "导板 / 电链锯条";
  return data as LastmileExportData;
}

async function renderZip(data: LastmileExportData, templatePath: string) {
  const bytes = await buildLastmileTemplateWorkbook(data, fs.readFileSync(templatePath));
  const zip = await JSZip.loadAsync(bytes);
  const sheetOf = async (name: string): Promise<string> => {
    const f = zip.file(`xl/worksheets/${name}.xml`);
    assert.ok(f, `解压后找不到 ${name}.xml，工作表只有：${Object.keys(zip.files).join(", ")}`);
    return f!.async("string");
  };
  const workbook = await zip.file("xl/workbook.xml")!.async("string");
  const sharedFile = zip.file("xl/sharedStrings.xml");
  const shared = sharedFile ? await sharedFile.async("string") : "";
  const sheetNames = [...workbook.matchAll(/<(?:\w+:)?sheet[^>]*\bname="([^"]*)"/g)].map((m) => m[1]);
  const sheetFiles = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  return { zip, sheetOf, shared, sheetNames, sheetFiles };
}

async function main(): Promise<void> {
  await checkAsync("6) 真模板：单一尺寸写成**数字格**，值就是那个数", async () => {
    const { sheet } = await renderRealWorkbook({ lengthCm: 60, widthCm: 40, heightCm: 30 });
    for (const [ref, val] of [["G10", "60"], ["H10", "40"], ["I10", "30"]] as Array<[string, string]>) {
      const cell = cellXml(sheet, ref);
      assert.ok(!/t="s"/.test(cell), `${ref} 被写成了文本格：${cell}`);
      assert.ok(cell.includes(`<v>${val}</v>`), `${ref} 的值不对：${cell}`);
    }
  });

  await checkAsync("7) 真模板：多尺寸写成**文本格**，Excel 里真能读出「60/50」", async () => {
    const { sheet, shared } = await renderRealWorkbook({
      lengthCm: "60/50",
      widthCm: "40/35",
      heightCm: "30/25",
    });
    for (const [ref, text] of [["G10", "60/50"], ["H10", "40/35"], ["I10", "30/25"]] as Array<[string, string]>) {
      const cell = cellXml(sheet, ref);
      assert.ok(/t="s"/.test(cell), `${ref} 不是文本格，字符串塞进数字格会被写成 0：${cell}`);
      const idx = cell.match(/<v>(\d+)<\/v>/)?.[1];
      assert.ok(idx !== undefined, `${ref} 没有共享字符串下标：${cell}`);
      assert.equal(sharedText(shared, Number(idx)), text, `${ref} 在 Excel 里显示的不是「${text}」`);
    }
  });

  await checkAsync("8) 真模板：写值时**保留原有样式**（上一版的假绿就出在这）", async () => {
    // 复核变异：把写值时的样式属性删掉，旧测试照样全绿 —— 因为自造的 fixture 本来就没样式。
    // 真模板的格子是带 s="..." 的，这一项能抓住。
    const { sheet } = await renderRealWorkbook({ lengthCm: 60, widthCm: 40, heightCm: 30 });
    const styled = ["G10", "H10", "I10", "B10", "D10"].filter((ref) => /\bs="\d+"/.test(cellXml(sheet, ref)));
    assert.ok(
      styled.length > 0,
      "写完值之后一个带样式的格子都没有了 —— 样式属性被写值那一步吃掉了，导出文件会掉格式",
    );
  });

  await checkAsync("9) 真模板：长宽高那三个合计格必须被清掉，不能留 SUM", async () => {
    /**
     * 模板自带 G35=SUM(G10:G34) / H35 / I35。多尺寸时长宽高是文本，
     * SUM 对文本求和就是 0 —— 客户签收单上印出三个 0，是实打实的错数。
     * 而且就算全是数字，把各行的长加起来（60+50=110cm）也是个没意义的数。
     */
    const { sheet } = await renderRealWorkbook({ lengthCm: "60/50", widthCm: "40/35", heightCm: "30/25" });
    for (const ref of ["G35", "H35", "I35"]) {
      const cell = cellXml(sheet, ref);
      assert.ok(!/<f>/.test(cell), `${ref} 还留着合计公式：${cell}`);
      assert.ok(!/<v>/.test(cell), `${ref} 还留着一个值：${cell}`);
    }
    // 件数/方数/重量的合计**必须还在**，别把该有的也清了
    assert.ok(cellXml(sheet, "E35").includes("SUM(E10:E34)"), "方数合计公式丢了");
    assert.ok(cellXml(sheet, "F35").includes("SUM(F10:F34)"), "重量合计公式丢了");
    assert.ok(cellXml(sheet, "E35").includes("<v>1.928</v>"), "方数合计被尺寸重算改掉了");
  });

  await checkAsync("10) 超过 25 行：会克隆出第二张工作表，序号接着排、一票不丢", async () => {
    /**
     * 复核独立变异实测：把「超过 25 行分页」那条路破坏掉，**9 项照样全绿** ——
     * 之前所有用例都只有 1 票货，一次都没走到克隆那条路上。
     * 整柜模板一页只有 25 个明细行（第 10~34 行），第 26 票起必须开新页。
     */
    const { sheetOf, shared, sheetNames, sheetFiles } = await renderZip(
      buildDataWithLines(26), TEMPLATE,
    );

    assert.equal(sheetFiles.length, 2, `26 票货应该分成 2 张工作表，实际 ${sheetFiles.length} 张`);
    assert.equal(sheetNames.length, 2, `workbook.xml 里应该登记 2 张表，实际：${sheetNames.join(" | ")}`);
    assert.ok(
      sheetNames[1].endsWith("-2"),
      `第二张表名没带页码后缀，Excel 里会看不出这是第 2 页：${sheetNames[1]}`,
    );

    const page1 = await sheetOf("sheet1");
    const page2 = await sheetOf("sheet2");

    /**
     * ⚠️ 2026-08-29 起 A 列放的是**唛头**、不再是序号（老板要求，见第 14 项）。
     * 所以「分页有没有接着排」改由 B 列运单号来保证 —— 它本来就在这测，
     * 而且比序号更硬：序号是代码自己生成的，运单号是真数据。
     */
    assert.equal(cellValue(page1, shared, "A10"), "TESTCLIENT", "第一页第一行 A 列不是唛头");
    assert.equal(cellValue(page1, shared, "A34"), "TESTCLIENT", "第一页最后一行 A 列不是唛头");
    assert.equal(cellValue(page1, shared, "B10"), "SZ000000001", "第一页第一票运单号不对");
    assert.equal(cellValue(page1, shared, "B34"), "SZ000000025", "第一页最后一票运单号不对");

    // 第二页：必须**接着**排，不能从第 1 票重新开始
    assert.equal(cellValue(page2, shared, "A10"), "TESTCLIENT", "第二页第一行 A 列不是唛头");
    assert.equal(cellValue(page2, shared, "B10"), "SZ000000026", "第 26 票没落到第二页第一行");

    // 第二页多余的行必须是空的，不能残留模板里的样板数据
    assert.ok(
      !/<(?:\w+:)?v>/.test(cellXmlAnyNs(page2, "A11")),
      `第二页第 11 行还留着值，会被当成一票不存在的货：${cellXmlAnyNs(page2, "A11")}`,
    );
  });

  await checkAsync("14) A 列放唛头（表头也要改）、备注格只放真备注", async () => {
    /**
     * 老板 2026-08-29 反馈：「唛头应该是放在序列号那个位置。备注也是有真实的备注信息的。」
     *
     * 原来：A 列写 1、2、3… 序号；N 列写 `唛头：XHH6651；<备注>`。
     * 于是备注这一列常年只看得到「唛头：XHH6651」，
     * 司机真正要看的「周一不收货」这种交代被挤在后面。
     *
     * 现在：A 列 = 唛头（表头 A9 也从「序列号」改成「唛头」），N 列 = 只放真备注。
     */
    const data = buildDataWithLines(2) as any;
    data.customers[0].shipments[0].remark = "周一不收货";
    data.customers[0].shipments[1].remark = "";
    const { sheetOf, shared } = await renderZip(data, TEMPLATE);
    const page = await sheetOf("sheet1");

    assert.equal(cellValue(page, shared, "A9"), "唛头", "表头还写着「序列号」，列名和内容对不上");
    assert.equal(cellValue(page, shared, "A10"), "TESTCLIENT", "A 列没放唛头");
    assert.equal(cellValue(page, shared, "A11"), "TESTCLIENT", "第二行 A 列没放唛头");

    assert.equal(
      cellValue(page, shared, "N10"),
      "周一不收货",
      "备注格不是纯备注 —— 唛头又被拼进去了，司机得从一串系统信息里找交代",
    );
    assert.equal(cellValue(page, shared, "N11"), "", "没有备注的那行不该凭空多出内容");
  });

  await checkAsync("11) 正好 25 行时不许多开一页（边界）", async () => {
    // ⚠️ 只测 26 会漏掉「25 也开了第二页」这种错法：客户会拿到一张全空的第 2 页
    const { sheetFiles } = await renderZip(buildDataWithLines(25), TEMPLATE);
    assert.equal(sheetFiles.length, 1, `25 票货应该只有 1 张工作表，实际 ${sheetFiles.length} 张`);
  });

  await checkAsync("12) 客户签收模板：中文页的明细、序号和三个合计都要对", async () => {
    /**
     * 复核独立变异实测：把客户签收模板那条路破坏掉，**9 项照样全绿** ——
     * 前 9 项走的全是整柜模板（scope: "container"），客户这张一次都没跑过。
     * 这张是**给客户签字的纸质单据**，印错了是拿着错单去要签名。
     */
    const data = buildDataWithLines(3, {
      scope: "customer",
      deliveryDate: "2026-08-29",
      driverName: "王五",
      phoneNumber: "0899999999",
    });
    const { sheetOf, shared } = await renderZip(data, CUSTOMER_TEMPLATE);
    const cn = await sheetOf("sheet1");

    // 三票货的件数是 1 / 2 / 3，方数 0.1 / 0.2 / 0.3，重量 10 / 20 / 30 —— 互不相同
    assert.equal(cellValue(cn, shared, "B6"), "1", "第 1 行序号不对");
    assert.equal(cellValue(cn, shared, "B8"), "3", "第 3 行序号不对");
    assert.equal(cellValue(cn, shared, "C6"), "SZ000000001", "第 1 行运单号不对");
    assert.equal(cellValue(cn, shared, "D6"), "货品1", "第 1 行品名不对");
    assert.equal(cellValue(cn, shared, "E6"), "1", "第 1 行件数不对");
    assert.equal(cellValue(cn, shared, "E8"), "3", "第 3 行件数不对");

    // 合计：件数 1+2+3=6，方数 0.1+0.2+0.3=0.6，重量 10+20+30=60
    assert.equal(cellValue(cn, shared, "E16"), "6", "件数合计不对");
    assert.equal(cellValue(cn, shared, "F16"), "0.6", "方数合计不对");
    assert.equal(cellValue(cn, shared, "G16"), "60", "重量合计不对");
    for (const ref of ["E16", "F16", "G16"]) {
      assert.ok(
        /<(?:\w+:)?f>SUM\(/.test(cellXmlAnyNs(cn, ref)),
        `${ref} 的 SUM 公式没了，客户在 Excel 里改一行数字合计就不会跟着变`,
      );
    }

    // 司机和日期印在单子上（客户是照着这个联系人的）
    assert.equal(cellValue(cn, shared, "G18"), "2026-08-29", "派送日期没印上");
    assert.ok(cellValue(cn, shared, "G19").includes("王五"), "司机信息没印上");
  });

  await checkAsync("13) 客户签收模板：泰文页要清掉预置的 1..20 序号", async () => {
    /**
     * 泰文模板 A8:A27 预置了 1..20。只填 3 票货时，剩下 17 行如果不清，
     * 客户手上那张纸就有 20 个序号、只有 3 行有内容 ——
     * 看起来像「还有 17 件货没写上」。生产代码有这段清理（clearRange），
     * 但一直没有测试守着。
     */
    const data = buildDataWithLines(3, {
      scope: "customer",
      deliveryDate: "2026-08-29",
      driverName: "王五",
      phoneNumber: "0899999999",
    });
    const { sheetOf, shared } = await renderZip(data, CUSTOMER_TEMPLATE);
    const th = await sheetOf("sheet2");

    // 有货的那三行要有内容
    assert.notEqual(cellValue(th, shared, "A8"), "", "泰文页第 1 行是空的");
    // 第 4 行往后（A11 起）必须全空 —— 预置序号被清掉了
    for (const ref of ["A11", "A15", "A27"]) {
      assert.equal(
        cellValue(th, shared, ref),
        "",
        `泰文页 ${ref} 还留着预置序号，客户会以为还有没写上的货`,
      );
    }
  });

  await checkAsync("18) 客户签收单上只印唛头、不印客户名字（这张要交给收货人签字）", async () => {
    /**
     * 2026-09-18 老板：「唛头=账号，客户名字是只有我们内部看的」。
     * 泰文页「ลูกค้า（客户）」那一列原来印的是客户名字（「杨先」这种），
     * 而这张签收单是交给收货人签字的 —— 名字不能出现在往外给的纸上，改印唛头。
     * 夹具里客户名字叫「测试客户」、唛头叫 TESTCLIENT：两页里都不许出现「测试客户」。
     * 「收货人」那格退到客户名字的那条路在后端（已删，test-mark-display 第 10 项盯着），见下面第 19 项。
     */
    const data = buildDataWithLines(2, {
      scope: "customer",
      deliveryDate: "2026-09-18",
      driverName: "王五",
      phoneNumber: "0899999999",
    });
    const { sheetOf, shared } = await renderZip(data, CUSTOMER_TEMPLATE);
    const cn = await sheetOf("sheet1");
    const th = await sheetOf("sheet2");
    assert.equal(cellValue(th, shared, "B8"), "TESTCLIENT", "泰文页「客户」那列没印唛头");
    assert.equal(cellValue(th, shared, "C8"), "TESTCLIENT", "泰文页「唛头」那列被改坏了");
    assert.equal(cellValue(cn, shared, "A6"), "TESTCLIENT", "中文页「唛头」那格被改坏了");
    for (const [page, xml] of [["中文页", cn], ["泰文页", th]] as Array<[string, string]>) {
      for (const ref of ["A6", "B8", "C8", "B9", "C9", "C3"]) {
        assert.notEqual(cellValue(xml, shared, ref), "测试客户", `${page} ${ref} 印了客户名字`);
      }
    }
    assert.ok(!shared.includes("测试客户"), "整张签收单的文字里还有客户名字");
  });

  await checkAsync("19) 客户签收单：泰国收货人和地址簿联系人都没填时，「收货人」那格留空（不印唛头、不印名字）", async () => {
    /**
     * 2026-09-19：后端原来在这种情况下退到客户名字（线上 1651 张订单全都没填泰国收货人，265 张会印出名字）。
     * 现在后端给的收货人就是空的，这一格留给收货人现场写。
     * 这里按后端真实会给的样子造数据：每票的 receiverName 和客户的 contactName 都是空串。
     */
    const data = buildDataWithLines(2, { scope: "customer", deliveryDate: "2026-09-19" }) as any;
    data.customers[0].contactName = "";
    for (const s of data.customers[0].shipments) s.receiverName = "";
    const { sheetOf, shared } = await renderZip(data as LastmileExportData, CUSTOMER_TEMPLATE);
    const th = await sheetOf("sheet2");
    assert.equal(cellValue(th, shared, "E31"), "", `泰文页「收货人」没留空，印的是「${cellValue(th, shared, "E31")}」`);
    assert.ok(!shared.includes("测试客户"), "签收单上出现了客户名字");
    assert.ok(!/undefined|null/.test(shared), "签收单上印出了 undefined / null");

    // 反过来：填了泰国收货人就照印，别把正常情况也改成空
    const filled = buildDataWithLines(1, { scope: "customer", deliveryDate: "2026-09-19" }) as any;
    filled.customers[0].contactName = "";
    filled.customers[0].shipments[0].receiverName = "李四";
    const r2 = await renderZip(filled as LastmileExportData, CUSTOMER_TEMPLATE);
    assert.equal(cellValue(await r2.sheetOf("sheet2"), r2.shared, "E31"), "李四", "填了泰国收货人却没印出来");
  });

  await checkAsync("15) 客户签收单：长品名把行高撑开到放得下，短品名行高一个像素不动", async () => {
    const { sheetOf, shared } = await renderZip(buildMixedNameData("customer"), CUSTOMER_TEMPLATE);
    const cn = await sheetOf("sheet1");
    const th = await sheetOf("sheet2");

    // 字必须是全的（这是 2026-09-10 修好的部分，防改坏）
    assert.equal(cellValue(cn, shared, "D6"), LONG_NAME, "中文页第 1 行品名被截断了");
    assert.equal(cellValue(th, shared, "D8"), LONG_NAME, "泰文页第 1 行品名被截断了");

    // 中文页：D 列宽 16.29、模板原行高 35（约 2.6 行）；116 字要 13 行，必须撑开
    const cnLong = rowHeight(cn, 6);
    assert.ok(cnLong != null && cnLong >= 13 * 13.5, `中文页长品名那行没撑开（行高 ${cnLong}，至少要 ${13 * 13.5}）`);
    const cnMedium = rowHeight(cn, 7);
    assert.ok(cnMedium != null && cnMedium >= 6 * 13.5, `中文页中等品名那行没撑开（行高 ${cnMedium}）`);
    assert.equal(rowHeight(cn, 8), 35, "短品名那行的行高被动了，短单子的单据样式不该变");
    for (const row of [9, 15]) {
      assert.equal(rowHeight(cn, row), 35, `中文页空白行 ${row} 的行高被动了`);
    }

    // 泰文页：D 列宽 18、模板原行高 20（约 1.4 行），比中文页更挤
    const thLong = rowHeight(th, 8);
    assert.ok(thLong != null && thLong >= 11 * 13.5, `泰文页长品名那行没撑开（行高 ${thLong}）`);
    assert.equal(rowHeight(th, 10), 20, "泰文页短品名那行的行高被动了");
  });

  await checkAsync("16) 整柜拆柜派送清单：同样按换行行数撑开，短品名保持模板行高 60", async () => {
    const { sheetOf, shared } = await renderZip(buildMixedNameData("container"), TEMPLATE);
    const sheet = await sheetOf("sheet1");
    assert.equal(cellValue(sheet, shared, "C10"), LONG_NAME, "整柜清单第 1 行品名被截断了");
    const long = rowHeight(sheet, 10);
    // C 列宽 25.48、原行高 60（约 4.4 行）；116 字要 8 行
    assert.ok(long != null && long >= 8 * 13.5, `长品名那行没撑开（行高 ${long}）`);
    assert.equal(rowHeight(sheet, 12), 60, "短品名那行的行高被动了");
    assert.equal(rowHeight(sheet, 34), 60, "空白明细行的行高被动了");
  });

  await checkAsync("24) 真模板：整柜清单按产品一行一行写，运单号/唛头写在这票第一行（下面几行合并进来），方数合计还是本票的", async () => {
    const data = buildSplitWholeData() as any;
    // 再放一票不展开的，确认它接在产品行后面、没被挤掉
    data.customers[0].shipments.push({ ...buildData({ lengthCm: 60, widthCm: 40, heightCm: 30 }).customers[0].shipments[0] });
    const { sheetOf, shared } = await renderZip(data, TEMPLATE);
    const sheet = await sheetOf("sheet1");
    assert.equal(cellValue(sheet, shared, "C10"), "镀膜剂");
    assert.equal(cellValue(sheet, shared, "C11"), "喷头");
    assert.equal(cellValue(sheet, shared, "C12"), "耳机", "后面那票不展开的被挤掉了");
    // 2026-10-07 起照仓库装柜表：一票的运单号/唛头只写一次，第 11 行并进第 10 行那格（合并见第 25 项）
    assert.equal(cellValue(sheet, shared, "B10"), "YW0001585-1", "这票第一行的运单号丢了");
    assert.equal(cellValue(sheet, shared, "A10"), "TESTCLIENT", "这票第一行的唛头丢了");
    assert.equal(cellValue(sheet, shared, "B11"), "", "被合并的格子里还藏着一份运单号");
    assert.equal(cellValue(sheet, shared, "A11"), "", "被合并的格子里还藏着一份唛头");
    assert.equal(cellValue(sheet, shared, "B12"), "SZ260801388", "下一票的运单号丢了");
    assert.equal(cellValue(sheet, shared, "D10"), "50");
    assert.equal(cellValue(sheet, shared, "D11"), "4");
    assert.equal(cellValue(sheet, shared, "G11"), "56.5", "喷头的长要是它自己的，不是「51.5/56.5」");
    // 第二行的产品列每格都要有（只有唛头/运单号/电话/地址/备注才合并跳过）—— 复核实测：把「高」当成合并列跳过，原来测不出来
    assert.deepEqual(["E11", "F11", "H11", "I11"].map((ref) => cellValue(sheet, shared, ref)), ["0.364", "40", "43", "37.5"], "喷头那行的方数/重量/宽/高缺了");
    assert.equal(cellValue(sheet, shared, "L3"), "2", "总票数按运单号数，展开成几行也还是 2 票");
    assert.equal(cellValue(sheet, shared, "L5"), "61", "总件数 54 + 7");
    assert.equal(Number(cellValue(sheet, shared, "E35")), 4.262, "方数合计应是 2.334 + 1.928");
    assert.equal(Number(cellValue(sheet, shared, "F35")), 1228, "重量合计应是 1140 + 88");
  });

  // ══════════════════════════════════════════════════════════════════════
  // 第 25~29 项：一票几行时照仓库装柜表合并格子、一票不跨页（2026-10-07，老板：「参考一下这个表格的」）
  // ══════════════════════════════════════════════════════════════════════

  await checkAsync("25) 真模板：一票几行时唛头/运单号/电话/地址/备注竖着合并（照仓库装柜表），模板别的合并一个不少、不许重叠", async () => {
    /**
     * 2026-10-07 老板：「参考一下这个表格的」—— 仓库装柜表里一票几个产品时，唛头、运单号竖着合并成一格。
     * 模板每个明细行本来有 J:K（电话）、L:M（地址）两个横向合并，被竖向合并包住的必须删掉，
     * 留着就是重叠合并，Excel 打开报「文件已损坏」—— 这个只有读 XML 才看得出来。
     */
    const data = buildSplitWholeData() as any;
    data.customers[0].shipments[0].remark = "周日不收货";
    data.customers[0].shipments.push({ ...buildData({ lengthCm: 60, widthCm: 40, heightCm: 30 }).customers[0].shipments[0] });
    const { sheetOf, shared } = await renderZip(data, TEMPLATE);
    const sheet = await sheetOf("sheet1");
    const original = await (await JSZip.loadAsync(fs.readFileSync(TEMPLATE))).file("xl/worksheets/sheet1.xml")!.async("string");
    const refs = mergeRefs(sheet);
    const templateRefs = mergeRefs(original);

    for (const ref of ["A10:A11", "B10:B11", "J10:K11", "L10:M11", "N10:N11"]) {
      assert.ok(refs.includes(ref), `同一票的 ${ref} 没合并，现有：${refs.filter((r) => /1[01]\b/.test(r)).join(" ")}`);
    }
    for (const ref of ["J10:K10", "J11:K11", "L10:M10", "L11:M11"]) {
      assert.ok(!refs.includes(ref), `${ref} 被新合并包住了却没删 → 合并重叠，Excel 会报文件损坏`);
    }
    for (const ref of ["C10:C11", "D10:D11", "E10:E11", "F10:F11", "G10:G11"]) {
      assert.ok(!refs.includes(ref), `产品自己的列 ${ref} 不该合并`);
    }
    // 只有一行的那票（第 12 行）跟模板一模一样
    for (const ref of ["J12:K12", "L12:M12"]) assert.ok(refs.includes(ref), `一票一行的 ${ref} 被动了`);
    assert.ok(!refs.some((r) => /^[ABN]12:/.test(r)), "一票一行的不该有竖向合并");
    // 模板原有的合并：除了被包住的那 4 个，一个不少
    const removed = templateRefs.filter((r) => !refs.includes(r));
    assert.deepEqual(removed.sort(), ["J10:K10", "J11:K11", "L10:M10", "L11:M11"], `模板合并少了不该少的：${removed.join(" ")}`);
    // 任意两个合并区域不许重叠；count 跟实际条数一致
    assertNoOverlap(refs);
    assert.equal(Number(/<(?:\w+:)?mergeCells\b[^>]*\bcount="(\d+)"/.exec(sheet)?.[1]), refs.length, "mergeCells 的 count 跟实际条数对不上");
    // 值只在这票第一行：电话、地址、备注
    assert.equal(cellValue(sheet, shared, "J10"), "0811111111");
    assert.equal(cellValue(sheet, shared, "L10"), "曼谷某路 2 号");
    assert.equal(cellValue(sheet, shared, "N10"), "周日不收货");
    for (const ref of ["J11", "L11", "N11"]) assert.equal(cellValue(sheet, shared, ref), "", `${ref} 被合并了却还藏着值`);
  });

  await checkAsync("26) 一票的几行不拆到两页：这页放不下就整票挪到下一页，总票数/件数不变", async () => {
    /** 24 票各一行 + 第 25 票两行：硬切的话第 25 票会被切成第 1 页一行、第 2 页一行 */
    const data = buildDataWithLines(24) as any;
    const split = buildSplitWholeData().customers[0].shipments[0];
    data.customers[0].shipments.push(split);
    const { sheetOf, shared, sheetFiles } = await renderZip(data, TEMPLATE);
    assert.equal(sheetFiles.length, 2, `应该 2 页，实际 ${sheetFiles.length} 页`);
    const page1 = await sheetOf("sheet1");
    const page2 = await sheetOf("sheet2");
    assert.equal(cellValue(page1, shared, "B33"), "SZ000000024", "第 1 页最后一票不对");
    assert.equal(cellValue(page1, shared, "B34"), "", "第 1 页第 34 行应该空着（整票挪到下一页了）");
    assert.equal(cellValue(page1, shared, "C34"), "", "第 1 页第 34 行还有品名 —— 一票被切到两页了");
    assert.equal(cellValue(page2, shared, "B10"), "YW0001585-1");
    assert.equal(cellValue(page2, shared, "C10"), "镀膜剂");
    assert.equal(cellValue(page2, shared, "C11"), "喷头");
    assert.ok(mergeRefs(page2).includes("B10:B11"), "挪到第 2 页后没合并");
    for (const page of [page1, page2]) {
      assert.equal(cellValue(page, shared, "L3"), "25", "总票数不对");
      assert.equal(cellValue(page, shared, "L5"), String((24 * 25) / 2 + 54), "总件数不对");
    }
    // 每页小计：第 1 页 24 票 0.1+…+2.4 方，第 2 页就是这票 2.334
    assert.equal(Number(cellValue(page1, shared, "E35")), 30, "第 1 页方数小计不对");
    assert.equal(Number(cellValue(page2, shared, "E35")), 2.334, "第 2 页方数小计不对");
  });

  const bigProducts = Array.from({ length: 27 }, (_, i) => ({
    itemName: `配件${i + 1}`, packageCount: 1, lengthCm: 10, widthCm: 10, heightCm: 10 + i, weightKg: 1,
  }));

  await checkAsync("27) 一票自己超过 25 行：只能拆页，每页各自合并、运单号每页都印；前面有半页时大票从新的一页开始", async () => {
    const data = buildSplitWholeData({ packageCount: 27, volumeM3: 0.5, weightKg: 27 }, bigProducts);
    const { sheetOf, shared, sheetFiles } = await renderZip(data, TEMPLATE);
    assert.equal(sheetFiles.length, 2);
    const page1 = await sheetOf("sheet1");
    const page2 = await sheetOf("sheet2");
    assert.equal(cellValue(page1, shared, "C34"), "配件25");
    assert.equal(cellValue(page2, shared, "C10"), "配件26");
    assert.equal(cellValue(page2, shared, "C11"), "配件27");
    assert.ok(mergeRefs(page1).includes("B10:B34"), "第 1 页 25 行没合并成一格");
    assert.ok(mergeRefs(page2).includes("B10:B11"), "第 2 页那 2 行没合并");
    assert.equal(cellValue(page2, shared, "B10"), "YW0001585-1", "续页上看不到运单号");
    assertNoOverlap(mergeRefs(page1));
    assertNoOverlap(mergeRefs(page2));
    assert.equal(Math.round((Number(cellValue(page1, shared, "E35")) + Number(cellValue(page2, shared, "E35"))) * 1000) / 1000, 0.5, "两页方数加起来不等于本票");

    // 前面已经有 20 行：大票不接着填本页剩下的 5 行，而是从第 2 页顶上开始（同一票尽量少翻页），后面的票接在大票尾巴后面
    const withHead = buildDataWithLines(20) as any;
    withHead.customers[0].shipments.push(buildSplitWholeData({ packageCount: 27, volumeM3: 0.5, weightKg: 27 }, bigProducts).customers[0].shipments[0]);
    withHead.customers[0].shipments.push({ ...withHead.customers[0].shipments[0], trackingNo: "TAIL0001", itemName: "尾票" });
    const r = await renderZip(withHead, TEMPLATE);
    assert.equal(r.sheetFiles.length, 3, `应该 3 页（20 / 25 / 2+1），实际 ${r.sheetFiles.length} 页`);
    const [h1, h2, h3] = [await r.sheetOf("sheet1"), await r.sheetOf("sheet2"), await r.sheetOf("sheet3")];
    assert.equal(cellValue(h1, r.shared, "C30"), "", "大票被塞进了第 1 页剩下的行");
    assert.equal(cellValue(h2, r.shared, "C10"), "配件1", "大票没从第 2 页顶上开始");
    assert.equal(cellValue(h3, r.shared, "B12"), "TAIL0001", "大票后面那票没接在尾巴后面");
    assert.ok(mergeRefs(h3).includes("B10:B11"), "第 3 页大票尾巴没合并");
    assert.ok(!mergeRefs(h3).some((ref) => ref.startsWith("B12:")), "尾票只有一行，不该合并");

    // 续页（克隆出来的工作表）也要去掉合并块里的横线，而且引用的样式必须真的在 styles.xml 里 ——
    // 复核实测：每页各用一个样式编辑器时，第 2 页的格子会指向不存在的样式（Excel 报「文件需要修复」），只查第 1 页抓不到
    const styles = await r.zip.file("xl/styles.xml")!.async("string");
    const xfCount = Number(/<cellXfs\b[^>]*\bcount="(\d+)"/.exec(styles)?.[1]);
    for (const [label, page] of [["第 1 页", h1], ["第 2 页", h2], ["第 3 页", h3]] as Array<[string, string]>) {
      for (const m of page.matchAll(/<c\b[^>]*\bs="(\d+)"/g)) assert.ok(Number(m[1]) < xfCount, `${label} 有格子引用了不存在的样式 s=${m[1]}（cellXfs 只有 ${xfCount} 条）`);
    }
    const edgesOn = (page: string, ref: string) => cellBorder(styles, Number(/\bs="(\d+)"/.exec(cellXml(page, ref))?.[1] ?? 0));
    assert.deepEqual([edgesOn(h2, "B10").top, edgesOn(h2, "B10").bottom], [true, false], "第 2 页大票首行：应留上框、去下框");
    assert.deepEqual([edgesOn(h2, "B20").top, edgesOn(h2, "B20").bottom], [false, false], "第 2 页大票中间行：上下框都该去掉");
    assert.deepEqual([edgesOn(h2, "B34").top, edgesOn(h2, "B34").bottom], [false, true], "第 2 页大票末行（第 34 行）：应去上框、留下框");
    assert.deepEqual([edgesOn(h3, "B10").top, edgesOn(h3, "B10").bottom], [true, false], "第 3 页大票尾巴首行：应留上框、去下框");
    assert.deepEqual([edgesOn(h3, "B11").top, edgesOn(h3, "B11").bottom], [false, true], "第 3 页大票尾巴末行：应去上框、留下框");
    assert.deepEqual([edgesOn(h3, "B12").top, edgesOn(h3, "B12").bottom], [true, true], "第 3 页尾票只有一行，框被动了");
  });

  await checkAsync("28) 两个客户的票挨着：各算各的票，不许合并到一起（编号要跨客户连续）", async () => {
    /**
     * 复核实测的回归：要是 shipmentIndex 每个客户从 0 重数，上一个客户最后一票和下一个客户第一票都是 0，
     * 会被当成同一票合并 —— 第二个客户的唛头/运单号/电话/地址整格消失。真柜 TRHU4325852 好几个唛头只有一票，
     * 照这样改坏，第 3 页 7 票被并成一票（件数 14 → 284）。之前的用例全是单客户，抓不到。
     */
    const data = buildData({ lengthCm: 60, widthCm: 40, heightCm: 30 }) as any;
    const second = JSON.parse(JSON.stringify(data.customers[0]));
    second.clientId = "SECOND";
    second.shipments = [
      { ...buildSplitWholeData().customers[0].shipments[0], receiverPhone: "0822222222", receiverAddress: "清迈某路 3 号" },
      { ...data.customers[0].shipments[0], trackingNo: "SZ260809999", receiverPhone: "0822222222", receiverAddress: "清迈某路 3 号" },
    ];
    data.customers.push(second);
    const { sheetOf, shared } = await renderZip(data, TEMPLATE);
    const sheet = await sheetOf("sheet1");
    const refs = mergeRefs(sheet);
    assert.equal(cellValue(sheet, shared, "B10"), "SZ260801388");
    assert.equal(cellValue(sheet, shared, "B11"), "YW0001585-1", "第二个客户第一票的运单号被并进上一票了");
    assert.equal(cellValue(sheet, shared, "A11"), "SECOND", "第二个客户的唛头被并进上一票了");
    assert.equal(cellValue(sheet, shared, "J11"), "0822222222", "第二个客户的电话丢了");
    assert.equal(cellValue(sheet, shared, "B13"), "SZ260809999", "第二个客户第二票的运单号丢了");
    assert.ok(refs.includes("B11:B12"), "第二个客户那票两行没合并");
    // 第 10 行那票只有一行：不许有从第 10 行往下跨的合并（模板自己的 J10:K10、L10:M10 横向合并要原样在）
    const spanning = refs.filter((ref) => /^[A-Z]+10:[A-Z]+(\d+)$/.test(ref) && Number(/(\d+)$/.exec(ref)![1]) > 10);
    assert.deepEqual(spanning, [], `第一个客户那票只有一行，却跟下面的票合并了：${spanning.join(" ")}`);
    for (const ref of ["J10:K10", "L10:M10"]) assert.ok(refs.includes(ref), `一票一行的 ${ref} 被动了`);
    assertNoOverlap(refs);
  });

  await checkAsync("29) 模板里有跟同一票合并「交叉」的区域时直接报错，不出一张错乱的表", async () => {
    // 真模板走不到这条路（它的 J:K、L:M 都会被整个包住）；造一个 J10:L10 这种横跨电话和地址两块的合并
    const zipped = await JSZip.loadAsync(fs.readFileSync(TEMPLATE));
    const xml = await zipped.file("xl/worksheets/sheet1.xml")!.async("string");
    zipped.file("xl/worksheets/sheet1.xml", xml.replace('<mergeCell ref="J10:K10"/>', '<mergeCell ref="J10:L10"/>').replace('<mergeCell ref="L10:M10"/>', ""));
    const broken = await zipped.generateAsync({ type: "uint8array" });
    await assert.rejects(buildLastmileTemplateWorkbook(buildSplitWholeData(), broken), /合并区域 J10:L10 跟同一票的合并交叉/);
    // 一票一行的不受影响（不会去碰合并区域），照样能导
    await buildLastmileTemplateWorkbook(buildData({ lengthCm: 60, widthCm: 40, heightCm: 30 }), broken);
  });

  await checkAsync("30) 合并块里面不许有横线：合并列的格子去掉块内的上/下边框，产品列行与行之间的线照旧", async () => {
    /**
     * 老板 2026-10-07：「并没有真的实现合并，因为我发现还有一条线」。
     * 模板每个格子四周都是细边框，合并后上一格的下边框、下一格的上边框还留在文件里 ——
     * Excel、苹果预览会藏起来，老板用的看表软件照画，合并格中间一条横线，看着跟没合并一样 —— 所以从样式上真正去掉。
     * 3 个产品的票：第一行去下边框、中间行上下都去、最后一行去上边框；块的外框（第一行上、最后一行下）要留。
     */
    const products = [
      { itemName: "甲", packageCount: 1, lengthCm: 10, widthCm: 10, heightCm: 10, weightKg: 1 },
      { itemName: "乙", packageCount: 1, lengthCm: 10, widthCm: 10, heightCm: 20, weightKg: 1 },
      { itemName: "丙", packageCount: 1, lengthCm: 10, widthCm: 10, heightCm: 30, weightKg: 1 },
    ];
    const data = buildSplitWholeData({ packageCount: 3, volumeM3: 0.006, weightKg: 3 }, products) as any;
    data.customers[0].shipments.push({ ...buildData({ lengthCm: 60, widthCm: 40, heightCm: 30 }).customers[0].shipments[0] });
    const { zip, sheetOf } = await renderZip(data, TEMPLATE);
    const sheet = await sheetOf("sheet1");
    const styles = await zip.file("xl/styles.xml")!.async("string");
    const templateStyles = await (await JSZip.loadAsync(fs.readFileSync(TEMPLATE))).file("xl/styles.xml")!.async("string");
    const edges = (ref: string) => cellBorder(styles, Number(/\bs="(\d+)"/.exec(cellXml(sheet, ref))?.[1] ?? 0));

    for (const column of ["A", "B", "J", "K", "L", "M", "N"]) {
      assert.deepEqual([edges(`${column}10`).top, edges(`${column}10`).bottom], [true, false], `${column}10（块第一行）应留上框、去下框`);
      assert.deepEqual([edges(`${column}11`).top, edges(`${column}11`).bottom], [false, false], `${column}11（块中间行）上下框都该去掉`);
      assert.deepEqual([edges(`${column}12`).top, edges(`${column}12`).bottom], [false, true], `${column}12（块最后一行）应去上框、留下框`);
      // 下一票只有一行：四周的框原样
      assert.deepEqual([edges(`${column}13`).top, edges(`${column}13`).bottom], [true, true], `${column}13（一票一行）的框被动了`);
    }
    // 左右框不受影响（J:K、L:M 中间那条竖线模板里本来就没有，左右两边要在）
    assert.equal(edges("J11").left, true, "电话块左框丢了");
    assert.equal(edges("K11").right, true, "电话块右框丢了");
    // 产品列：行与行之间的线照旧（跟仓库装柜表一样，每个产品一格）
    for (const column of ["C", "D", "E", "F", "G", "H", "I"]) {
      for (const row of [10, 11, 12]) {
        assert.deepEqual([edges(`${column}${row}`).top, edges(`${column}${row}`).bottom], [true, true], `产品列 ${column}${row} 的横线被去掉了`);
      }
    }
    // 样式表只在末尾追加：模板原有的 xf / border 条目一个字不改（单元格按下标引用，改了会连带改掉别处）
    const list = (xml: string, block: string, item: string) => [...(new RegExp(`<${block}\\b[^>]*>([\\s\\S]*?)<\\/${block}>`).exec(xml)?.[1] ?? "")
      .matchAll(new RegExp(`<${item}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${item}>)`, "g"))].map((m) => m[0]);
    for (const [block, item] of [["cellXfs", "xf"], ["borders", "border"]]) {
      const before = list(templateStyles, block, item), after = list(styles, block, item);
      assert.deepEqual(after.slice(0, before.length), before, `${block} 原有条目被改了`);
      assert.ok(after.length > before.length, `${block} 没有追加新条目`);
      assert.equal(Number(new RegExp(`<${block}\\b[^>]*\\bcount="(\\d+)"`).exec(styles)?.[1]), after.length, `${block} 的 count 跟实际条数对不上`);
    }
    assert.equal(styles.replace(/<cellXfs\b[\s\S]*?<\/cellXfs>/, "").replace(/<borders\b[\s\S]*?<\/borders>/, ""),
      templateStyles.replace(/<cellXfs\b[\s\S]*?<\/cellXfs>/, "").replace(/<borders\b[\s\S]*?<\/borders>/, ""), "样式表里 cellXfs / borders 以外的部分被动了");
  });

  await checkAsync("31) 两种单子每个合并区域（表头/标题/签字栏 + 同一票的块）里面都没有边框，外圈和字体对齐等跟模板一样；整柜表头补上 C3:C4、C5:C6", async () => {
    /**
     * 老板 2026-10-07 截图：整柜清单表头「柜号：」「TRHU4325852」「起运地：」中间一条线 ——「这里的也还是不合并状态」。
     * ① 那几格是模板自带的合并（A3:A4、B3:B4、D3:D4…），格子自己四周有边框，他的看表软件把块里面的边也画出来了；
     * ② C3/C4、C5/C6 在模板里根本没合并（第 3~6 行别的列都合并了），那条线 Excel 里也看得见。
     * 接着老板定了客户签收单也「合并去线」。规矩（两种单子、所有页）：合并区域里面的边一律去掉；
     * 朝外的边（连线型颜色）、以及边框/底色以外的一切（字体/对齐/数字格式）跟模板同一格一模一样；
     * 底色整块统一成模板里左上角那格的（跟 Excel 显示一致）；合并区域以外的格子样式不动。
     */
    const xfList = (xml: string) => [...(/<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(xml)?.[1] ?? "").matchAll(/<(?:\w+:)?xf\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?xf>)/g)].map((m) => m[0]);
    const withoutBorderAndFill = (xf: string) => xf.replace(/\s+borderId="\d+"/, "").replace(/\s+applyBorder="[^"]*"/, "").replace(/\s+fillId="\d+"/, "").replace(/\s+applyFill="[^"]*"/, "");
    const fillOf = (xf: string | undefined) => Number(/\bfillId="(\d+)"/.exec(xf ?? "")?.[1] ?? 0);
    const styleOf = (xml: string, ref: string) => {
      const m = new RegExp(`<(?:\\w+:)?c\\b[^>]*?\\br="${ref}"[^>]*?(?:\\/>|>)`).exec(xml);
      return m ? Number(/\bs="(\d+)"/.exec(m[0])?.[1] ?? 0) : null;
    };
    const col = (s: string) => s.split("").reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
    const name = (c: number) => { let s = ""; while (c > 0) { c -= 1; s = String.fromCharCode(65 + (c % 26)) + s; c = Math.floor(c / 26); } return s; };
    const box = (ref: string) => { const [, c1, r1, c2, r2] = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref)!; return [col(c1), Number(r1), col(c2), Number(r2)]; };

    const customerSplit = (() => {
      const d = buildDataWithLines(8, { scope: "customer", deliveryDate: "2026-10-07" }) as any;
      // 备注要有字：「新加的共享字符串都得有格子引用」这条检查只有真写了字才查得出「写了又清掉」（复核实测）
      d.customers[0].shipments.push({ ...buildSplitWholeData().customers[0].shipments[0], remark: "易碎" }, { ...buildSplitWholeData().customers[0].shipments[0], remark: "轻放" });
      return d as LastmileExportData;
    })();
    const scenarios: Array<[string, LastmileExportData, string]> = [
      ["整柜一票一行", buildDataWithLines(3), TEMPLATE],
      ["整柜一票多行、多页", (() => {
        const d = buildDataWithLines(24) as any;
        d.customers[0].shipments.push(buildSplitWholeData().customers[0].shipments[0]);
        return d as LastmileExportData;
      })(), TEMPLATE],
      ["整柜一票超过 25 行", buildSplitWholeData({ packageCount: 27, volumeM3: 0.5, weightKg: 27 }, bigProducts), TEMPLATE],
      ["客户签收单一票一行、多页", buildDataWithLines(12, { scope: "customer", deliveryDate: "2026-10-07" }), CUSTOMER_TEMPLATE],
      ["客户签收单一票多行、多页", customerSplit, CUSTOMER_TEMPLATE],
    ];
    for (const [label, data, templatePath] of scenarios) {
      const isContainer = templatePath === TEMPLATE;
      const templateZip = await JSZip.loadAsync(fs.readFileSync(templatePath));
      const templateStyles = await templateZip.file("xl/styles.xml")!.async("string");
      const templateXfs = xfList(templateStyles);
      const { zip, sheetFiles } = await renderZip(data, templatePath);
      const styles = await zip.file("xl/styles.xml")!.async("string");
      const xfs = xfList(styles);
      let checkedMerges = 0;
      for (const file of sheetFiles) {
        const sheet = await zip.file(file)!.async("string");
        // 续页是克隆的：整柜都对应模板 sheet1；客户签收单按「中文、泰文」交替，单数对 sheet1、双数对 sheet2
        const n = Number(/sheet(\d+)\.xml$/.exec(file)![1]);
        const templateSheet = await templateZip.file(`xl/worksheets/sheet${isContainer ? 1 : (n % 2 === 1 ? 1 : 2)}.xml`)!.async("string");
        for (const m of sheet.matchAll(/<(?:\w+:)?c\b[^>]*\bs="(\d+)"/g)) assert.ok(Number(m[1]) < xfs.length, `${label} ${file} 有格子引用不存在的样式 s=${m[1]}`);
        const refs = mergeRefs(sheet);
        if (isContainer) for (const ref of ["C3:C4", "C5:C6"]) assert.ok(refs.includes(ref), `${label} ${file} 表头 ${ref} 没合并`);
        for (const ref of refs) {
          const [c1, r1, c2, r2] = box(ref);
          checkedMerges += 1;
          // 合并格的底色跟左上角那格走（Excel 显示合并格就用左上角那格）：取模板里那格的底色；
          // 导出后左上角那格不存在（签收单 A55 / A64 那句回传话是按老板要求整格删掉的）= 没有底色
          const topLeftTemplateStyle = styleOf(templateSheet, `${name(c1)}${r1}`);
          const wantFill = topLeftTemplateStyle === null || styleOf(sheet, `${name(c1)}${r1}`) === null ? 0 : fillOf(templateXfs[topLeftTemplateStyle]);
          for (let r = r1; r <= r2; r += 1) {
            for (let c = c1; c <= c2; c += 1) {
              const cellRef = `${name(c)}${r}`;
              const s = styleOf(sheet, cellRef);
              const t = styleOf(templateSheet, cellRef);
              const where = `${label} ${file} 合并区域 ${ref} 的 ${cellRef}`;
              if (isContainer) assert.ok(s !== null && t !== null, `${where} 这一格不见了`); // 整柜模板合并区域里每格都写着 <c>
              // 带底色的合并（如签收单深红底白字的「重要声明」横幅）：模板缺的格子要补上，不然逐格画的软件只涂得到 A 那一格
              if (wantFill !== 0) assert.ok(s !== null, `${where} 带底色的合并区域缺格子，整条横幅涂不满`);
              if (s === null) continue; // 没底色的合并里缺的格子（签收单模板是稀疏写法；A55/A64 是导出时故意删的）不用补
              if (fillOf(xfs[s]) !== (t === null ? 0 : fillOf(templateXfs[t]))) {
                assert.match(xfs[s], /\bapplyFill="1"/, `${where} 底色换了却没标 applyFill="1"，严格按规范的软件会不上底色`);
              }
              if (t === null) {
                // 导出补上的格子：Excel 里那里本来没有格子、没有边 —— 只带底色，不带任何边框
                const added = cellBorder(styles, s);
                assert.deepEqual([added.top, added.bottom, added.left, added.right], [false, false, false, false], `${where} 补上的格子不该带边框`);
                assert.equal(fillOf(xfs[s]), wantFill, `${where} 补上的格子底色跟左上角不一样`);
                continue;
              }
              // 边框、底色以外的样式（字体、对齐、数字格式…）跟模板同一格一字不差 —— 复核实测：克隆时丢了字体/对齐，之前的测试全绿
              assert.equal(withoutBorderAndFill(xfs[s]), withoutBorderAndFill(templateXfs[t]), `${where} 除边框、底色外的样式被改了`);
              // 底色整块一样（泰文签收单明细隔行浅蓝，不统一的话逐格画的软件里合并格中间一道深浅交界 —— 复核指出）
              assert.equal(fillOf(xfs[s]), wantFill, `${where} 底色跟这块合并格左上角不一样`);
              const got = cellBorder(styles, s);
              // 外圈的边连线型、颜色一起比原文（只比「有没有线」的话，细线被改成粗线 / 换了颜色也抓不到）
              const outer = (edge: "top" | "bottom" | "left" | "right", side: string) =>
                assert.equal(borderEdgeXml(styles, s, edge).replace(/\s+\/>/g, "/>"), borderEdgeXml(templateStyles, t, edge).replace(/\s+\/>/g, "/>"), `${where} 外圈${side}边框跟模板不一样`);
              if (r > r1) assert.equal(got.top, false, `${where} 里面还有上边框（一条横线）`);
              else outer("top", "上");
              if (r < r2) assert.equal(got.bottom, false, `${where} 里面还有下边框（一条横线）`);
              else outer("bottom", "下");
              if (c > c1) assert.equal(got.left, false, `${where} 里面还有左边框（一条竖线）`);
              else outer("left", "左");
              if (c < c2) assert.equal(got.right, false, `${where} 里面还有右边框（一条竖线）`);
              else outer("right", "右");
            }
          }
        }
        // 不在任何合并区域里的格子：样式下标跟模板一样（写值不改样式）
        const inMerge = (cellRef: string) => {
          const [, cs, rs] = /^([A-Z]+)(\d+)$/.exec(cellRef)!;
          return refs.some((ref) => { const [c1, r1, c2, r2] = box(ref); return c1 <= col(cs) && col(cs) <= c2 && r1 <= Number(rs) && Number(rs) <= r2; });
        };
        for (const m of templateSheet.matchAll(/<(?:\w+:)?c\b[^>]*?\br="([A-Z]+\d+)"/g)) {
          if (inMerge(m[1])) continue;
          const got = styleOf(sheet, m[1]);
          if (got !== null) assert.equal(got, styleOf(templateSheet, m[1]), `${label} ${file} 合并区域以外的 ${m[1]} 样式被改了`);
        }
      }
      assert.ok(checkedMerges > 30, `${label} 只查到 ${checkedMerges} 个合并区域，模板的合并没读到`);
      // 导出新加进共享字符串表的每一条都得有格子在用：合并块下面几行不写（而不是写了再清），清掉的字会成为没人引用的垃圾
      const sharedXml = await zip.file("xl/sharedStrings.xml")!.async("string");
      const templateShared = await templateZip.file("xl/sharedStrings.xml")!.async("string");
      const siCount = (xml: string) => (xml.match(/<(?:\w+:)?si\b/g) ?? []).length;
      const used = new Set<number>();
      for (const file of sheetFiles) {
        const xml = await zip.file(file)!.async("string");
        for (const m of xml.matchAll(/<(?:\w+:)?c\b[^>]*\bt="s"[^>]*>\s*<(?:\w+:)?v>(\d+)<\/(?:\w+:)?v>/g)) used.add(Number(m[1]));
      }
      const unused = [];
      for (let i = siCount(templateShared); i < siCount(sharedXml); i += 1) if (!used.has(i)) unused.push(i);
      assert.deepEqual(unused, [], `${label} 共享字符串表里有导出新加、却没有格子引用的条目（写了又清掉了？）`);
    }

    // 截图里那几格点名查一下：整柜表头 A3:A4（柜号）、B3:B4（柜号值）、C3:C4（原来没合并）、A1:N2（标题）
    const { zip, sheetOf } = await renderZip(buildDataWithLines(1), TEMPLATE);
    const sheet = await sheetOf("sheet1");
    const styles = await zip.file("xl/styles.xml")!.async("string");
    const edgesOf = (ref: string) => cellBorder(styles, Number(/\bs="(\d+)"/.exec(cellXml(sheet, ref))?.[1] ?? 0));
    for (const ref of ["A3", "B3", "C3", "C5"]) assert.equal(edgesOf(ref).bottom, false, `${ref}（表头合并格上半）还有下边框`);
    for (const ref of ["A4", "B4", "C4", "C6"]) assert.equal(edgesOf(ref).top, false, `${ref}（表头合并格下半）还有上边框`);
    assert.equal(edgesOf("C1").bottom, false, "标题 A1:N2 中间还有横线");
  });

  await checkAsync("33) 客户签收单：同一票几行时序号/单号/客户/唛头/备注合并、序号按票编、一票不拆到两页；包装状况和打勾列每行一格", async () => {
    /**
     * 老板 2026-10-07：客户签收单也「合并去线」。
     * 中文页合并 B 序号、C 单号、H 备注；泰文页合并 A 序号、B 客户、C 唛头、I 备注。
     * 序号原来按行编，一票两个产品会印成 1、2，看着像两票 —— 改成按票编。
     * 数据：7 票各一行 + 两票各两个产品（镀膜剂 / 喷头）共 11 行。每页 10 行，按行硬切会把第 9 票切成第 1 页一行、第 2 页一行；
     * 现在第 1 页只放 9 行（第 15 行空着），第 9 票整票挪到第 2 页。
     */
    const d = buildDataWithLines(7, { scope: "customer", deliveryDate: "2026-10-07" }) as any;
    const split = buildSplitWholeData().customers[0].shipments[0];
    d.customers[0].shipments.push({ ...split, remark: "易碎" }, { ...split, trackingNo: "YW0001601-1", remark: "" });
    const { sheetOf, shared, sheetFiles } = await renderZip(d as LastmileExportData, CUSTOMER_TEMPLATE);
    assert.equal(sheetFiles.length, 4, `应该中文/泰文各 2 页，实际 ${sheetFiles.length} 张`);
    const [cn1, th1, cn2, th2] = [await sheetOf("sheet1"), await sheetOf("sheet2"), await sheetOf("sheet3"), await sheetOf("sheet4")];

    // 中文页第 1 页：第 8 票占第 13~14 行
    assert.equal(cellValue(cn1, shared, "B12"), "7");
    assert.equal(cellValue(cn1, shared, "B13"), "8", "序号要按票编：第 8 票");
    assert.equal(cellValue(cn1, shared, "C13"), "YW0001585-1");
    assert.equal(cellValue(cn1, shared, "H13"), "易碎");
    assert.equal(cellValue(cn1, shared, "D13"), "镀膜剂");
    assert.equal(cellValue(cn1, shared, "D14"), "喷头");
    // 第二行的产品列每格都要有 —— 复核实测：把体积当成合并列跳过，原来测不出来
    assert.deepEqual(["E14", "F14", "G14"].map((ref) => cellValue(cn1, shared, ref)), ["4", "0.364", "40"], "中文页喷头那行的件数/体积/重量缺了");
    for (const ref of ["B14", "C14", "H14"]) assert.equal(cellValue(cn1, shared, ref), "", `中文页 ${ref} 被合并了却还藏着值`);
    for (const ref of ["B13:B14", "C13:C14", "H13:H14"]) assert.ok(mergeRefs(cn1).includes(ref), `中文页同一票 ${ref} 没合并`);
    for (const ref of ["D13:D14", "E13:E14", "F13:F14", "G13:G14"]) assert.ok(!mergeRefs(cn1).includes(ref), `中文页产品列 ${ref} 不该合并`);
    // 第 9 票（两行）放不下第 15 行这一个空位：整票挪到第 2 页，第 15 行空着
    for (const ref of ["B15", "C15", "D15"]) assert.equal(cellValue(cn1, shared, ref), "", `中文页 ${ref} 有内容 —— 第 9 票被切到两页了`);
    assertNoOverlap(mergeRefs(cn1));

    // 泰文页第 1 页：第 8 票占第 15~16 行
    assert.equal(cellValue(th1, shared, "A15"), "8");
    assert.equal(cellValue(th1, shared, "B15"), "TESTCLIENT");
    assert.equal(cellValue(th1, shared, "C15"), "TESTCLIENT");
    assert.equal(cellValue(th1, shared, "I15"), "易碎");
    for (const ref of ["A16", "B16", "C16", "I16"]) assert.equal(cellValue(th1, shared, ref), "", `泰文页 ${ref} 被合并了却还藏着值`);
    // 泰文页第二行的产品列 —— 复核实测：品名/件数/重量当成合并列跳过，原来一个都测不出来
    assert.deepEqual(["D16", "E16", "F16", "G16"].map((ref) => cellValue(th1, shared, ref)), ["喷头", "4", "0.364", "40"], "泰文页喷头那行的品名/件数/体积/重量缺了");
    for (const ref of ["A15:A16", "B15:B16", "C15:C16", "I15:I16"]) assert.ok(mergeRefs(th1).includes(ref), `泰文页同一票 ${ref} 没合并`);
    for (const ref of ["H15:H16", "J15:J16", "D15:D16"]) assert.ok(!mergeRefs(th1).includes(ref), `泰文页 ${ref}（每行手写/打勾或产品列）不该合并`);
    assert.equal(cellValue(th1, shared, "D17"), "", "泰文页第 17 行有内容 —— 第 9 票被切到两页了");
    assertNoOverlap(mergeRefs(th1));

    // 第 9 票整票在第 2 页，序号接着按票编（9），不是按行算的 10
    assert.equal(cellValue(cn2, shared, "B6"), "9", "第 2 页序号没接着按票编");
    assert.equal(cellValue(cn2, shared, "C6"), "YW0001601-1");
    assert.equal(cellValue(cn2, shared, "D7"), "喷头", "第 9 票第二行不在第 2 页");
    assert.ok(mergeRefs(cn2).includes("C6:C7"), "挪到第 2 页后没合并");
    assert.equal(cellValue(th2, shared, "A8"), "9");
    assert.ok(mergeRefs(th2).includes("A8:A9"), "泰文页第 2 页没合并");
    // 页内合计：第 1 页 7 票（1+…+7=28 件）+ 第 8 票 54 件；第 2 页 54 件
    assert.equal(cellValue(cn1, shared, "E16"), String(28 + 54), "第 1 页件数合计不对");
    assert.equal(cellValue(cn2, shared, "E16"), "54", "第 2 页件数合计不对");

    // 多个收货地址：签收单先按地址分页，序号按页面上出现的先后编 —— 复核实测：改成按数据顺序编、或分组前就编号，前面全绿。
    // 四票交替发往 X、Y，第 3 票两个产品：第 1 页（X）是第 1、3 票 → 序号 1、2；第 2 页（Y）是第 2、4 票 → 序号 3、4
    const multi = buildDataWithLines(4, { scope: "customer", deliveryDate: "2026-10-07" }) as any;
    const toX = { receiverPhone: "0811111111", receiverAddress: "曼谷某路 2 号" };
    const toY = { receiverPhone: "0822222222", receiverAddress: "清迈某路 3 号" };
    Object.assign(multi.customers[0].shipments[0], toX, { trackingNo: "S1" });
    Object.assign(multi.customers[0].shipments[1], toY, { trackingNo: "S2" });
    multi.customers[0].shipments[2] = { ...split, ...toX, trackingNo: "S3" };
    Object.assign(multi.customers[0].shipments[3], toY, { trackingNo: "S4" });
    const m = await renderZip(multi as LastmileExportData, CUSTOMER_TEMPLATE);
    const [mcn1, mcn2, mth2] = [await m.sheetOf("sheet1"), await m.sheetOf("sheet3"), await m.sheetOf("sheet4")];
    assert.deepEqual([cellValue(mcn1, m.shared, "C6"), cellValue(mcn1, m.shared, "B6"), cellValue(mcn1, m.shared, "C7"), cellValue(mcn1, m.shared, "B7")], ["S1", "1", "S3", "2"], "地址 X 那一页的序号不对");
    assert.ok(mergeRefs(mcn1).includes("B7:B8"), "地址 X 那页第 3 票（两行）没合并");
    assert.deepEqual([cellValue(mcn2, m.shared, "C6"), cellValue(mcn2, m.shared, "B6"), cellValue(mcn2, m.shared, "C7"), cellValue(mcn2, m.shared, "B7")], ["S2", "3", "S4", "4"], "地址 Y 那一页的序号没接着按页面顺序编");
    assert.equal(cellValue(mth2, m.shared, "A9"), "4", "泰文页第 2 页序号不对");
  });

  await checkAsync("32) 表头补合并的两条保护：下半格有字不补（字会被藏起来）；模板已经有跟它交叉的合并就不补，照样能导", async () => {
    // 真模板走不到这两条路，改一份模板造出来。复核实测：去掉这两条保护，前 31 项照样全绿
    const original = await (await JSZip.loadAsync(fs.readFileSync(TEMPLATE))).file("xl/worksheets/sheet1.xml")!.async("string");
    const exportWith = async (sheetXml: string) => {
      const zipped = await JSZip.loadAsync(fs.readFileSync(TEMPLATE));
      zipped.file("xl/worksheets/sheet1.xml", sheetXml);
      const out = await JSZip.loadAsync(await buildLastmileTemplateWorkbook(buildDataWithLines(1), await zipped.generateAsync({ type: "uint8array" })));
      return out.file("xl/worksheets/sheet1.xml")!.async("string");
    };

    // ① C4（下半格）有字：不补 C3:C4，字原样留着；C5:C6 不受影响照补
    const withText = original.replace('<c r="C4" s="8"/>', '<c r="C4" s="8" t="inlineStr"><is><t>手写备注</t></is></c>');
    assert.notEqual(withText, original, "模板 C4 的写法变了，这项没造出数据");
    const a = await exportWith(withText);
    assert.ok(!mergeRefs(a).includes("C3:C4"), "C4 有字还补了 C3:C4 —— 合并会把 C4 的字藏起来");
    assert.ok(mergeRefs(a).includes("C5:C6"), "C5:C6 应该照补");
    assert.ok(a.includes("手写备注"), "C4 的字丢了");

    // ② 模板自己把 C3:D4 合并了：不再补 C3:C4（会跟它交叉），也不许因此报错导不出来
    const crossed = original.replace('<mergeCell ref="D3:D4"/>', '<mergeCell ref="C3:D4"/>');
    assert.notEqual(crossed, original, "模板 D3:D4 的写法变了，这项没造出数据");
    const b = await exportWith(crossed);
    assert.ok(mergeRefs(b).includes("C3:D4"), "模板自己的 C3:D4 被动了");
    assert.ok(!mergeRefs(b).includes("C3:C4"), "跟模板 C3:D4 交叉了还补 C3:C4");
    assert.ok(mergeRefs(b).includes("C5:C6"), "C5:C6 应该照补");
    assertNoOverlap(mergeRefs(b));
  });

  await checkAsync("34) 签收单横幅左上角那格带边框时照样能导出：补上的格子只带底色、不带边", async () => {
    /**
     * 复核实测：补格子用的样式是「左上角样式去掉四条边」。左上角本来就没边时它就是原样式；
     * 一旦左上角带边（有人在 Excel 里给「重要声明」横幅加一圈框再存回模板），它就是新追加的样式，
     * 后面去内框时再查它，原来只在模板原有样式里找 → 抛「找不到第 N 号单元格样式」，整张签收单导不出来。
     * 造法：把签收单模板 styles.xml 里第 16 号样式（中文页 A21「重要声明」、泰文页 A38 用的）的 borderId 从 0 改成 1（四边细线）。
     */
    const zipped = await JSZip.loadAsync(fs.readFileSync(CUSTOMER_TEMPLATE));
    const stylesXml = await zipped.file("xl/styles.xml")!.async("string");
    let index = -1;
    const patched = stylesXml.replace(/<(?:\w+:)?cellXfs\b[^>]*>[\s\S]*?<\/(?:\w+:)?cellXfs>/, (block) =>
      block.replace(/<(?:\w+:)?xf\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?xf>)/g, (xf) => {
        index += 1;
        return index === 16 ? xf.replace(/\bborderId="\d+"/, 'borderId="1"') : xf;
      }));
    assert.notEqual(patched, stylesXml, "没改到第 16 号样式，这项没造出数据");
    zipped.file("xl/styles.xml", patched);
    const template = await zipped.generateAsync({ type: "uint8array" });
    const out = await JSZip.loadAsync(await buildLastmileTemplateWorkbook(buildDataWithLines(3, { scope: "customer", deliveryDate: "2026-10-07" }), template));
    const sheet = await out.file("xl/worksheets/sheet1.xml")!.async("string");
    const styles = await out.file("xl/styles.xml")!.async("string");
    const sOf = (ref: string) => Number(/\bs="(\d+)"/.exec(cellXml(sheet.replace(/<x:/g, "<").replace(/<\/x:/g, "</"), ref))?.[1] ?? 0);
    const fillOf = (style: number) => Number(/\bfillId="(\d+)"/.exec([...(/<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(styles)?.[1] ?? "").matchAll(/<(?:\w+:)?xf\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?xf>)/g)][style]?.[0] ?? "")?.[1] ?? 0);
    const banner = fillOf(sOf("A21"));
    assert.notEqual(banner, 0, "A21 横幅应该有底色");
    for (const ref of ["B21", "E21", "H21"]) {
      assert.equal(fillOf(sOf(ref)), banner, `${ref} 没补上横幅底色`);
      const edges = cellBorder(styles, sOf(ref));
      assert.deepEqual([edges.top, edges.bottom, edges.left, edges.right], [false, false, false, false], `${ref} 补上的格子不该带边`);
    }
    assert.equal(cellBorder(styles, sOf("A21")).right, false, "A21 是合并块左上角，右边框（块里面）应该去掉");
  });

  await checkAsync("17) 撑开行高不许把 row 标签写坏：customHeight 在、序号件数合计照旧", async () => {
    const { sheetOf, shared } = await renderZip(buildMixedNameData("customer"), CUSTOMER_TEMPLATE);
    const cn = await sheetOf("sheet1");
    // 改过的那一行必须带 customHeight="1"，否则 Excel 压根不看 ht
    const rowTag = /<(?:\w+:)?row\b[^>]*\br="6"[^>]*>/.exec(cn);
    assert.ok(rowTag, "找不到第 6 行");
    assert.match(rowTag![0], /customHeight="1"/, "撑开行高后 customHeight 丢了，Excel 会忽略 ht");
    assert.equal((rowTag![0].match(/\bht="/g) ?? []).length, 1, `row 标签里出现了多个 ht：${rowTag![0]}`);
    // 同一行其它格子和页内合计不受影响
    assert.equal(cellValue(cn, shared, "B6"), "1", "序号被改坏了");
    assert.equal(cellValue(cn, shared, "C6"), "SZ000000001", "运单号被改坏了");
    assert.equal(cellValue(cn, shared, "E6"), "1", "件数被改坏了");
    assert.equal(cellValue(cn, shared, "E16"), "6", "件数合计被改坏了");
  });
}

main()
  .then(() => {
    if (failures.length > 0) {
      console.error(`\n${failures.length}/34 项不通过：${failures.join("；")}`);
      process.exit(1);
    }
    console.log("整柜拆柜派送清单导出：34 项全部通过");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
