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
   * 问到尾端派送时他答「排除，整柜的尾端单独在页面里弄」。
   * ⚠️ /staff/shipments 一个接口喂着三个地方：员工运单列表、装柜管理候选、尾端派送候选 ——
   * 排一处等于排三处（CLAUDE.md 第 12 条）。
   */
  const ends: Array<[string, string, string]> = [
    ["超管运单管理", "apps/api/src/modules/admin/routes.ts", "EXCLUDE_FCL_SHIPMENT"],
    ["员工运单管理 / 装柜候选 / 尾端候选", "apps/api/src/modules/shipments/routes.ts", "EXCLUDE_FCL_SHIPMENT"],
    ["客户我的运单", "apps/api/src/modules/orders/routes.ts", "EXCLUDE_FCL_ORDER"],
    ["代理端运单列表", "apps/api/src/modules/agent-portal/routes.ts", "EXCLUDE_FCL_ORDER"],
  ];
  for (const [who, file, symbol] of ends) {
    const src = read(file);
    assert.match(src, new RegExp(`from "\\.\\./core/fcl-scope"`), `${who}没有引用整柜隔离条件`);
    assert.match(src, new RegExp(symbol), `${who}的查询里没排除整柜`);
  }
  // 客户端和代理端那两处必须写成 AND 一条：它们的 where 里已经有 shipments 键，直接加会被盖掉
  for (const [who, file] of [["客户我的运单", "apps/api/src/modules/orders/routes.ts"], ["代理端", "apps/api/src/modules/agent-portal/routes.ts"]] as const) {
    assert.match(read(file), /AND: \[EXCLUDE_FCL_ORDER\]/, `${who}要写成 AND，不然会跟已有的 shipments 条件互相覆盖`);
  }
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

if (failures > 0) {
  console.log(`❌ 失败 ${failures} 项`);
  process.exit(1);
}
console.log("✅ 整柜管理：13 项全部通过");
