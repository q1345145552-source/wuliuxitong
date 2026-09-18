/**
 * 整柜拆柜派送清单导出的自测（不连数据库、不连网络、不写文件）。
 *
 * 为什么要有这个：2026-08-28 老板实测发现「多尺寸的单子，Excel 长宽高三格全是空白」，
 * 而单尺寸的能导出来 —— 这个模块**一个测试都没有**，所以没人发现。
 *
 * 根因链条（三环，缺一环这三列就是空的）：
 *   ① 后端 loading-manifests/routes.ts:397 给每票货的 products 恒定是空数组
 *      （柜内多是分柜子单，展开产品行会把件数重复算回整票）；
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

/** 造一份跟后端 /loading-manifests 返回结构一致的数据（products 恒为空，跟真实一致） */
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
            // ⚠️ 后端就是恒定空数组，测试必须照着真实情况来，不能自己填一份产品行
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
      console.error(`\n${failures.length}/18 项不通过：${failures.join("；")}`);
      process.exit(1);
    }
    console.log("整柜拆柜派送清单导出：18 项全部通过");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
