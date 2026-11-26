/** 真路由 + 真页面上传/提交 + XLSX 往返；只有 Prisma 被严格内存桩替换。 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";
process.env.NODE_ENV = "test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { createRequire } from "node:module";
import { CARGO_TYPE_ZH, CARGO_TYPE_HINT, cargoTypeLabel, cargoTypeZh, parseCargoType, strictestCargoType } from "../packages/shared-types/cargo-type";

const failures: string[] = [];
let total = 0;
async function check(name: string, f: () => unknown | Promise<unknown>) {
  total++;
  try { await f(); console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.error(`FAIL ${name}\n${e instanceof Error ? e.stack : e}`); }
}
type Row = Record<string, any>;
const fixtureCompany = "cargo_fixture";
let rows: Record<string, Row[]>;
let calls: string[];
const strict = (name: string, methods: Row) => new Proxy(methods, {
  get(target, key) {
    if (typeof key === "symbol" || key === "then") return undefined;
    if (!(key in target)) throw new Error(`Unimplemented fixture ${name}.${String(key)}`);
    return target[key];
  },
});
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    if (key === "OR") return value.some((w: Row) => matches(row, w));
    if (key === "NOT") return !matches(row, value);
    if (value && typeof value === "object") {
      if (value.in) return value.in.includes(row[key]);
      if (value.notIn) return !value.notIn.includes(row[key]);
      throw new Error(`Unimplemented where ${key}`);
    }
    return row[key] === value;
  });
}
function shaped(row: Row | undefined, select?: Row): Row | null {
  if (!row) return null;
  if (!select) return structuredClone(row);
  return Object.fromEntries(Object.entries(select).filter(([, val]) => val === true).map(([key]) => [key, row[key]]));
}
function model(name: string) {
  function found(args: Row): Row[] { return rows[name].filter(row => matches(row, args.where)); }
  function update(row: Row, data: Row) {
    for (const [key, value] of Object.entries(data)) if (value !== undefined) row[key] = value;
  }
  return strict(name, {
    findFirst: async (a: Row) => { calls.push(`${name}.findFirst`); return shaped(found(a)[0], a.select); },
    findMany: async (a: Row) => { calls.push(`${name}.findMany`); return found(a).map(row => shaped(row, a.select)); },
    update: async (a: Row) => { calls.push(`${name}.update`); const row = found(a)[0]; assert.ok(row); update(row, a.data); return shaped(row, a.select); },
    updateMany: async (a: Row) => { calls.push(`${name}.updateMany`); const list = found(a); list.forEach(row => update(row, a.data)); return {count: list.length}; },
    deleteMany: async (a: Row) => { calls.push(`${name}.deleteMany`); const list = found(a); rows[name] = rows[name].filter(row => !list.includes(row)); return {count: list.length}; },
    create: async (a: Row) => { calls.push(`${name}.create`); const row = {id: `new-${rows[name].length}`, ...a.data}; rows[name].push(row); return shaped(row, a.select); },
  });
}
const prisma: Row = strict("prisma", {
  order: model("order"), shipment: model("shipment"), orderProduct: model("orderProduct"),
  /* 柜内记录（2026-09-24 加）：改单接口现在要查「这张单是不是整柜的」
     （整柜不许把提单号改成柜号、不许改运输方式）。
     这些假数据都是没装过柜的普通单，所以这张表是空的。 */
  shipmentContainerItem: model("shipmentContainerItem"),
  $queryRaw: async (strings: TemplateStringsArray) => {
    assert.match(strings.join("?"), /SELECT id FROM orders .*FOR (NO KEY )?UPDATE/); // 2026-09-28 起编辑订单用 NO KEY UPDATE（不挡装柜插子单的外键检查）
    calls.push("lock:order"); return [{id: "o1"}];
  },
  $transaction: async (callback: (tx: Row) => Promise<any>) => {
    const before = structuredClone(rows);
    try { return await callback(prisma); }
    catch (error) { rows = before; throw error; }
  },
});
(globalThis as any).__prisma = prisma;
function reset(cargo: string[] = ["normal", "normal"], orderCargo = "normal") {
  calls = [];
  rows = {
    order: [{id: "o1", companyId: fixtureCompany, warehouseId: "wh_yiwu_01", cargoType: orderCargo, batchNo: null, domesticTrackingNo: null, receiverAddressTh: "fixture", packageCount: 5, weightKg: 8, volumeM3: 0.05}],
    shipment: [{id: "s1", companyId: fixtureCompany, orderId: "o1", trackingNo: "YW-CARGO", parentTrackingNo: null, currentStatus: "inWarehouseCN", containerNo: null, packageCount: 5, weightKg: 8, volumeM3: 0.05}],
    shipmentContainerItem: [],
    orderProduct: cargo.map((cargoType, i) => ({id: `p${i+1}`, orderId: "o1", companyId: fixtureCompany, itemName: `货品${i+1}`, packageCount: i+2, cargoType, sortOrder: i, weightKg: i+1})),
  };
}
let adminUpdate: any;
async function api(body: Row, role = "admin") {
  const response: Row = {code: 200, body: undefined, requestId: "cargo-test", status(n: number) { this.code = n; return this; }, json(data: Row) { this.body = data; }};
  try { await adminUpdate({body, auth: {role, companyId: fixtureCompany, userId: "admin"}, headers: {}}, response); }
  catch (error) {
    const { isBusinessError } = await import("../apps/api/src/modules/core/business-error");
    if (!isBusinessError(error)) throw error;
    response.code = error.httpStatus; response.body = {message: error.message};
  }
  return response;
}
const root = process.cwd();
const localRequire = createRequire(path.join(root, "package.json"));
const XLSX = localRequire(path.join(root, "apps/web/node_modules/xlsx"));
const clientFile = "apps/web/src/app/client/imports/page.tsx";
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
function evalTs(source: string, context: Row = {}, filename = "fixture.ts"): any {
  const exports = {};
  const sandbox = {exports, module: {exports}, console, setTimeout, clearTimeout, AbortController, ...context};
  vm.runInNewContext(ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX}, fileName: filename}).outputText, sandbox, {filename});
  return sandbox.module.exports;
}
function sourceNode(file: string, predicate: (node: ts.Node) => boolean): string {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let selected: ts.Node | undefined;
  const walk = (node: ts.Node) => { if (!selected && predicate(node)) selected = node; if (!selected) node.forEachChild(walk); };
  walk(source); assert.ok(selected, `Missing real source node: ${file}`); return selected.getText(source);
}
function sourceFunction(file: string, name: string): string {
  return sourceNode(file, node => ts.isFunctionDeclaration(node) && node.name?.text === name);
}
function treeNodes(tree: any): any[] {
  if (Array.isArray(tree)) return tree.flatMap(treeNodes);
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...treeNodes(tree.props?.children)];
}
async function clientImport(rawCargo: unknown, boxes = 2, dimensions: number[] | undefined = [40,30,20], legacy = false, cargoHeaderName?: string) {
  let workbook: any;
  const xlsx = {...XLSX, writeFile(wb: any) { workbook = wb; }};
  evalTs(sourceFunction(clientFile, "downloadTemplate") + "\nmodule.exports=downloadTemplate;", {XLSX: xlsx})();
  assert.ok(workbook);
  const downloadedHeaders: string[] = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {header: 1})[0];
  assert.equal(downloadedHeaders.find(h => h.includes("货型")), "货型（普货/商检货/敏感货/特货，默认普货）");
  const headers: string[] = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {header: 1})[0]
    .filter((h: string) => !legacy || !h.includes("货型"))
    // 换成别的货型表头（比如 10-11～10-16 下载的旧模板那句）
    .map((h: string) => (cargoHeaderName && h.includes("货型") ? cargoHeaderName : h));
  const values = headers.map(h => {
    if (h.includes("货型")) return rawCargo;
    if (h.includes("仓库")) return "义乌仓";
    if (h.includes("品名")) return "测试货品";
    if (h.includes("箱数")) return boxes;
    if (h.includes("单箱重量")) return 4;
    if (h.includes("长cm")) return dimensions?.[0] ?? "";
    if (h.includes("宽cm")) return dimensions?.[1] ?? "";
    if (h.includes("高cm")) return dimensions?.[2] ?? "";
    if (h.includes("运输方式")) return "海运";
    return "";
  });
  workbook.Sheets[workbook.SheetNames[0]] = XLSX.utils.aoa_to_sheet([headers, values]);
  const buffer = XLSX.write(workbook, {type: "buffer", bookType: "xlsx"});
  const states: any[] = []; let cursor = 0; const requests: Row[] = [];
  const cargo = evalTs(read("packages/shared-types/cargo-type.ts"));
  const service = evalTs(sourceFunction("apps/web/src/services/business-api.ts", "createClientPrealert"), {
    apiBaseUrl: () => "http://fixture.invalid", authHeaders: () => ({}),
    // 批量下单那一行带请求编号时加 30 秒超时（2026-10-18），用的是同文件的这个常量
    STAFF_ORDER_TIMEOUT_MS: 30_000,
    fetch: async (_url: string, init: Row) => { requests.push(JSON.parse(init.body)); return {data: {prealertId: "p1"}}; },
    parseApiResponse: async (response: Row) => response.data,
  });
  const hooks = {
    useState(initial: any) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial; return [states[i], (next: any) => states[i] = typeof next === "function" ? next(states[i]) : next]; },
    useRef(initial: any) { const i = cursor++; if (!(i in states)) states[i] = {current: initial}; return states[i]; },
    useMemo(callback: () => any) { return callback(); },
  };
  const jsx = (type: any, props: any) => ({type, props});
  const component = evalTs(read(clientFile), {require(name: string) {
    if (name === "react") return hooks;
    if (name === "react/jsx-runtime") return {jsx, jsxs: jsx};
    if (name === "xlsx") return XLSX;
    if (name.endsWith("/RoleShell")) return {default: "RoleShell"};
    if (name.endsWith("/request-gate")) return evalTs(read("apps/web/src/modules/shared/request-gate.ts"));
    if (name.endsWith("/cargo-type")) return cargo;
    if (name.endsWith("/business-api")) return service;
    // 2026-09-29：读表格那段挪进了这个模块，照样用真代码
    // 2026-10-18：没确认的行的请求编号记在本标签页（沙箱里没有 window，等于存不了，照样跑真代码）
    // 2026-10-18 审查第 1 轮：记号按客户分（文件键前面带唛头）
    if (name.endsWith("/auth/auth-session")) return {getOptionalSession: () => ({userId: "C1"})};
    if (name.endsWith("/client-import/pending-requests")) return evalTs(read("apps/web/src/modules/client-import/pending-requests.ts"), {}, "apps/web/src/modules/client-import/pending-requests.ts");
    if (name.endsWith("/client-import/import-rows")) return evalTs(read("apps/web/src/modules/client-import/import-rows.ts"), {require(n: string) {
      if (n.endsWith("/cargo-type")) return cargo;
      throw new Error(`Unimplemented frontend require ${n}`);
    }}, "apps/web/src/modules/client-import/import-rows.ts");
    throw new Error(`Unimplemented frontend require ${name}`);
  }}, clientFile).default;
  const render = () => { cursor = 0; return component(); };
  const input = treeNodes(render()).find(n => n.type === "input" && n.props.type === "file"); assert.ok(input);
  await input.props.onChange({target: {files: [{arrayBuffer: async () => buffer}], value: "fixture.xlsx"}});
  const submit = treeNodes(render()).find(n => n.type === "button" && n.props.children === "一键提交批量下单"); assert.ok(submit);
  if (!submit.props.disabled) await submit.props.onClick();
  const outputDir = process.env.CARGO_TEST_ARTIFACTS;
  if (outputDir) { fs.mkdirSync(outputDir, {recursive: true}); fs.writeFileSync(path.join(outputDir, `client-${legacy ? "legacy" : String(rawCargo)}-${boxes}.xlsx`), buffer); }
  return {disabled: submit.props.disabled, requests};
}
async function main() {
  await check("货型统一全称，旧简称/新全称输入映射相同且最严口径不变", () => {
    // 2026-10-11 加特别货（老板：「新增一个货型，叫特别货」；混装排最严，他回「按建议」）
    // 2026-10-16 老板「特别货改成特货吧」：显示一律「特货」，导入时「特货」「特别货」「特别」都认
    assert.deepEqual(CARGO_TYPE_ZH, {normal: "普货", inspection: "商检货", sensitive: "敏感货", special: "特货"});
    assert.equal(cargoTypeLabel(["normal", "inspection", "sensitive", "inspection", "special"]), "普货 / 商检货 / 敏感货 / 特货");
    assert.equal(cargoTypeZh("special"), "特货");
    assert.equal(CARGO_TYPE_HINT, "货型只能填「普货」「商检货」「敏感货」「特货」之一，留空按普货");
    for (const [raw, value] of [["商检", "inspection"], ["商检货", "inspection"], ["敏感", "sensitive"], ["敏感货", "sensitive"], ["特货", "special"], [" 特 货 ", "special"], ["特别", "special"], ["特别货", "special"], ["ＳＰＥＣＩＡＬ", "special"]]) {
      assert.equal(parseCargoType(raw)?.value, value);
    }
    assert.equal(strictestCargoType(["normal", "inspection", "sensitive", "special"]), "special", "特别货最严");
    assert.equal(strictestCargoType(["special", "normal"]), "special");
    assert.equal(strictestCargoType(["normal", "inspection", "sensitive"]), "sensitive");
    assert.equal(strictestCargoType(["normal", "inspection"]), "inspection");
  });
  await check("2026-10-16「特别货」改叫「特货」：代码里（不算注释）只剩两处故意留的旧叫法 —— 导入认旧写法、旧模板表头照认", () => {
    // 用 TypeScript 自己的词法把注释换成空格，只看真代码 / 页面文字 / 提示语
    const blankComments = (text: string, fileName: string): string => {
      const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const ranges: Array<[number, number]> = [];
      const visit = (node: ts.Node): void => {
        for (const r of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) ranges.push([r.pos, r.end]);
        for (const r of ts.getTrailingCommentRanges(text, node.getEnd()) ?? []) ranges.push([r.pos, r.end]);
        for (const child of node.getChildren(sf)) visit(child);
      };
      visit(sf);
      const chars = text.split("");
      for (const [a, b] of ranges) for (let i = a; i < b; i += 1) if (chars[i] !== "\n") chars[i] = " ";
      return chars.join("");
    };
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(e.name)) files.push(rel);
      }
    };
    // 扫的范围：apps/api/src、apps/web/src、packages 下的 .ts / .tsx（页面文字、提示、导出都在这里；模板 xlsx、mobile、静态页里没有货型字样，另查过）
    for (const d of ["apps/api/src", "apps/web/src", "packages"]) walk(d);
    assert.ok(files.length > 100, `只扫到 ${files.length} 个文件，扫描写窄了`);
    // 只盯「特别货」这个词（通用词「特别」以后正常文案会用到，不能一刀切禁掉 —— dsh / Codex 第 2 轮）
    const hits: Record<string, number> = {};
    for (const rel of files) {
      const text = fs.readFileSync(path.join(root, rel), "utf8");
      if (!text.includes("特别货")) continue;
      const n = (blankComments(text, rel).match(/特别货/g) ?? []).length;
      if (n > 0) hits[rel.split(path.sep).join("/")] = n;
    }
    assert.deepEqual(hits, {
      "packages/shared-types/cargo-type.ts": 1,      // 别名表：旧写法「特别货」照认
      "apps/web/src/modules/fcl/template.ts": 2,     // 整柜模板：值「特别货」照认 + 10-11～10-16 的旧表头照认
    }, "页面 / 提示 / 导出里又写回了「特别货」（老板 10-16 定了叫「特货」）");
    // 原来简写成「特别」的四处（代理价 / 返现），各自钉住现在的写法（剥了注释再看）
    const code = (rel: string): string => blankComments(fs.readFileSync(path.join(root, rel), "utf8"), rel);
    for (const [rel, snippet] of [
      ["apps/web/src/components/agent/agent-ui.tsx", "` / 特货 ${p.special}`"],
      ["apps/web/src/components/agent/AgentRebates.tsx", '{ key: "special", label: "特货" }'],
      ["apps/web/src/components/admin/agents/AgentRebatesPanel.tsx", '["special", "特货"]'],
      ["apps/web/src/app/admin/agents/page.tsx", "· 特货 {priceText(a.prices.special)}"],
    ] as const) {
      assert.ok(code(rel).includes(snippet), `${rel}：特货的简写不对（应是「${snippet}」）`);
    }
  });
  await check("货型别名只接受自有键，继承属性及其他非法值全部拒绝", () => {
    for (const raw of ["constructor", "__proto__", "toString", "hasOwnProperty", "invalid", {}, true, 1]) {
      assert.equal(parseCargoType(raw), null, String(raw));
    }
    for (const [raw, value] of [["商检", "inspection"], ["ＳＥＮＳＩＴＩＶＥ", "sensitive"], [" 普 通 ", "normal"], ["", "normal"]]) {
      assert.equal(parseCargoType(raw)?.value, value);
    }
  });
  const { registerAdminRoutes } = await import("../apps/api/src/modules/admin/routes");
  registerAdminRoutes({get() {}, delete() {}, post(url: string, handler: any) { if (url === "/admin/orders/update") adminUpdate = handler; }} as any);
  assert.ok(adminUpdate);
  await check("管理员实际改单入口：非法整票/产品货型 400，查询写入之前拦截", async () => {
    for (const raw of ["made-up", "constructor", "商检", true, {}, ["normal"]]) {
      for (const body of [{orderId: "o1", cargoType: raw}, {orderId: "o1", products: [{id: "p1", itemName: "鞋", packageCount: 2, cargoType: raw}]}]) {
        reset(); const before = JSON.stringify(rows);
        const response = await api(body);
        assert.equal(response.code, 400, `raw=${JSON.stringify(raw)} ${JSON.stringify(response.body)}`);
        assert.equal(JSON.stringify(rows), before);
        assert.deepEqual(calls, []);
      }
    }
  });
  await check("管理员改产品：锁内按保存后的完整产品集重算整票，数字不变", async () => {
    reset(); const originalShipment = JSON.stringify(rows.shipment);
    const response = await api({orderId: "o1", products: [{id: "p1", itemName: "鞋", packageCount: 2, cargoType: "sensitive"}, {id: "p2", itemName: "帽", packageCount: 3}]});
    assert.equal(response.code, 200); assert.equal(rows.order[0].cargoType, "sensitive");
    assert.deepEqual(rows.orderProduct.map(p => p.cargoType), ["sensitive", "normal"]);
    assert.equal(rows.order[0].packageCount, 5); assert.equal(rows.order[0].weightKg, 8); assert.equal(rows.order[0].volumeM3, 0.05);
    const savedShipment = {...rows.shipment[0]}; delete savedShipment.updatedAt;
    assert.equal(JSON.stringify([savedShipment]), originalShipment);
    assert.ok(calls.indexOf("orderProduct.findMany") > calls.indexOf("lock:order"), calls.join(" → "));
  });
  await check("管理员仅改整票：有明细且最严不一致时 400，保持所有旧值", async () => {
    for (const wanted of ["normal", "inspection"]) {
      reset(["sensitive", "sensitive"], "sensitive"); const before = JSON.stringify(rows);
      const response = await api({orderId: "o1", cargoType: wanted});
      assert.equal(response.code, 400); assert.match(response.body.message, /在产品行修改货型/);
      // 页面上现在走不到这句，会碰到的是还开着 11-24～11-26 那版页面的人（产品行没有货型那一格）：得告诉他刷新
      assert.match(response.body.message, /刷新页面/);
      assert.equal(JSON.stringify(rows), before);
    }
    // 产品行只有一种、整票发的就是它：照常放行（混着几种的见下一条）
    reset(["inspection", "inspection"], "inspection");
    assert.equal((await api({orderId: "o1", cargoType: "inspection"})).code, 200);
    assert.deepEqual(rows.orderProduct.map(p => p.cargoType), ["inspection", "inspection"]);
  });
  /* 2026-11-26 货型改回「每条产品行各选各的」：11-24～11-26 线上那版（一票一个货型）的页面没刷新时，
     打开混着几种货型的单一保存就带整票货型、产品行一动每行都发成整票那一个 —— 照存会把同事分开选的货型改成同一种。
     老页面在混着的单上，这次只要带了整票货型或产品行就存不成功（dsh 第 1 轮：老弹窗存成功一次就不再带整票货型，之后改产品行就认不出来了）；
     完全不碰货型的（只改备注）照常存 */
  await check("没刷新的老页面碰上混着几种货型的单：拦住叫刷新、锁后才读、读完没写；现在的页面和直接调接口的不受影响", async () => {
    const sameRows = (cargoType?: string) => [{id: "p1", itemName: "鞋", packageCount: 9, ...(cargoType ? {cargoType} : {})}, {id: "p2", itemName: "帽", packageCount: 3, ...(cargoType ? {cargoType} : {})}];
    const WRITES = ["order.update", "order.updateMany", "shipment.update", "shipment.updateMany", "orderProduct.update", "orderProduct.updateMany", "orderProduct.create", "orderProduct.deleteMany"];
    /** 被拦住的这一次：400 + 叫刷新；库里订单 / 运单 / 产品行一个字没变；读产品行在锁订单之后；拦之前一句写库的都没有 */
    const blocked = async (body: Row, label: string) => {
      reset(["normal", "sensitive"], "sensitive"); const before = JSON.stringify(rows);
      const response = await api(body);
      assert.equal(response.code, 400, `${label} ${JSON.stringify(response.body)}`);
      assert.match(response.body.message, /不是最新的.*刷新页面/, label);
      assert.equal(JSON.stringify(rows), before, `${label}：被拦住的这次订单 / 运单 / 产品行一个字都不能写`);
      assert.ok(calls.indexOf("lock:order") >= 0 && calls.indexOf("orderProduct.findMany") > calls.indexOf("lock:order"), `${label}：要先锁订单再读产品行 ${calls.join(" → ")}`);
      assert.deepEqual(calls.filter(c => WRITES.includes(c)), [], `${label}：要先拦后写，不能写了再靠回滚 ${calls.join(" → ")}`);
    };
    // 老页面改产品行：带整票货型 + 每条产品行都发整票那一个；库里这票是 普货 + 敏感货
    await blocked({orderId: "o1", cargoType: "sensitive", products: sameRows("sensitive")}, "老页面改产品行");
    // 老页面把整票换成库里没有的那种（特货）再动产品行
    await blocked({orderId: "o1", cargoType: "special", products: sameRows("special")}, "老页面换整票货型又改产品行");
    // 老页面没动产品行（只改备注 / 什么都没改就存）：带的整票货型刚好等于最严那个 —— 也得拦，
    // 不然这一次存成功，老弹窗下一次改产品行就不带整票货型了，上面两句拦不到
    await blocked({orderId: "o1", cargoType: "sensitive", remark: "只改了备注"}, "老页面只改备注");
    await blocked({orderId: "o1", cargoType: "sensitive", products: []}, "老页面空产品行");
    // 老页面只把整票货型改成另一个
    await blocked({orderId: "o1", cargoType: "normal"}, "老页面只改整票货型");
    // 先核版本号、后拦（dsh 第 2 轮）：版本号过期的老页面该看到的是「刚刚被别人改过」那句 409，而且这时还没去读产品行
    reset(["normal", "sensitive"], "sensitive"); rows.order[0].updatedAt = new Date("2026-11-26T00:00:00.000Z"); // 这份假数据平时不带版本号，这条要比版本号
    { const before = JSON.stringify(rows);
      const stale = await api({orderId: "o1", cargoType: "sensitive", products: sameRows("sensitive"), expectedOrderUpdatedAt: "2000-01-01T00:00:00.000Z"});
      assert.equal(stale.code, 409, JSON.stringify(stale.body)); assert.match(stale.body.message, /刚刚被别人改过/);
      assert.equal(JSON.stringify(rows), before); assert.ok(!calls.includes("orderProduct.findMany"), `版本号对不上就不该再去读产品行 ${calls.join(" → ")}`); }
    // 库里有认不出来的老货型值（dsh 第 2 轮）：混着的照样拦，给的是「请刷新页面」而不是「货型不合法」
    reset(["futureType", "sensitive"], "sensitive");
    { const before = JSON.stringify(rows);
      const r = await api({orderId: "o1", cargoType: "sensitive", products: sameRows("sensitive")});
      assert.equal(r.code, 400); assert.match(r.body.message, /不是最新的.*刷新页面/); assert.equal(JSON.stringify(rows), before); }
    // 库里只有一种、但那一种认不出来：带产品行的照 11-23 的规矩「写完再校验」，这次把它盖成合法的就能存，不能提前报错
    reset(["futureType", "futureType"], "normal");
    assert.equal((await api({orderId: "o1", cargoType: "sensitive", products: sameRows("sensitive")})).code, 200);
    assert.deepEqual(rows.orderProduct.map(p => p.cargoType), ["sensitive", "sensitive"]); assert.equal(rows.order[0].cargoType, "sensitive");
    // 同样的库、只改整票（不带产品行）：照 11-23 的规矩当场报「货型不合法」，一个字不写
    reset(["futureType", "futureType"], "normal");
    { const before = JSON.stringify(rows);
      const r = await api({orderId: "o1", cargoType: "sensitive"});
      assert.equal(r.code, 400); assert.match(r.body.message, /不合法/); assert.equal(JSON.stringify(rows), before); }
    // 没带标记、也没带整票货型，每行发成同一种（Codex 第 3 轮 / dsh 第 4 轮）：库里是 普货 + 认不出来的老值 / 大小写不一样的 / 空串 时，
    // 那版页面把它们都当普货、以为只有一种，改产品行时不带整票货型、每行发普货 —— 照样得拦，不能把原来的值悄悄盖掉
    for (const stored of [["normal", "futureType"], ["normal", "NORMAL"], ["normal", ""], ["normal", "sensitive"]]) {
      reset(stored, "sensitive"); const before = JSON.stringify(rows);
      const r = await api({orderId: "o1", products: sameRows("normal")});
      assert.equal(r.code, 400, `库里 ${JSON.stringify(stored)}：${JSON.stringify(r.body)}`); assert.match(r.body.message, /不是最新的.*刷新页面/);
      assert.equal(JSON.stringify(rows), before, `库里 ${JSON.stringify(stored)}：被拦住的这次一个字都不能写`);
      assert.deepEqual(calls.filter(c => WRITES.includes(c)), [], `要先拦后写 ${calls.join(" → ")}`);
    }
    // 删到只剩一行、那一行明写着货型（没带标记）：也是「发来的全是同一种」，库里不止一种就拦（11-24 之前的页面这么做会被叫去刷新，有意的取舍）
    reset(["normal", "sensitive"], "sensitive");
    assert.equal((await api({orderId: "o1", products: [{id: "p1", itemName: "鞋", packageCount: 9, cargoType: "normal"}]})).code, 400);
    assert.equal(rows.orderProduct.length, 2);
    // 现在的页面（带 cargoPerRow: true）：把认不出来的那个值改成普货 / 特意把两行都改成敏感货 / 删到只剩一行 → 照常存
    reset(["normal", "futureType"], "sensitive");
    assert.equal((await api({orderId: "o1", cargoPerRow: true, products: sameRows("normal")})).code, 200);
    assert.deepEqual(rows.orderProduct.map(p => p.cargoType), ["normal", "normal"]); assert.equal(rows.order[0].cargoType, "normal");
    reset(["normal", "sensitive"], "sensitive");
    assert.equal((await api({orderId: "o1", cargoPerRow: true, products: [{id: "p1", itemName: "鞋", packageCount: 9, cargoType: "normal"}]})).code, 200);
    assert.equal(rows.orderProduct.length, 1); assert.equal(rows.order[0].cargoType, "normal");
    // 带了标记、只发整票货型（直接调接口）：不按老页面拦，照 11-23 的老规矩 —— 等于最严的放行、对不上的 400
    reset(["normal", "sensitive"], "sensitive");
    assert.equal((await api({orderId: "o1", cargoPerRow: true, cargoType: "sensitive"})).code, 200);
    assert.deepEqual(rows.orderProduct.map(p => p.cargoType), ["normal", "sensitive"]);
    { const r = await api({orderId: "o1", cargoPerRow: true, cargoType: "normal"}); assert.equal(r.code, 400); assert.match(r.body.message, /在产品行修改货型/); }
    // cargoPerRow 不是 true（写成 "true" / 1 / false）不算标记
    for (const fake of ["true", 1, false]) {
      reset(["normal", "sensitive"], "sensitive");
      assert.equal((await api({orderId: "o1", cargoPerRow: fake, products: sameRows("sensitive")})).code, 400, `cargoPerRow=${JSON.stringify(fake)} 不该算标记`);
    }
    // 现在的页面：带标记、不带整票货型，特意把两行都改成敏感货 → 照常存
    reset(["normal", "sensitive"], "sensitive");
    assert.equal((await api({orderId: "o1", cargoPerRow: true, products: sameRows("sensitive")})).code, 200);
    assert.deepEqual(rows.orderProduct.map(p => p.cargoType), ["sensitive", "sensitive"]); assert.equal(rows.orderProduct[0].packageCount, 9);
    // 现在的页面：不带整票货型，只改备注 → 照常存，产品行不动、也不去读产品行
    reset(["normal", "sensitive"], "sensitive");
    assert.equal((await api({orderId: "o1", cargoPerRow: true, remark: "现在的页面只改备注"})).code, 200);
    assert.deepEqual(rows.orderProduct.map(p => p.cargoType), ["normal", "sensitive"]); assert.ok(!calls.includes("orderProduct.findMany"));
    // 没带标记、不碰货型的（11-24 之前就开着的页面 / 直接调接口，只改备注或收货地址）：混着的单上也照常存，产品行不动、也不去读产品行（dsh 第 5 轮）
    // （改运单号那条路要查到货通知，这份假数据库没有那张表，这里不测；它跟货型拦截不相干）
    for (const body of [{remark: "没带标记只改备注"}, {receiverAddressTh: "Bangkok"}, {remark: "空产品行", products: []}]) {
      reset(["normal", "sensitive"], "sensitive");
      const r = await api({orderId: "o1", ...body});
      assert.equal(r.code, 200, `${JSON.stringify(body)} ${JSON.stringify(r.body)}`);
      assert.deepEqual(rows.orderProduct.map(p => p.cargoType), ["normal", "sensitive"]); assert.ok(!calls.includes("orderProduct.findMany"), `${JSON.stringify(body)}：不碰货型就不该去读产品行`);
    }
    // 老页面碰上本来就只有一种货型的单：改箱数、连货型一起换，照常存（老页面在这种单上跟现在的页面没区别）
    reset(["normal", "normal"], "normal");
    assert.equal((await api({orderId: "o1", cargoType: "inspection", products: sameRows("inspection")})).code, 200);
    assert.deepEqual(rows.orderProduct.map(p => p.cargoType), ["inspection", "inspection"]); assert.equal(rows.order[0].cargoType, "inspection");
    // 带了整票货型、但产品行各写各的（直接调接口的）：不是老页面的样子，照原来的规矩存、整票记最严
    reset(["normal", "sensitive"], "sensitive");
    assert.equal((await api({orderId: "o1", cargoType: "sensitive", products: [{id: "p1", itemName: "鞋", packageCount: 2, cargoType: "inspection"}, {id: "p2", itemName: "帽", packageCount: 3, cargoType: "sensitive"}]})).code, 200);
    assert.deepEqual(rows.orderProduct.map(p => p.cargoType), ["inspection", "sensitive"]); assert.equal(rows.order[0].cargoType, "sensitive");
    // 带了整票货型、产品行没写货型（直接调接口的老用法）：各行保留原来的，不拦
    reset(["normal", "sensitive"], "sensitive");
    assert.equal((await api({orderId: "o1", cargoType: "sensitive", products: sameRows()})).code, 200);
    assert.deepEqual(rows.orderProduct.map(p => p.cargoType), ["normal", "sensitive"]);
    // 只有一行明写了货型、另一行没写：也不是老页面的样子（老页面每行都写），不拦
    reset(["normal", "sensitive"], "sensitive");
    assert.equal((await api({orderId: "o1", cargoType: "sensitive", products: [{id: "p1", itemName: "鞋", packageCount: 2, cargoType: "sensitive"}, {id: "p2", itemName: "帽", packageCount: 3}]})).code, 200);
    assert.deepEqual(rows.orderProduct.map(p => p.cargoType), ["sensitive", "sensitive"]);
  });
  await check("现在的两个改单页面都带 cargoPerRow: true（后端靠它认现在的页面），也不发整票货型", async () => {
    const fs = await import("node:fs"); const path = await import("node:path");
    const web = path.join(__dirname, "../apps/web/src");
    const read = (rel: string) => fs.readFileSync(path.join(web, rel), "utf8");
    // 调 /admin/orders/update 的只有这两个页面（另一个是接口封装自己）；多出来一个调用方就得回来看它发不发整票货型
    const callers: string[] = [];
    const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e.name) && /updateAdminOrder\(|admin\/orders\/update/.test(fs.readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""))) callers.push(path.relative(web, full));
    } };
    walk(web);
    assert.deepEqual(callers.sort(), ["modules/arrival-notice/ArrivalNoticesView.tsx", "modules/orders/WaybillEditDialog.tsx", "services/business-api.ts"]);
    // 编辑运单弹窗：整票货型没有输入的地方（没有哪一句往表单里写 cargoType），所以「改了才发」那一项永远不发
    const dialog = read("modules/orders/WaybillEditDialog.tsx").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    // 往表单里写 cargoType 的 setForm（回调写成 (v) => ({...}) 或 v => ({...}) 都算）。先拿几句真写法试一下这句正则自己认不认得出来（dsh 第 2 轮：上一版一句都认不出来，等于没钉）
    const writesFormCargo = /setForm\((?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\(?\{[^}]*\bcargoType\b/;
    for (const sample of ["setForm((v) => ({ ...v, cargoType: e.target.value }))", "setForm((f) => ({ ...f, cargoType: v }))", "setForm(v => ({ ...v, itemName: x, cargoType: y }))"]) assert.match(sample, writesFormCargo);
    assert.doesNotMatch("setForm((v) => ({ ...v, batchNo: e.target.value }))", writesFormCargo);
    assert.doesNotMatch(dialog, writesFormCargo, "编辑运单弹窗里有地方改整票货型了：先改后端「没刷新的老页面」那段");
    assert.doesNotMatch(dialog, /aria-label="货型"/, "编辑运单弹窗上面那排又有整票货型了：先改后端「没刷新的老页面」那段");
    assert.match(dialog, /aria-label=\{`第\$\{i \+ 1\}行 货型`\}/, "产品行上的货型下拉不见了");
    // 到货通知「修改已转运单」：发给改单接口的那份里没有整票货型这一项
    const patch = /export interface AdminOrderPatch \{([\s\S]*?)\n\}/.exec(read("modules/arrival-notice/converted-edit.ts").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""));
    assert.ok(patch, "找不到 AdminOrderPatch");
    assert.doesNotMatch(patch![1], /^\s*cargoType\??:/m, "到货通知改已转运单又发整票货型了：先改后端「没刷新的老页面」那段");
    // 两个页面都带 cargoPerRow: true（后端把没带的当成没刷新的老页面）；请求类型里写成必填的 true，以后多一个调用方漏带编译就不过
    assert.match(read("services/business-api.ts").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""), /export async function updateAdminOrder\(payload: \{\s*orderId: string;\s*cargoPerRow: true;/, "改单接口的请求类型里 cargoPerRow 不是必填的 true");
    assert.match(dialog, /await updateAdminOrder\(\{\s*orderId: saveOrderId,\s*\.\.\.\(snapshot\?\.orderUpdatedAt \? \{ expectedOrderUpdatedAt: snapshot\.orderUpdatedAt \} : \{\}\),\s*cargoPerRow: true,/, "编辑运单弹窗保存时没带 cargoPerRow: true");
    // 到货通知改已转运单：拼请求的函数自己带上（算完 changed 之后，不算改动）—— 照页面流程跑的连库测试拿到的也是带标记的
    const convertedEdit = read("modules/arrival-notice/converted-edit.ts").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.match(convertedEdit, /const changed = Object\.keys\(patch\)\.length > 1;[\s\S]{0,160}?if \(changed\) patch\.cargoPerRow = true;\s*return \{ patch, changed \};/, "buildAdminOrderPatch 没在算完 changed 之后带上 cargoPerRow");
    const noticeView = read("modules/arrival-notice/ArrivalNoticesView.tsx").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const noticeCalls = [...noticeView.matchAll(/updateAdminOrder\(([^;]*)\);/g)].map((m) => m[1]);
    assert.ok(noticeCalls.length >= 1 && noticeCalls.every((c) => /cargoPerRow: true/.test(c)), `到货通知改已转运单有一处没带 cargoPerRow: true：${noticeCalls.join(" | ")}`);
  });
  await check("管理员产品增删/缺省货型：保留旧行、重新取最严、不信整票旧值", async () => {
    reset(["inspection", "sensitive"], "sensitive");
    assert.equal((await api({orderId: "o1", cargoType: "normal", products: [{id: "p1", itemName: "鞋", packageCount: 2}, {itemName: "新帽", packageCount: 1}]})).code, 200);
    assert.deepEqual(rows.orderProduct.map(p => p.cargoType), ["inspection", "normal"]);
    assert.equal(rows.order[0].cargoType, "inspection");
    // 删到只剩一行、货型改成普货：库里这时是 商检货 + 普货 两种，现在的页面带 cargoPerRow 才不会被当成没刷新的老页面（2026-11-26）
    assert.equal((await api({orderId: "o1", cargoPerRow: true, products: [{id: "p1", itemName: "鞋", packageCount: 2, cargoType: "normal"}]})).code, 200);
    assert.equal(rows.orderProduct.length, 1); assert.equal(rows.order[0].cargoType, "normal");
  });
  await check("管理员旧无产品单、仅改备注和空 products 沿用增量契约", async () => {
    reset([], "sensitive"); assert.equal((await api({orderId: "o1", cargoType: "inspection"})).code, 200);
    assert.equal(rows.order[0].cargoType, "inspection"); assert.equal(rows.orderProduct.length, 0);
    reset(["sensitive"], "normal"); const before = JSON.stringify(rows.orderProduct);
    assert.equal((await api({orderId: "o1", remark: "只改备注", products: []})).code, 200);
    assert.equal(rows.order[0].cargoType, "normal"); assert.equal(JSON.stringify(rows.orderProduct), before);
    assert.ok(!calls.includes("orderProduct.findMany"));
  });
  await check("管理员 27 种三产品组合的最严货型与全部产品逐行一致", async () => {
    const types = ["normal", "inspection", "sensitive"];
    for (const a of types) for (const b of types) for (const c of types) {
      reset(); const values = [a,b,c];
      assert.equal((await api({orderId: "o1", products: values.map((cargoType, i) => ({itemName: `品名${i}`, packageCount: 2, cargoType}))})).code, 200);
      assert.deepEqual(rows.orderProduct.map(p => p.cargoType), values);
      assert.equal(rows.order[0].cargoType, types[Math.max(...values.map(v => types.indexOf(v)))]);
    }
  });
  await check("客户端真模板→XLSX上传→真提交序列化：体积乘箱数、重量仍是整票", async () => {
    for (const boxes of [1,2,7]) {
      const result = await clientImport("商检", boxes);
      assert.equal(result.disabled, false); assert.equal(result.requests.length, 1);
      // 真上传 → 真提交：每行带一个合后端格式的请求编号（2026-10-18，重交时服务器认得出来）
      assert.match(String(result.requests[0].requestId), /^[A-Za-z0-9-]{16,64}$/, "批量下单提交没带请求编号");
      assert.equal(result.requests[0].volumeM3, 40*30*20*boxes/1_000_000);
      assert.equal(result.requests[0].weightKg, 4*boxes); assert.equal(result.requests[0].packageCount, boxes);
      assert.equal(result.requests[0].cargoType, "inspection");
    }
  });
  await check("客户端真模板上传保留新旧货型中文与英文枚举兼容", async () => {
    // 2026-10-16「特别货」改叫「特货」：新叫法、旧叫法、简写、英文都认
    for (const [raw, expected] of [["商检", "inspection"], ["商检货", "inspection"], ["敏感", "sensitive"], ["敏感货", "sensitive"], ["inspection", "inspection"], ["sensitive", "sensitive"], ["特货", "special"], ["特别货", "special"], ["特别", "special"], ["special", "special"]]) {
      const result = await clientImport(raw);
      assert.equal(result.disabled, false);
      assert.equal(result.requests.length, 1);
      assert.equal(result.requests[0].cargoType, expected);
      assert.equal(result.requests[0].packageCount, 2);
      assert.equal(result.requests[0].weightKg, 8);
      assert.equal(result.requests[0].volumeM3, 0.048);
    }
    // 10-11～10-16 下载的旧模板：货型表头写着「特别货」，填新旧写法都照样认（新表头 + 旧写法在上面的循环里）
    for (const raw of ["特别货", "特货"]) {
      const oldHeader = await clientImport(raw, 2, [40,30,20], false, "货型（普货/商检货/敏感货/特别货，默认普货）");
      assert.equal(oldHeader.disabled, false, raw);
      assert.equal(oldHeader.requests.length, 1, raw);
      assert.equal(oldHeader.requests[0].cargoType, "special", raw);
    }
  });
  await check("客户端真实提交入口：constructor/普通非法值均禁用，老模板和空尺寸仍可用", async () => {
    for (const raw of ["constructor", "invalid"]) {
      const result = await clientImport(raw); assert.equal(result.disabled, true); assert.equal(result.requests.length, 0);
    }
    const legacy = await clientImport("", 2, undefined, true);
    assert.equal(legacy.requests.length, 1); assert.equal(legacy.requests[0].cargoType, "normal");
    const noDimensions = await clientImport("sensitive", 2, []);
    assert.equal(noDimensions.requests.length, 1); assert.equal(noDimensions.requests[0].volumeM3, undefined);
    assert.equal(noDimensions.requests[0].weightKg, 8);
  });
  await check("超管批量导入：仓库 / 包装单位 / 运输方式写中文换成内部值；没填照旧；认不出来这一行失败、不发请求（2026-10-14 全系统审查）", async () => {
    const cargoModule = await import("../packages/shared-types/cargo-type");
    const staffModule = await import("../apps/web/src/modules/staff/batchOrderImport");
    const handler = sourceNode("apps/web/src/app/admin/page.tsx", n => ts.isArrowFunction(n) && n.getText().includes("await createStaffOrder({") && n.getText().includes("setBatchFailures(failures)"));
    const run = async (rows: Row[]) => {
      const requests: Row[] = []; let errors: Row[] = [];
      await evalTs("module.exports=" + handler + ";", {
        ...cargoModule, ...staffModule, batchRows: rows, setBatchLoading() {}, setBatchProgress() {}, beijingToday: () => "2026-10-15",
        setBatchFailures(value: Row[]) {errors = value;}, setBatchDone() {}, setToast() {}, setShowBatchImport() {}, setBatchRows() {}, setBatchConfirmed() {},
        // 「停止导入」（2026-10-18 全系统审查）：这里不停，只把循环要用的补上
        batchStopRef: { current: false }, setBatchStopping() {}, setBatchStoppedAt() {},
        loadOrders: async () => {}, createStaffOrder: async (payload: Row) => {requests.push(JSON.parse(JSON.stringify(payload)));},
      })();
      return { requests, errors };
    };
    const base = { "客户ID": "fixture_client", "品名": "鞋", "箱数": 2, "运单号": "YW-FIXTURE", "到仓日期": "2026-10-14" };
    const pick = (r: Row) => [r.warehouseId, r.packageUnit, r.transportMode];
    const zh = await run([{ ...base, "仓库ID": "深圳仓", "包装单位": "袋", "运输方式": "陆运" }]);
    assert.equal(zh.errors.length, 0, JSON.stringify(zh.errors));
    assert.deepEqual(pick(zh.requests[0]), ["wh_shenzhen_01", "bag", "land"], "中文没换成内部值（原来原样发，「陆运」存进库按海运流程走）");
    const codes = await run([{ ...base, "仓库ID": "wh_dongguan_01", "包装单位": "box", "运输方式": "sea" }]);
    const spaced = await run([{ ...base, "仓库ID": "义乌", "包装单位": " BAG ", "运输方式": " 陆 " }]);
    assert.deepEqual(pick(spaced.requests[0]), ["wh_yiwu_01", "bag", "land"], "准确写法带空格 / 大写 / 简写要照认");
    assert.deepEqual(pick(codes.requests[0]), ["wh_dongguan_01", "box", "sea"]);
    const blank = await run([{ ...base }]);
    assert.deepEqual(pick(blank.requests[0]), ["wh_yiwu_01", "box", "sea"], "表里没这三列：照旧当义乌仓 / 箱 / 海运");
    const empty = await run([{ ...base, "仓库ID": "", "包装单位": "", "运输方式": "" }]);
    assert.deepEqual(pick(empty.requests[0]), ["", "box", ""], "格子空着：仓库、运输方式不许猜（交给后端报缺少必填项），包装单位当箱");
    // 真表格：表头有这几列、这一行没填过的格子在 xlsx 里根本没有（不是空字符串）。页面读表必须带 defval: ""，
    // 不然这几格整个不出现在行里，跟「老模板没这一列」分不清，被悄悄当成义乌仓 / 海运（Codex 第 3 轮）
    const adminSrc = fs.readFileSync(path.join(process.cwd(), "apps/web/src/app/admin/page.tsx"), "utf8");
    assert.match(adminSrc, /const rows = XLSX\.utils\.sheet_to_json<any>\(ws, \{ defval: "" \}\);/, "超管批量导入读表没带 defval: \"\"");
    const sheet = XLSX.utils.aoa_to_sheet([["客户ID", "仓库ID", "品名", "箱数", "包装单位", "运输方式", "到仓日期", "运单号"], ["fixture_client", null, "鞋", 2, null, null, null, "YW-FIXTURE"]]);
    const reread = XLSX.read(XLSX.write({ SheetNames: ["s"], Sheets: { s: sheet } }, { type: "buffer", bookType: "xlsx" }), { type: "buffer" });
    const parsed: Row[] = XLSX.utils.sheet_to_json(reread.Sheets.s, { defval: "" });
    const real = await run(parsed);
    assert.deepEqual(pick(real.requests[0]), ["", "box", ""], "真表格里没填的仓库 / 运输方式被当成了默认值");
    assert.equal(real.requests[0].arrivedAt, "2026-10-15", "到仓日期空着应该照旧当今天");
    // 两个合法词都带的不许猜（Codex 第 7 轮：原来「陆运/海运」被猜成海运、「袋/箱」猜成袋）
    for (const [key, value, re] of [["仓库ID", "杭州仓", /仓库填的是「杭州仓」/], ["包装单位", "桶", /包装单位填的是「桶」/], ["运输方式", "空运", /运输方式填的是「空运」/],
      ["运输方式", "海运/陆运", /运输方式填的是「海运\/陆运」/], ["运输方式", "陆运/海运", /运输方式填的是/], ["运输方式", "海运陆运", /运输方式填的是/], ["包装单位", "袋/箱", /包装单位填的是「袋\/箱」/], ["包装单位", "箱袋", /包装单位填的是/]] as Array<[string, string, RegExp]>) {
      const r = await run([{ ...base, [key]: value }]);
      assert.equal(r.requests.length, 0, `${key}填「${value}」照样发了请求`);
      assert.equal(r.errors.length, 1);
      assert.match(r.errors[0].reason, re);
    }
  });

  await check("员工/管理员真实模板 XLSX 往返：全称表头、新旧货型兼容、constructor 拒绝", async () => {
    const cargoModule = await import("../packages/shared-types/cargo-type");
    const staffModule = await import("../apps/web/src/modules/staff/batchOrderImport");
    for (const role of ["staff", "admin"]) {
      const file = `apps/web/src/app/${role}/page.tsx`;
      const name = role === "staff" ? "downloadStaffBatchTemplate" : "downloadAdminBatchTemplate";
      let workbook: any;
      const xlsx = {...XLSX, writeFile(wb: any) {workbook = wb;}};
      const warehouseOptions = evalTs("const " + sourceNode("apps/web/src/app/admin/page.tsx", n => ts.isVariableDeclaration(n) && n.name.getText() === "warehouseOptions") + "; module.exports=warehouseOptions;");
      await evalTs(sourceFunction(file, name) + `\nmodule.exports=${name};`, {
        XLSX: xlsx, require(name: string) {assert.equal(name, "xlsx"); return xlsx;}, warehouseOptions,
        batchTemplateDownloading: false, setBatchTemplateDownloading() {}, setMessage() {}, setToast() {},
      })();
      assert.ok(workbook);
      const downloadedHeaders: string[] = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {header:1})[0];
      const cargoHeader = downloadedHeaders.find(h => h.includes("货型"));
      assert.ok(cargoHeader);
      assert.doesNotMatch(cargoHeader, /商检(?!货)|敏感(?!货)/);
      // 2026-10-16「特别货」改叫「特货」：新旧叫法都认；员工模板还要认 10-11～10-16 的旧表头（写着特别货）。管理员模板表头就是「货型」两个字，没有新旧之分
      const SPECIAL_VALUES = ["特货", "特别货", "特别", "special"];
      const cases = ["constructor", "商检", "商检货", "敏感", "敏感货", "inspection", "sensitive", "legacy", ...SPECIAL_VALUES, ...(role === "staff" ? ["oldHeader", "oldHeaderNewValue"] : [])];
      if (role === "staff") assert.equal(cargoHeader, "货型（普货/商检货/敏感货/特货，默认普货）");
      for (const value of cases) {
        const expected = value === "legacy" ? "normal" : ["敏感", "敏感货", "sensitive"].includes(value) ? "sensitive" : [...SPECIAL_VALUES, "oldHeader", "oldHeaderNewValue"].includes(value) ? "special" : "inspection";
        const headers: string[] = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {header:1})[0]
          .filter((h: string) => value !== "legacy" || !h.includes("货型"))
          .map((h: string) => (value.startsWith("oldHeader") && h.includes("货型") ? "货型（普货/商检货/敏感货/特别货，默认普货）" : h));
        const values = headers.map(h => {
          if (h.includes("货型")) return value === "oldHeader" ? "特别货" : value === "oldHeaderNewValue" ? "特货" : value;
          if (h.includes("唛头") || h === "客户ID") return "fixture_client";
          if (h.includes("运单号")) return "YW-FIXTURE";
          if (h.includes("仓库")) return role === "admin" ? "wh_yiwu_01" : "义乌仓";
          if (h.includes("品名")) return "测试鞋";
          if (h.includes("箱数")) return 2;
          if (h.includes("单箱重量")) return 4;
          if (h.includes("日期")) return "2026-09-12";
          if (h.includes("运输方式")) return role === "admin" ? "sea" : "海运";
          if (h.includes("包装")) return role === "admin" ? "box" : "箱";
          return "";
        });
        const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, values]), "fixture");
        const buffer = XLSX.write(wb, {type:"buffer", bookType:"xlsx"});
        const reopened = XLSX.read(buffer, {type:"buffer"});
        const rawRows = XLSX.utils.sheet_to_json(reopened.Sheets.fixture, {defval:""});
        if (process.env.CARGO_TEST_ARTIFACTS) fs.writeFileSync(path.join(process.env.CARGO_TEST_ARTIFACTS, `${role}-${value}.xlsx`), buffer);
        if (role === "staff") {
          const parsed = staffModule.parseStaffBatchRows(rawRows);
          if (value === "constructor") {assert.equal(parsed.orders.length, 0); assert.ok(parsed.issues.some(issue => issue.message.includes("constructor")));}
          else {assert.equal(parsed.issues.length, 0, JSON.stringify(parsed.issues)); assert.equal(parsed.orders[0].cargoType, expected);}
        } else {
          const requests: Row[] = []; let errors: Row[] = [];
          const handler = sourceNode(file, n => ts.isArrowFunction(n) && n.getText().includes("await createStaffOrder({") && n.getText().includes("setBatchFailures(failures)"));
          await evalTs("module.exports=" + handler + ";", {
            // 仓库 / 包装 / 运输方式的中文换内部值（2026-10-14）用的是员工批量导入那几个函数
            ...cargoModule, ...staffModule, batchRows: rawRows, setBatchLoading() {}, setBatchProgress() {},
            setBatchFailures(value: Row[]) {errors = value;}, setBatchDone() {}, setToast() {}, setShowBatchImport() {}, setBatchRows() {}, setBatchConfirmed() {},
            batchStopRef: { current: false }, setBatchStopping() {}, setBatchStoppedAt() {},
            loadOrders: async () => {}, createStaffOrder: async (payload: Row) => {requests.push(JSON.parse(JSON.stringify(payload)));},
          })();
          if (value === "constructor") {assert.equal(requests.length, 0); assert.equal(errors.length, 1); assert.match(errors[0].reason, /constructor/);}
          else {assert.equal(errors.length, 0); assert.equal(requests.length, 1); assert.equal(requests[0].cargoType, expected);}
        }
      }
    }
  });
  // 2026-10-19 老板「给员工加权限」：员工也能改运单（这条改单路放开给员工），客户 / 代理照旧拒
  await check("管理员入口权限和合法大小写：客户 / 代理拒绝；默认空值/大小写与建单一致", async () => {
    for (const role of ["client", "agent"]) { reset(); assert.equal((await api({orderId: "o1", cargoType: "sensitive"}, role)).code, 403); assert.equal(calls.length, 0); }
    for (const [raw, want] of [[" INSPECTION ", "inspection"], ["", "normal"], [null, "normal"]]) {
      reset([]); assert.equal((await api({orderId: "o1", cargoType: raw})).code, 200); assert.equal(rows.order[0].cargoType, want);
    }
  });
  console.log(`SUMMARY ${total - failures.length}/${total} PASS; FAILURES ${failures.length}`);
  if (failures.length) process.exitCode = 1;
}
void main().catch((e) => { console.error(e); process.exitCode = 1; });
