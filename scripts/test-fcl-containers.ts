/**
 * 整柜管理（2026-09-23）。
 *
 * 老板逐条拍板的规格：
 *   ① 货物明细要记；② 追踪用海运 23 步 / 陆运 17 步那套细的；③ 柜号**不给客户看**；
 *   ④ 整柜的货不走仓库收货流程；⑤ 运单号手动填；⑥ 轨迹从「已装柜」起步；
 *   ⑦ 要选仓库；⑧ 钱线下走、系统里手填一个金额、**客户能看到**；⑨ 只有员工/超管能建。
 *
 * 这份测试盯四件事（直接调真函数 + 读源码，不连库、不起服务）：
 *   ① 清单每一行的校验和算式（体积 = 长×宽×高÷1000000×箱数）；
 *   ② 表格模板是**精确匹配**（表头改一个字就读不到，得有明确提示而不是静默少货）；
 *   ③ 客户那两个接口和客户那一页**一个柜号都不许出现**；
 *   ④ 员工端和超管端用的是**同一个组件**（别再出现尾端派送那种两套各写各的）。
 * 用法：npm run test:fcl-containers
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = process.cwd();
const read = (p: string): string => readFileSync(path.join(root, p), "utf-8");

function loadModule(rel: string): Record<string, any> {
  const filename = path.resolve(root, rel);
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const moduleObject = { exports: {} as Record<string, any> };
  vm.runInNewContext("(function(exports,require,module){" + output + "\n})", { console }, { filename })(
    moduleObject.exports,
    createRequire(filename),
    moduleObject,
  );
  return moduleObject.exports;
}

const rowsMod = loadModule("apps/api/src/modules/fcl-containers/product-rows.ts");
const { parseFclProductRow, sumFclRows, strictestCargoType, FCL_START_CONTAINER_STATUS, FCL_START_SHIPMENT_STATUS } = rowsMod;
const tpl = loadModule("apps/web/src/modules/fcl/template.ts");
const { FCL_TEMPLATE_HEADERS, fclRowFromSheet } = tpl;

let failures = 0;
function check(name: string, run: () => void): void {
  try {
    run();
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failures++;
    console.log(`  ❌ ${name}\n     ${(e instanceof Error ? e.message : String(e)).split("\n").join("\n     ")}`);
  }
}

const goodRow = {
  itemName: "鞋", packageCount: 10, quantityPerBox: 20,
  lengthCm: 60, widthCm: 40, heightCm: 30, unitWeightKg: 2.5,
  domesticTrackingNo: "SF0001", cargoType: "normal",
};
const rowOf = (patch: Record<string, unknown>) => {
  const r = parseFclProductRow({ ...goodRow, ...patch }, 0);
  if ("error" in r) throw new Error(`本来该通过的却被拒了：${r.error}`);
  return r.row;
};
const errOf = (patch: Record<string, unknown>): string => {
  const r = parseFclProductRow({ ...goodRow, ...patch }, 0);
  if (!("error" in r)) throw new Error("本来该被拒的却通过了");
  return r.error;
};

console.log("整柜管理");

check("1) 一行货算出来的数：体积 = 长×宽×高÷1000000×箱数，总重 = 单箱重×箱数", () => {
  const r = rowOf({});
  // 60×40×30 = 72000 cm³ = 0.072 m³，10 箱 = 0.72
  assert.equal(r.volumeM3, 0.72);
  assert.equal(r.unitWeightKg, 2.5, "单箱重原样留着 —— 写进 order_products 的是它");
  assert.equal(r.weightKg, 25);            // 整行总重 2.5 × 10，只用来加总，不入库
  assert.equal(r.productQuantity, 200);    // 10 箱 × 每箱 20
  assert.equal(r.sortOrder, 0);
});

check("2) 箱数 / 每箱数量必须是正整数（2.5 箱不许过 —— 库里是 Int）", () => {
  assert.match(errOf({ packageCount: 2.5 }), /箱数/);
  assert.match(errOf({ packageCount: 0 }), /箱数/);
  assert.match(errOf({ packageCount: -1 }), /箱数/);
  assert.match(errOf({ packageCount: "" }), /箱数/);
  assert.match(errOf({ quantityPerBox: 1.5 }), /每箱数量/);
  // 每箱数量不填按 1 算（客户清单上常常只有箱数）
  assert.equal(rowOf({ quantityPerBox: "" }).productQuantity, 10);
});

check("3) 长宽高必填且要大于 0；单箱重量选填，不填按 0", () => {
  for (const k of ["lengthCm", "widthCm", "heightCm"]) {
    assert.match(errOf({ [k]: "" }), /cm/, `${k} 空着该被拒`);
    assert.match(errOf({ [k]: 0 }), /cm/, `${k} 填 0 该被拒`);
    assert.match(errOf({ [k]: -5 }), /cm/, `${k} 填负数该被拒`);
  }
  const r = rowOf({ unitWeightKg: "" });
  assert.equal(r.weightKg, 0, "单箱重量不填，总重就是 0，不该报错");
});

check("4) 品名必填、货型只认那三种", () => {
  assert.match(errOf({ itemName: "   " }), /品名/);
  assert.match(errOf({ cargoType: "危险品" }), /货型/);
  assert.equal(rowOf({ cargoType: "sensitive" }).cargoType, "sensitive");
  // 不填按普货
  assert.equal(rowOf({ cargoType: "" }).cargoType, "normal");
});

check("5) 整票汇总，和一柜多行时货型取最严的那个", () => {
  const rows = [rowOf({}), parseFclProductRow({ ...goodRow, itemName: "帽", packageCount: 5, unitWeightKg: 1 }, 1) as any];
  const list = [rows[0], rows[1].row];
  const sum = sumFclRows(list);
  if ("error" in sum) throw new Error(sum.error);
  assert.equal(sum.packageCount, 15);
  assert.equal(sum.weightKg, 30);                 // 25 + 5×1
  assert.equal(sum.volumeM3, 1.08);               // 0.72 + 0.36
  assert.equal(strictestCargoType(["normal", "inspection"]), "inspection");
  assert.equal(strictestCargoType(["inspection", "sensitive"]), "sensitive");
  assert.equal(strictestCargoType(["normal", "normal"]), "normal");
});

check("6) 表格模板：表头精确匹配，改一个字那一列就读不到", () => {
  assert.equal(FCL_TEMPLATE_HEADERS.length, 9);
  const filled: Record<string, string> = {};
  FCL_TEMPLATE_HEADERS.forEach((h: string, i: number) => {
    filled[h] = ["鞋", "10", "20", "60", "40", "30", "2.5", "SF0001", "普货"][i];
  });
  const parsed = fclRowFromSheet(filled);
  assert.equal(parsed.itemName, "鞋");
  assert.equal(parsed.packageCount, "10");
  assert.equal(parsed.cargoType, "normal", "表格里写中文「普货」要转成 normal");
  // 真跑一遍校验，确认表格解析出来的东西后端收得下
  const r = parseFclProductRow(parsed, 0);
  if ("error" in r) throw new Error(`表格解析出来的行过不了校验：${r.error}`);
  assert.equal(r.row.volumeM3, 0.72);

  // 表头被改过：品名读不到 → 必须被校验拦下来，不能静默当成空行放过去
  const wrongHeader = { ...filled };
  delete wrongHeader[FCL_TEMPLATE_HEADERS[0]];
  wrongHeader["品名"] = "鞋";  // 少了「 *」
  const bad = fclRowFromSheet(wrongHeader);
  assert.equal(bad.itemName, "", "表头对不上就该读成空，而不是猜");
  const badCheck = parseFclProductRow(bad, 0);
  assert.ok("error" in badCheck, "读成空行之后必须被校验拦住");
});

check("7) 整柜的起点：柜子「已封柜」⇄ 运单「已装柜」必须是对应的一对", () => {
  assert.equal(FCL_START_SHIPMENT_STATUS, "loaded", "老板 2026-09-23：轨迹从「已装柜」起步");
  assert.equal(FCL_START_CONTAINER_STATUS, "SEALED");
  // 这一对必须跟现有那张映射表对得上，否则员工一推柜子就会再写一条重复的「已装柜」
  const flow = read("apps/api/src/modules/containers/status-flow.ts");
  assert.match(flow, new RegExp(`${FCL_START_CONTAINER_STATUS}:\\s*"${FCL_START_SHIPMENT_STATUS}"`),
    "status-flow.ts 里 SEALED 对应的运单状态变了，整柜的起点要跟着改");
});

check("8) 客户那两个接口和客户那一页：一个柜号都不许出现", () => {
  const routes = read("apps/api/src/modules/fcl-containers/routes.ts");
  const clientFormat = routes.slice(routes.indexOf("function formatFclForClient"), routes.indexOf("function formatProductRow"));
  assert.ok(clientFormat.length > 100, "找不到 formatFclForClient，这条测试要跟着改");
  assert.ok(!/containerNo/.test(clientFormat), "客户那份里出现了 containerNo —— 客户不能看柜号（2026-08-07）");
  // 「挑着给」而不是「展开整行再摘几个」：以后谁给柜子加内部字段，客户那边不会自动看见
  assert.ok(!/\.\.\.container\b/.test(clientFormat), "客户那份用了 ...container 展开整行，表里加什么字段就漏什么");

  const page = read("apps/web/src/app/client/fcl-containers/page.tsx");
  assert.ok(!/柜号/.test(page.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")), "客户那一页显示了柜号");
  assert.ok(!/containerNo/.test(page), "客户那一页读了 containerNo");
  // 金额客户要看得到（老板 2026-09-23：能看到）
  assert.match(page, /amountCny/, "客户那一页要显示金额");
  assert.match(clientFormat, /amountCny/, "客户接口要返回金额");
});

check("9) 员工端和超管端用同一个组件，没有各写一套", () => {
  const staff = read("apps/web/src/app/staff/fcl-containers/page.tsx");
  const admin = read("apps/web/src/app/admin/fcl-containers/page.tsx");
  for (const [who, src] of [["员工", staff], ["超管", admin]] as const) {
    assert.match(src, /FclContainerWorkbench/, `${who}端没用共用组件`);
    // 页面本身应该很薄：超过 40 行多半是有人又在这儿另写了一套
    assert.ok(src.split("\n").length < 40, `${who}端那一页太长了，像是另写了一套界面`);
  }
  const shared = read("apps/web/src/components/fcl/FclContainerWorkbench.tsx");
  assert.match(shared, /新建整柜/);
  assert.match(shared, /下载模板/);
  assert.match(shared, /传表格/);
});

check("9-a) 写进 order_products 的重量是**单箱重**，不是整行总重", () => {
  /**
   * 2026-09-23 复核抓到的最重的一条：这一列全系统都按「单箱重」用
   *   · 汇总 orders/routes.ts:325  总重 = Σ(weightKg × packageCount)
   *   · 客户派送签收单 exportDispatchWorkbooks.ts:531  weightKg × packageCount
   * 写成整行总重的话，客户签收单上印的是「单箱重 × 箱数²」——
   * 10 箱 2.5kg 的货会印成 250kg，而那是要给客户签字的纸。
   */
  const routes = read("apps/api/src/modules/fcl-containers/routes.ts");
  const createBlock = routes.slice(routes.indexOf("tx.orderProduct.createMany"), routes.indexOf("tx.shipment.create"));
  assert.ok(createBlock.length > 50, "找不到写产品行那段，这条测试要跟着改");
  assert.match(createBlock, /weightKg: r\.unitWeightKg,/, "写进 order_products 的必须是单箱重");
  assert.ok(!/weightKg: r\.weightKg,/.test(createBlock), "又把整行总重写进单箱重那一列了");
  // 页面上也不能把这一列标成「总重」，不然员工照着改会把两个口径混一起
  for (const f of ["apps/web/src/components/fcl/FclContainerWorkbench.tsx", "apps/web/src/app/client/fcl-containers/page.tsx"]) {
    const src = read(f);
    assert.ok(!/<th style=\{th\}>总重kg<\/th>/.test(src), `${f} 把单箱重那一列标成了「总重」`);
  }
});

check("9-b) 单行体积 / 总重是中间量，不能拿汇总列的小数位去卡", () => {
  /**
   * 2026-09-23 复核实测：40×30×37 一箱 = 0.0444 m³（4 位小数），
   * 原来拿 3 位的 DECIMAL_10_3 去卡它，这种完全正常的尺寸直接建不了柜，
   * 还报一句看不懂的「体积超出范围」。真正要守 3 位的是加总之后那个数。
   */
  for (const [L, W, H, P] of [[40, 30, 37, 1], [33, 33, 33, 1], [55, 45, 38, 7]]) {
    const r = parseFclProductRow({ ...goodRow, lengthCm: L, widthCm: W, heightCm: H, packageCount: P }, 0);
    assert.ok(!("error" in r), `${L}×${W}×${H} ×${P}箱 这种常见尺寸被拒了：${(r as any).error}`);
  }
  // 加总之后仍然要守住 3 位（那个数是要入库的）
  const rows = [rowOf({ lengthCm: 33, widthCm: 33, heightCm: 33, packageCount: 1 })];
  const sum = sumFclRows(rows);
  assert.ok(!("error" in sum), "加总不该报错");
  assert.equal(String((sum as any).volumeM3).split(".")[1]?.length <= 3, true, "加总后的体积必须是 3 位以内");
});

check("10-a) 「已装柜」那条轨迹的时间用员工填的装柜日期，不是录入时刻", () => {
  /**
   * 2026-09-23 浏览器实测撞到的：装柜日期填 9-20，轨迹却写成录入那天 9-23，
   * 再推「已开船」（9-22）之后，客户看到的顺序变成「开船比装柜还早」。
   * 整柜都是装完柜才录进系统的，时间必须回填成柜子那天。
   */
  const routes = read("apps/api/src/modules/fcl-containers/routes.ts");
  assert.match(routes, /const sealedAt = loadingDate \?\? now;/, "装柜时间没有回填成装柜日期");
  assert.match(routes, /changedAt: sealedAt,/, "「已装柜」轨迹没用装柜日期");
  assert.match(routes, /\[FCL_START_CONTAINER_STATUS\]: sealedAt\.toISOString\(\)/, "柜子的时间表没用装柜日期");
  assert.ok(!/changedAt: now,/.test(routes), "还有地方在用录入时刻当轨迹时间");
});

check("10) 建整柜这条路：提单号手填、要选仓库、只有员工和超管能建", () => {
  const routes = read("apps/api/src/modules/fcl-containers/routes.ts");
  const createBlock = routes.slice(routes.indexOf('app.post("/staff/fcl-containers/create"'), routes.indexOf('app.get("/staff/fcl-containers/list"'));
  assert.match(createBlock, /requireRole\(req, res, \["staff", "admin"\]\)/, "建整柜的权限不对");
  assert.match(createBlock, /提单号为必填/, "提单号是手填的，必须校验（老板 2026-09-23：那个号不叫运单号）");
  assert.match(createBlock, /请选择仓库/, "老板 2026-09-23：整柜也要选仓库");
  assert.match(createBlock, /请选择运输方式：海运或陆运/, "运输方式必填，它决定走海运还是陆运那套流程");
  // 查重必须在事务里（两个员工同时录同一个柜号/运单号）
  const txBlock = createBlock.slice(createBlock.indexOf("$transaction"));
  assert.match(txBlock, /tx\.container\.findUnique/, "柜号查重要在事务里做");
  assert.match(txBlock, /tx\.shipment\.findUnique/, "运单号查重要在事务里做");
  // 客户不能建
  assert.ok(!/app\.post\("\/client\/fcl-containers/.test(routes), "客户不该有建整柜的接口（老板：我们建）");
});

check("11) 整柜的单不进普通运单列表（老板 2026-09-23：不想混在一起）", () => {
  /**
   * 老板原话：「不想混在一起，整柜的不要出现在普通运单列表，而是一个单独的板块」；
   * 问到尾端派送时他答「排除，整柜的尾端单独在页面里弄」；问到顶部数字和看板时答「不算」。
   * ⚠️ /staff/shipments 一个接口喂着三个地方：员工运单列表、装柜管理候选、尾端派送候选 ——
   * 排一处等于排三处（CLAUDE.md 第 12 条）。
   *
   * ⚠️⚠️ 必须按**每一个查询自己那一段**去查，不能查「整个文件里有没有出现过」
   * （2026-09-23 第 2 轮复核批评的，我自检时也确实骗过了自己：
   *  把超管那处的条件删掉、文件里别处还有，测试照样全绿）。
   */
  const spots: Array<[string, string, string, string, string]> = [
    // [说明, 文件, 从哪儿开始切, 切到哪儿, 要出现的条件]
    ["超管运单管理", "apps/api/src/modules/admin/routes.ts",
      'app.get("/admin/orders"', "prisma.shipment.count", "EXCLUDE_FCL_SHIPMENT"],
    // 2026-09-24：整柜有了自己的尾端页签，这条改成三元 —— 不传 scope 时照旧排除整柜，
    // 传 scope=fcl 时只要整柜的（整柜那一页用）。两个分支都要在，缺一个就串。
    ["员工运单管理 / 装柜候选 / 尾端候选", "apps/api/src/modules/shipments/routes.ts",
      'app.get("/staff/shipments"', "prisma.shipment.count", "fclScope \\? ONLY_FCL_SHIPMENT : EXCLUDE_FCL_SHIPMENT"],
    ["客户运单查询", "apps/api/src/modules/shipments/routes.ts",
      'app.get("/client/shipments/search"', "orderBy", "EXCLUDE_FCL_SHIPMENT"],
    ["客户我的运单", "apps/api/src/modules/orders/routes.ts",
      'app.get("/client/orders"', "prisma.order.count", "EXCLUDE_FCL_ORDER"],
    ["客户预报单", "apps/api/src/modules/orders/routes.ts",
      "const prealertWhere", "prisma.order.count", "EXCLUDE_FCL_ORDER"],
    ["代理端运单列表 / 导出", "apps/api/src/modules/agent-portal/routes.ts",
      "const where: Prisma.OrderWhereInput", "filters.keyword", "EXCLUDE_FCL_ORDER"],
  ];
  for (const [who, file, from, to, symbol] of spots) {
    const src = read(file);
    const i = src.indexOf(from);
    assert.ok(i >= 0, `${who}：找不到「${from}」，这条测试要跟着改`);
    const j = src.indexOf(to, i);
    const block = src.slice(i, j > i ? j + 200 : i + 1200);
    // `...(fclScope ? A : B)` 这种三元要带上左括号才匹配得上
    assert.match(block, new RegExp(`\\.\\.\\.\\(?${symbol}|AND: \\[${symbol}\\]`),
      `${who}这个查询的 where 里没排除整柜（光在文件别处 import 不算）`);
  }
  // 顶部那排数字要跟列表一个口径，不然会「列表 0 条、顶上写 1」
  const shipSrc = read("apps/api/src/modules/shipments/routes.ts");
  const overviewBlock = shipSrc.slice(shipSrc.indexOf('app.get("/client/shipments/overview"'));
  assert.equal((overviewBlock.match(/\.\.\.EXCLUDE_FCL_SHIPMENT/g) ?? []).length, 2,
    "客户端和员工端的顶部数字都要排除整柜（老板 2026-09-23：不算）");
  // 运营看板：柜子那几个数按 isFcl:false 数，「卡住的柜子」那段 SQL 也要带条件
  const adminSrc = read("apps/api/src/modules/admin/routes.ts");
  assert.ok((adminSrc.match(/isFcl: false/g) ?? []).length >= 4, "看板的柜子统计没排除整柜");
  assert.match(adminSrc, /AND c\.is_fcl = false/, "「卡住的柜子」那段 SQL 没排除整柜");
  // AI 数据源
  const aiSrc = read("apps/api/src/modules/ai/client-ai-routes.ts");
  assert.match(aiSrc, /\.\.\.EXCLUDE_FCL_ORDER/, "AI 的订单数据源没排除整柜");
  assert.match(aiSrc, /\.\.\.EXCLUDE_FCL_SHIPMENT/, "AI 的运单数据源没排除整柜");
});

check("12) 现有装柜机器不许误动整柜：不能往里装、不能卸、不能删", () => {
  /**
   * 2026-09-23 两轮复核都点名的：整柜跟现有那套完全没隔离。
   * 往整柜里装别人的货 / 把整柜的单装进别的柜 / 卸柜 / 删单 ——
   * 后两样还会留下一个「客户看不到、也永远删不掉」的空壳柜
   * （删柜只允许「装柜中」，整柜从「已封柜」起步回不去）。
   */
  const lm = read("apps/api/src/modules/loading-manifests/routes.ts");
  assert.match(lm, /if \(container\.isFcl\) throw new Error/, "装柜没拦住「往整柜里装货」");
  assert.match(lm, /container: \{ isFcl: true \}/, "装柜没拦住「把整柜的单装进别的柜」");
  assert.match(lm, /if \(item\.container\?\.isFcl\) throw new Error\(FCL_BLOCKED_MESSAGE\)/, "卸柜没拦住整柜");
  const admin = read("apps/api/src/modules/admin/routes.ts");
  assert.match(admin, /containerItems\.some\(\(it\) => it\.container\?\.isFcl\)/, "删运单没拦住整柜");
  // 三处用同一句提示，别各写各的
  assert.match(lm, /FCL_BLOCKED_MESSAGE/);
  assert.match(admin, /FCL_BLOCKED_MESSAGE/);
});

check("13) 上传表格：表头缺列要说出来，有数据没品名的行不许静默丢", () => {
  /**
   * 2026-09-23 复核抓到两条：
   *   · 「货型」表头改一个字 → 整张表静默变普货；「单箱重量」改一个字 → 总重静默变 0
   *   · 只漏填品名的行被 filter 掉，提交还说成功 —— 等于少运货（CLAUDE.md 第 19 条）
   */
  const tplSrc = read("apps/web/src/modules/fcl/template.ts");
  assert.match(tplSrc, /export function missingFclHeaders/, "没有整张核对表头的函数");
  const tplMod = loadModule("apps/web/src/modules/fcl/template.ts");
  /* ⚠️ 比数组要先摊平成普通数组再比：模块是在 vm 里加载的，
     它造出来的数组跟这边的 Array 不是同一个构造函数，
     assert.deepEqual 会报「结构一样但不是同一个引用」。 */
  const flat = (x: unknown): string[] => [...(x as string[])];
  const full: Record<string, string> = {};
  for (const h of tplMod.FCL_TEMPLATE_HEADERS) full[h] = "x";
  assert.deepEqual(flat(tplMod.missingFclHeaders(full)), [], "完整模板不该报缺列");
  const broken = { ...full };
  delete broken[tplMod.FCL_TEMPLATE_HEADERS[8]];          // 把「货型」那一列表头改坏
  broken["货型"] = "敏感货";
  assert.deepEqual(flat(tplMod.missingFclHeaders(broken)), [tplMod.FCL_TEMPLATE_HEADERS[8]], "表头改坏了要指名少哪一列");
  assert.equal(flat(tplMod.missingFclHeaders(undefined)).length, tplMod.FCL_TEMPLATE_HEADERS.length, "空表要报全部缺");

  const ui = read("apps/web/src/components/fcl/FclContainerWorkbench.tsx");
  assert.match(ui, /missingFclHeaders/, "上传时没核对表头");
  assert.match(ui, /没写品名|没填品名/, "有数据没品名的行没被显式报出来");
});

check("14) 整柜不许被现有柜子操作动到：撤销已封柜 / 删柜 / 改运输方式 / 建派送单", () => {
  /**
   * 2026-09-23 第 2 轮复核抓到的一串，两边都点名：
   *   · 整柜建出来时**没有推进账本**，撤销会掉进 legacy 分支：它只删 `sl_ctn_` 前缀的轨迹，
   *     而整柜起点那条是 `sl_fcl_` —— 柜子退回「装柜中」、货还停在「已装柜」，两边对不上；
   *     再推一次客户轨迹里就会有两条「已装柜」。
   *   · 撤销之后柜子正好落在「装柜中」，删柜那道只判这个状态的闸也跟着开了。
   *   · 改运输方式那道闸只拦「走到对方流程独有的状态」，而整柜起点「已封柜」是海陆共有的，
   *     正好从缝里漏过去 → 柜子改成陆运、货还记着海运，两套流程就串了。
   *   · 尾端派送候选虽然排掉了整柜，但直接调建派送单的接口仍然能给整柜建。
   */
  const ctn = read("apps/api/src/modules/containers/routes.ts");
  assert.equal((ctn.match(/if \(container\.isFcl\)/g) ?? []).length, 3,
    "撤销预览 / 撤销 / 删柜，这三处都要拦住整柜");
  const lm = read("apps/api/src/modules/loading-manifests/routes.ts");
  const modeBlock = lm.slice(lm.indexOf('app.post("/staff/loading-manifests/transport-mode"'), lm.indexOf('app.post("/staff/loading-manifests/seal"'));
  assert.ok(modeBlock.length > 100, "找不到改运输方式那段，这条测试要跟着改");
  assert.match(modeBlock, /container\.isFcl/, "改运输方式没拦住整柜（「已封柜」是海陆共有状态，会从缝里漏过去）");
  /* 建派送单那道拦截 2026-09-24 有意去掉了：整柜有了自己的尾端页签，
     建单/签收/撤销/导客户签收单全走同一套写接口。
     两边分开靠的是**各看各的列表**，所以这里改成盯那个分流。 */
  const ops = read("apps/api/src/modules/admin-ops/routes.ts");
  assert.match(ops, /scope === "fcl"[\s\S]{0,120}ONLY_FCL_SHIPMENT/,
    "派送单列表没按整柜分流（整柜那页要 scope=fcl）");
  assert.match(ops, /EXCLUDE_FCL_SHIPMENT/, "普通尾端派送的派送单列表没排掉整柜");
  assert.ok(!/isFclShipment\(ownShipment\)/.test(ops),
    "建派送单那道拦截该去掉了 —— 整柜现在要从自己的页签建派送单");
});

check("15) 表头两头的空格：核对和取值必须同一把尺子", () => {
  /**
   * 2026-09-23 第 2 轮复核**实测**抓到：核对表头时 trim 了、取值时没 trim ——
   * 客户表格的表头末尾多打一个空格，missingFclHeaders 说「没缺列」，
   * 取值却全落空：品名读成空、单箱重读成空、货型退回普货，一声不吭。
   */
  const tplMod = loadModule("apps/web/src/modules/fcl/template.ts");
  const H: string[] = tplMod.FCL_TEMPLATE_HEADERS;
  const vals = ["鞋", "10", "20", "60", "40", "30", "2.5", "SF1", "敏感货"];
  const padded: Record<string, string> = {};
  H.forEach((h, i) => { padded[h + " "] = vals[i]; });   // 每个表头后面多一个空格
  assert.deepEqual([...(tplMod.missingFclHeaders(padded) as string[])], [], "表头只是多了空格，不该报缺列");
  const row = tplMod.fclRowFromSheet(padded);
  assert.equal(row.itemName, "鞋", "表头多个空格就读不到品名了");
  assert.equal(String(row.unitWeightKg), "2.5", "表头多个空格就读不到单箱重了");
  assert.equal(row.cargoType, "sensitive", "表头多个空格，货型就静默退回普货了");
});

check("16) 空行判断：只动过「每箱数量」或「货型」的行不算空行", () => {
  /**
   * 2026-09-23 第 2 轮复核抓到：isBlank 那张清单漏了「每箱数量」，
   * 只填了那一格、没写品名的行会被当成空行**静默丢掉**（CLAUDE.md 第 19 条）。
   * 货型有默认值 normal，得按「动过没有」算。
   */
  const ui = read("apps/web/src/components/fcl/FclContainerWorkbench.tsx");
  const blanks = ui.match(/const isBlank[\s\S]*?;\n/g) ?? [];
  assert.equal(blanks.length, 2, "上传和提交两处都该有空行判断");
  for (const b of blanks) {
    assert.match(b, /quantityPerBox/, "空行判断漏了「每箱数量」");
    assert.match(b, /cargoType \?\? "normal"\) === "normal"/, "空行判断没把「货型动过没有」算进去");
  }
});

check("17) 两个改单接口：不许把提单号改成柜号、不许改整柜的运输方式", () => {
  /**
   * 2026-09-24 上线前复核抓到（Codex 报的，我上一轮只堵了超管那条、漏了员工那条）：
   *   · 提单号客户看得到、柜号客户看不到，改成一样等于把柜号发出去
   *   · 改运输方式只改订单和运单、柜子不跟着改 → 柜子按海运推、货记着陆运，两套流程分裂
   * 其余字段照旧能改 —— 整柜还没有自己的编辑入口，全堵死建错就没法救。
   */
  for (const [who, file] of [
    ["超管改单", "apps/api/src/modules/admin/routes.ts"],
    ["员工改单", "apps/api/src/modules/orders/routes.ts"],
  ] as const) {
    const src = read(file);
    assert.match(src, /container: \{ isFcl: true \}/, `${who}没查这张单是不是整柜的`);
    assert.match(src, /提单号不能跟柜号填成同一个/, `${who}没拦「提单号=柜号」`);
    assert.match(src, /整柜的运输方式不能在这里改/, `${who}没拦「改整柜运输方式」`);
  }
});

check("18) 撤销柜子状态：只拦整柜那条没账本的起点，后面的照样能撤", () => {
  /**
   * 2026-09-24 复核指出我上一版一刀切全拦太狠：员工推错「已到港」就再也纠正不了。
   * 只有起点「已封柜」是建柜时直接写的、没有推进账本，撤销它会掉进 legacy 分支出错；
   * 后面那些是正常推出来的、有账本，撤销是安全的。
   */
  const ctn = read("apps/api/src/modules/containers/routes.ts");
  assert.equal((ctn.match(/const hasLedger = await prisma\.containerPushBatch\.findFirst/g) ?? []).length, 2,
    "撤销预览和撤销两处都要按「有没有账本」判，而不是见整柜就拦");
  assert.match(ctn, /整柜的「已封柜」是建柜时就定下的/, "拦下来时要说清楚为什么");
  // 删柜仍然是**见整柜就拦**（删柜对整柜永远不该做）
  const delBlock = ctn.slice(ctn.indexOf('app.delete("/admin/containers"'));
  assert.match(delBlock, /if \(container\.isFcl\) \{[\s\S]{0,200}FCL_BLOCKED_MESSAGE/, "删柜必须见整柜就拦");
});

check("19) 上线相关：结构体检清单要跟着 schema 走；装柜页认得出整柜", () => {
  /**
   * 2026-09-24 复核抓到：schema 加了 containers.is_fcl，但手抄的结构体检清单没同步 ——
   * 部署结尾会多出一条「B 多余」的假警告。那份文件自己的注释就写着
   * 「2026-08-05 加 containers.transport_mode 时就漏了一次」，这是第二次。
   */
  assert.match(read("scripts/check-schema-drift.sql"), /\('containers','is_fcl'\)/,
    "结构体检清单漏了 is_fcl，部署结尾会报假警告");
  // 员工要在「装柜管理」里给整柜推状态，得先认得出哪个是整柜
  assert.match(read("apps/api/src/modules/loading-manifests/routes.ts"), /isFcl: c\.isFcl === true/,
    "装柜列表没下发整柜标记");
  const page = read("apps/web/src/app/staff/container-loading/page.tsx");
  assert.match(page, /item\.isFcl &&/, "装柜列表上没有「整柜」标记");
  assert.match(page, /detail\.status === "LOADING" && !detail\.isFcl/, "整柜还能点「删除柜子」");
  assert.match(page, /disabled=\{detail\.isFcl\}/, "整柜的运输方式下拉没禁用");
});

check("20) 两个建柜入口互相提示，别走错（走错事后不能互转）", () => {
  /**
   * 老板 2026-09-24：整柜和拼柜靠「从哪个入口建的」区分，系统不猜
   * （线上 110 个柜只有一个客户的货，但平均才 3.7 方，按「一个客户=整柜」猜必然错）。
   * 而建完**不能互转**，所以两边都要在建的时候提一句。
   */
  const loading = read("apps/web/src/app/staff/container-loading/page.tsx");
  assert.match(loading, /整柜管理/, "装柜管理的新建表单里没提示「整柜请到整柜管理建」");
  assert.match(loading, /不能互转/, "装柜管理没说清楚建完不能互转");
  const fcl = read("apps/web/src/components/fcl/FclContainerWorkbench.tsx");
  assert.match(fcl, /装柜管理/, "整柜管理的新建弹窗里没提示「拼柜请到装柜管理建」");
  assert.match(fcl, /不能互转/, "整柜管理没说清楚建完不能互转");
});

check("21) 整柜的尾端派送：用同一套组件，两边各看各的列表", () => {
  /**
   * 老板 2026-09-23：「排除，整柜的尾端单独在页面里弄」。
   * 做法是**复用**普通尾端那个共用组件（建单/签收/撤销/导客户签收单全是同一套写接口），
   * 只把「看什么」分开：整柜那页传 scope=fcl，普通页不传。
   * ⚠️ 2026-09-24 实测发现过一个坑：签收走尾端派送，它只推运单状态、不动柜子状态，
   * 所以整柜看板必须按**运单状态**算，按柜子状态会显示「已到仓 1、已签收 0」。
   */
  const ui = read("apps/web/src/components/fcl/FclContainerWorkbench.tsx");
  assert.match(ui, /LastmileDispatchWorkspace/, "整柜尾端没复用共用组件，像是另写了一套");
  assert.match(ui, /scope=fcl|fetchFclLastmileShipments/, "整柜尾端没按 scope=fcl 取自己的候选");
  assert.match(ui, /tab === "lastmile"/, "整柜管理没有尾端派送页签");
  // 撤销误签收只给超管，跟普通尾端同一个规矩
  assert.match(read("apps/web/src/app/admin/fcl-containers/page.tsx"), /canUnsign/, "超管端该能撤销误签收");
  assert.ok(!/canUnsign/.test(read("apps/web/src/app/staff/fcl-containers/page.tsx")), "员工端不该能撤销误签收");
});

check("22) 整柜看板：按运单状态算，不是柜子状态", () => {
  const routes = read("apps/api/src/modules/fcl-containers/routes.ts");
  const block = routes.slice(routes.indexOf('app.get("/staff/fcl-containers/overview"'), routes.indexOf('app.get("/staff/fcl-containers/detail"'));
  assert.ok(block.length > 200, "找不到整柜看板那段，这条测试要跟着改");
  assert.match(block, /st === "delivered"/, "「已签收」必须按运单状态判（签收不改柜子状态）");
  assert.match(block, /AT_WAREHOUSE_SHIPMENT/, "「已到仓」也该按运单状态判");
  assert.ok(!/currentStatus: "SIGNED"/.test(block), "别按柜子状态数已签收 —— 整柜签收后柜子还停在「已到仓」");
  // 页面上要把这排数字显示出来
  assert.match(read("apps/web/src/components/fcl/FclContainerWorkbench.tsx"), /整柜总数/, "整柜页面没显示看板数字");
});

check("23) 删整柜：只给超管、要手打柜号、已签收或已排派送单的删不了", () => {
  /**
   * 老板 2026-09-24：「可以删吧」。建错了要能救，但这一下会把柜子、运单、订单、
   * 货物清单、轨迹一起删掉，客户那边也会消失 —— 所以三道闸：
   *   ① 只给超管（跟「删运单」同一个权限档）
   *   ② 要把柜号原样打一遍（比密码顺手，照样防手滑）
   *   ③ 已签收的、已排派送单的不许删
   */
  const routes = read("apps/api/src/modules/fcl-containers/routes.ts");
  const block = routes.slice(routes.indexOf('app.post("/admin/fcl-containers/delete"'));
  assert.ok(block.length > 300, "找不到删整柜那段，这条测试要跟着改");
  assert.match(block, /requireRole\(req, res, \["admin"\]\)/, "删整柜必须只给超管");
  assert.match(block, /confirmContainerNo/, "删整柜要手打柜号确认");
  assert.match(block, /currentStatus === "delivered"/, "已签收的整柜必须拦住");
  assert.match(block, /adminLastmileOrder\.findMany/, "已排派送单的整柜必须拦住");
  // 判断要在锁里重做（CLAUDE.md 第 28 条）
  const txPart = block.slice(block.indexOf("$transaction"));
  assert.ok(txPart.indexOf("FOR UPDATE") < txPart.indexOf('currentStatus === "delivered"'),
    "「有没有签收」要在锁里重读判断，不能用事务外的快照");
  // 前端：只有超管那一页开放
  assert.match(read("apps/web/src/app/admin/fcl-containers/page.tsx"), /canDelete/, "超管端该能删");
  assert.ok(!/canDelete/.test(read("apps/web/src/app/staff/fcl-containers/page.tsx")), "员工端不该能删");
  assert.match(read("apps/web/src/components/fcl/FclContainerWorkbench.tsx"), /canDelete && \(/, "删除按钮没按权限藏起来");
});

if (failures > 0) {
  console.log(`❌ 失败 ${failures} 项`);
  process.exit(1);
}
console.log("✅ 整柜管理：23 项全部通过");
