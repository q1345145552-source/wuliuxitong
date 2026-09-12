/** 真路由 + 真页面上传/提交 + XLSX 往返；只有 Prisma 被严格内存桩替换。 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";
process.env.NODE_ENV = "test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { createRequire } from "node:module";
import { parseCargoType } from "../packages/shared-types/cargo-type";

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
  $queryRaw: async (strings: TemplateStringsArray) => {
    assert.match(strings.join("?"), /SELECT id FROM orders .*FOR UPDATE/);
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
async function clientImport(rawCargo: unknown, boxes = 2, dimensions: number[] | undefined = [40,30,20], legacy = false) {
  let workbook: any;
  const xlsx = {...XLSX, writeFile(wb: any) { workbook = wb; }};
  evalTs(sourceFunction(clientFile, "downloadTemplate") + "\nmodule.exports=downloadTemplate;", {XLSX: xlsx})();
  assert.ok(workbook);
  const headers: string[] = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {header: 1})[0].filter((h: string) => !legacy || !h.includes("货型"));
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
      reset(["sensitive", "normal"], "sensitive"); const before = JSON.stringify(rows);
      const response = await api({orderId: "o1", cargoType: wanted});
      assert.equal(response.code, 400); assert.match(response.body.message, /产品.*货型/);
      assert.equal(JSON.stringify(rows), before);
    }
    reset(["inspection", "normal"], "inspection");
    assert.equal((await api({orderId: "o1", cargoType: "inspection"})).code, 200);
  });
  await check("管理员产品增删/缺省货型：保留旧行、重新取最严、不信整票旧值", async () => {
    reset(["inspection", "sensitive"], "sensitive");
    assert.equal((await api({orderId: "o1", cargoType: "normal", products: [{id: "p1", itemName: "鞋", packageCount: 2}, {itemName: "新帽", packageCount: 1}]})).code, 200);
    assert.deepEqual(rows.orderProduct.map(p => p.cargoType), ["inspection", "normal"]);
    assert.equal(rows.order[0].cargoType, "inspection");
    assert.equal((await api({orderId: "o1", products: [{id: "p1", itemName: "鞋", packageCount: 2, cargoType: "normal"}]})).code, 200);
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
      assert.equal(result.requests[0].volumeM3, 40*30*20*boxes/1_000_000);
      assert.equal(result.requests[0].weightKg, 4*boxes); assert.equal(result.requests[0].packageCount, boxes);
      assert.equal(result.requests[0].cargoType, "inspection");
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
  await check("员工/管理员真实模板 XLSX 往返：constructor 拒绝、商检和旧模板可提交", async () => {
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
      for (const value of ["constructor", "商检", "legacy"]) {
        const headers: string[] = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {header:1})[0].filter((h: string) => value !== "legacy" || !h.includes("货型"));
        const values = headers.map(h => {
          if (h.includes("货型")) return value;
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
          else {assert.equal(parsed.issues.length, 0, JSON.stringify(parsed.issues)); assert.equal(parsed.orders[0].cargoType, value === "legacy" ? "normal" : "inspection");}
        } else {
          const requests: Row[] = []; let errors: Row[] = [];
          const handler = sourceNode(file, n => ts.isArrowFunction(n) && n.getText().includes("await createStaffOrder({") && n.getText().includes("setBatchFailures(failures)"));
          await evalTs("module.exports=" + handler + ";", {
            ...cargoModule, batchRows: rawRows, setBatchLoading() {}, setBatchProgress() {},
            setBatchFailures(value: Row[]) {errors = value;}, setBatchDone() {}, setToast() {}, setShowBatchImport() {}, setBatchRows() {}, setBatchConfirmed() {},
            loadOrders: async () => {}, createStaffOrder: async (payload: Row) => {requests.push(JSON.parse(JSON.stringify(payload)));},
          })();
          if (value === "constructor") {assert.equal(requests.length, 0); assert.equal(errors.length, 1); assert.match(errors[0].reason, /constructor/);}
          else {assert.equal(errors.length, 0); assert.equal(requests.length, 1); assert.equal(requests[0].cargoType, value === "legacy" ? "normal" : "inspection");}
        }
      }
    }
  });
  await check("管理员入口权限和合法大小写：员工拒绝；默认空值/大小写与建单一致", async () => {
    reset(); assert.equal((await api({orderId: "o1", cargoType: "sensitive"}, "staff")).code, 403); assert.equal(calls.length, 0);
    for (const [raw, want] of [[" INSPECTION ", "inspection"], ["", "normal"], [null, "normal"]]) {
      reset([]); assert.equal((await api({orderId: "o1", cargoType: raw})).code, 200); assert.equal(rows.order[0].cargoType, want);
    }
  });
  console.log(`SUMMARY ${total - failures.length}/${total} PASS; FAILURES ${failures.length}`);
  if (failures.length) process.exitCode = 1;
}
void main().catch((e) => { console.error(e); process.exitCode = 1; });
