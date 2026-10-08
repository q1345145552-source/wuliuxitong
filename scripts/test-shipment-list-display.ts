/** 真渲染共享表格组件；主列表省略数量，完整详情及原数据保留。三端页面另做浏览器验收。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const filename = path.resolve("apps/web/src/modules/shipment/ShipmentTableGrid.tsx");
const requireWeb = createRequire(filename);
const output = ts.transpileModule(readFileSync(filename, "utf8"), {
  fileName: filename,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const moduleObject = { exports: {} as Record<string, any> };
vm.runInNewContext("(function(exports,require,module){" + output + "\n})", {}, { filename })(moduleObject.exports, requireWeb, moduleObject);
const grid = moduleObject.exports;
const { createElement } = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const render = (component: any, props: object) => renderToStaticMarkup(createElement("table", null, createElement("tbody", null, createElement("tr", null, createElement(component, props)))));
const cells = (html: string) => [...html.matchAll(/<td\b[^>]*>([^<]*)<\/td>/g)].map((m) => m[1]);
let passed = 0;
function test(name: string, run: () => void) { run(); passed++; console.log("PASS", name); }

test("主列表五列按品名、箱数、尺寸、国内单号、货型排列", () => {
  const rows = [["商品A", "2箱", "123个/箱", "60×40×30cm", "SF001", "商检"]];
  assert.deepEqual(cells(render(grid.ProductListDetailCell, { rows })), ["商品A", "2箱", "60×40×30cm", "SF001", "商检"]);
  assert.equal(grid.PRODUCT_LIST_COL_WIDTHS.length, 5);
  assert.ok(render(grid.ProductListDetailCell, { rows }).includes('colSpan="5"'));
});
test("主列表渲染不修改完整产品明细", () => {
  const rows = [["商品A", "2箱", "123个/箱", "60×40×30cm", "SF001", "商检"]];
  const before = JSON.stringify(rows);
  render(grid.ProductListDetailCell, { rows });
  assert.equal(JSON.stringify(rows), before);
  assert.deepEqual(cells(render(grid.ProductDetailCell, { widths: grid.PRODUCT_DETAIL_COL_WIDTHS, rows })), rows[0]);
  assert.equal(grid.PRODUCT_DETAIL_HEADS[2], "单箱数量");
});
for (const count of [1, 2, 3, 43]) test(`${count}项产品保留全部记录及三行视窗`, () => {
  const rows = Array.from({ length: count }, (_, i) => [`商品${i}`, `${i + 1}箱`, `${i + 10}个/箱`, "1×2×3cm", `SF${i}`, "普货"]);
  const html = render(grid.ProductListDetailCell, { rows });
  assert.equal(cells(html).length, count * 5);
  assert.equal(cells(html).at(-5), `商品${count - 1}`);
  assert.ok(html.includes("height:72px"));
  assert.ok(html.includes(count > 3 ? "overflow-y:auto" : "overflow-y:hidden"));
  assert.ok(html.includes(count > 3 ? "justify-content:flex-start" : "justify-content:center"));
});
test("旧单无产品行仍保留名称及国内单号", () => {
  const rows = grid.buildProductDetailRows({ itemName: "旧商品", domesticTrackingNo: "OLD001", cargoType: "normal" });
  assert.deepEqual(cells(render(grid.ProductListDetailCell, { rows })), ["旧商品", "—", "—", "OLD001", "普货"]);
});
test("货型在主列表及详情显示完整名称，不改存储枚举或产品数据", () => {
  for (const [cargoType, label] of [["normal", "普货"], ["inspection", "商检货"], ["sensitive", "敏感货"]]) {
    assert.equal(grid.cargoTypeLabelOf(cargoType), label);
    for (const products of [undefined, [{ itemName: "货品", cargoType, packageCount: 2 }]]) {
      const item = { itemName: "货品", cargoType, products };
      const before = JSON.stringify(item);
      const rows = grid.buildProductDetailRows(item);
      assert.equal(cells(render(grid.ProductListDetailCell, { rows })).at(-1), label);
      assert.equal(cells(render(grid.ProductDetailCell, { widths: grid.PRODUCT_DETAIL_COL_WIDTHS, rows })).at(-1), label);
      assert.equal(JSON.stringify(item), before);
    }
  }
});
test("原始单箱数量和整票合计不因隐藏列变化", () => {
  const item = { products: [{ itemName: "商品", packageCount: 2, productQuantity: 123, lengthCm: 60, widthCm: 40, heightCm: 30, cargoType: "normal" }], totalVolumeM3: 0.144567, totalWeightKg: 9.8765 };
  const before = JSON.stringify(item);
  render(grid.ProductListDetailCell, { rows: grid.buildProductDetailRows(item) });
  assert.equal(JSON.stringify(item), before);
  assert.equal(grid.buildProductDetailRows(item)[0][2], "123个/箱");
  assert.equal(grid.totalPackageCountOf(item), 2);
  assert.equal(grid.totalVolumeOf(item), 0.144567);
  assert.equal(grid.totalWeightOf(item), 9.8765);
});

test("F03 件数 0 / 空 = 没填：总箱数、产品行箱数、品名都不显示成 0 或空白", () => {
  assert.equal(grid.knownPackageCount(0), null);
  assert.equal(grid.knownPackageCount(null), null);
  assert.equal(grid.knownPackageCount(undefined), null);
  assert.equal(grid.knownPackageCount(-1), null);
  assert.equal(grid.knownPackageCount(Number.NaN), null);
  assert.equal(grid.knownPackageCount(3), 3);
  assert.equal(grid.packageCountText(0, "箱"), "—");
  assert.equal(grid.packageCountText(null, "箱"), "—");
  assert.equal(grid.packageCountText(5, "袋"), "5 袋");
  // 到货通知转待入库：老数据有一条件数 0 的产品行；新数据运单件数 null、订单件数 0、没有产品行
  assert.equal(grid.totalPackageCountOf({ products: [{ itemName: "灯具", packageCount: 0 }], packageCount: 0, totalPackageCount: 0 }), null);
  assert.equal(grid.totalPackageCountOf({ products: [], packageCount: 0, totalPackageCount: 0 }), null);
  assert.equal(grid.totalPackageCountOf({ packageCount: null }), null);
  assert.equal(grid.totalPackageCountOf({ packageCount: undefined, totalPackageCount: undefined }), null);
  assert.equal(JSON.stringify(grid.buildProductDetailRows({ products: [{ itemName: "灯具", packageCount: 0 }] })[0].slice(0, 2)), JSON.stringify(["灯具", "—"]));
  assert.equal(grid.buildProductDetailRows({ itemName: "", cargoType: "normal" })[0][0], "—");
  // 原来正常的数不受影响：拆过柜的父单剩 0 件、子单 30 件 → 整票 30
  assert.equal(grid.totalPackageCountOf({ packageCount: 0, totalPackageCount: 30 }), 30);
  assert.equal(grid.totalPackageCountOf({ products: [{ packageCount: 60 }, { packageCount: 40 }], packageCount: 0, totalPackageCount: 100 }), 100);
});

function classText(node: ts.JsxElement): string {
  const attribute = node.openingElement.attributes.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText() === "className");
  return attribute?.initializer && ts.isStringLiteral(attribute.initializer) ? attribute.initializer.text : "";
}
function nearestTable(node: ts.Node): ts.JsxElement | undefined {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isJsxElement(p) && p.openingElement.tagName.getText() === "table") return p;
  }
}
const utilsFile = ts.createSourceFile("utils.ts", readFileSync("apps/web/src/modules/staff/utils.ts", "utf8"), ts.ScriptTarget.Latest, true);
const formatter = utilsFile.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === "formatMetric");
assert.ok(formatter);
for (const role of ["admin", "staff", "client"]) test(`${role}真实页面的三列数字表头和值共享对齐标记且取值不变`, () => {
  const file = path.resolve(`apps/web/src/app/${role}/page.tsx`);
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const heads: ts.JsxElement[] = [], values: ts.JsxElement[] = [];
  const derived: string[] = [];
  function visit(node: ts.Node) {
    if (role === "client" && ts.isVariableDeclaration(node) && ["totalVolumeM3", "totalWeightKg"].includes(node.name.getText())) derived.push(`const ${node.getText(source)};`);
    if (ts.isJsxElement(node) && classText(node).split(/\s+/).includes("shipment-metric")) {
      const table = nearestTable(node), tag = node.openingElement.tagName.getText();
      if (table && classText(table).split(/\s+/).includes("shipment-ledger-table")) {
        if (tag === "th") heads.push(node);
        if (tag === "td") values.push(node);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(heads.length, 3, `${role}的体积/重量/总箱数表头应全用数字列样式`);
  assert.equal(values.length, 3, `${role}的三列数值应全用同一数字列样式`);
  const expression = (nodes: ts.JsxElement[]) => nodes.map(n => n.getText(source)).join("");
  const compiled = ts.transpileModule(`${formatter.getText(utilsFile)}\n${derived.join("\n")}\nexports.view = <table><thead><tr>${expression(heads)}</tr></thead><tbody><tr>${expression(values)}</tr></tbody></table>;`, {
    fileName: "page-metrics.tsx", compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  for (const zero of [false, true]) {
    const item = { products: [{ packageCount: zero ? 0 : 2 }], packageCount: zero ? 0 : 2, packageUnit: "box", totalVolumeM3: zero ? 0 : 1.23456, totalWeightKg: zero ? 0 : 19.753, volumeM3: 0.001, weightKg: 9.876 };
    const before = JSON.stringify(item), exports: Record<string, any> = {};
    vm.runInNewContext(compiled, { exports, require: requireWeb, ...grid, o: item, item }, { filename: file });
    const html = renderToStaticMarkup(exports.view);
    const text = (tag: string) => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>(.*?)</${tag}>`, "g"))].map(m => m[1].replace(/<[^>]+>/g, "").replace(/\s/g, ""));
    const labels = text("th"), numbers = text("td");
    assert.deepEqual([...labels].sort(), ["体积(m³)", "总箱数", "重量(kg)"].sort());
    for (let i = 0; i < labels.length; i++) {
      // 件数 0 = 没填（2026-10-08 到货通知审查 F03）：显示「—」；体积 / 重量的显式 0 照旧是有效值
      const expected = labels[i] === "总箱数" ? (zero ? "—" : "2箱") : labels[i].startsWith("体积") ? (zero ? "0.000" : "1.235") : (zero ? "0.00" : "19.75");
      assert.equal(numbers[i], expected, `${role} ${labels[i]} 取值/精度保持`);
    }
    assert.equal(JSON.stringify(item), before);
  }
});

test("修复第 1 轮 员工详情件数 / 重量 / 体积按整票（跟列表「总箱数」一致），不显示父单剩余量；没有的给空串", () => {
  // 没产品行、全部装柜：父单剩 0，整票 10
  // 组件在 vm 里跑（另一套 Object 原型），先摊开再比
  assert.deepEqual({ ...grid.shipmentDetailTotalsText({ packageCount: 0, totalPackageCount: 10, weightKg: 0, totalWeightKg: 120, volumeM3: 0, totalVolumeM3: 1.5 }) }, { packageCount: "10", weightKg: "120", volumeM3: "1.5" });
  // 部分装柜：剩 4，整票 10
  assert.equal(grid.shipmentDetailTotalsText({ packageCount: 4, totalPackageCount: 10 }).packageCount, "10");
  // 有产品行 6 + 4，父单剩 4、子单装走 6（整票 10）：跟产品行合计是同一个数
  assert.equal(grid.shipmentDetailTotalsText({ packageCount: 4, totalPackageCount: 10, products: [{ packageCount: 6 }, { packageCount: 4 }] }).packageCount, "10");
  // 有产品行、后端没给整票数：按产品行合计
  assert.equal(grid.shipmentDetailTotalsText({ packageCount: 4, products: [{ packageCount: 6 }, { packageCount: 4 }] }).packageCount, "10");
  // 跟列表同一个函数
  const item = { packageCount: 4, totalPackageCount: 10 };
  assert.equal(grid.shipmentDetailTotalsText(item).packageCount, String(grid.totalPackageCountOf(item)));
  // 待入库没填件数（0 / null）：空串，页面挂「未填」占位
  assert.deepEqual({ ...grid.shipmentDetailTotalsText({ packageCount: 0, totalPackageCount: 0, weightKg: null, volumeM3: null }) }, { packageCount: "", weightKg: "", volumeM3: "" });
});

test("修复第 2 轮 预报单确认收货改了件数（客户报 3 + 4 = 7、实收 9）、产品行没跟着改：详情「总件数」显示实收的 9，不是产品行合计 7", () => {
  // 列表接口给的样子：父单 / 订单 9，totalPackageCount 9，产品行还是客户报的 3 + 4
  const item = { packageCount: 9, totalPackageCount: 9, products: [{ itemName: "玩具", packageCount: 3 }, { itemName: "文具", packageCount: 4 }] };
  assert.equal(grid.shipmentDetailTotalsText(item).packageCount, "9", "详情要显示仓库实收的整票数");
});

test("修复第 3 轮 同一张「产品行合计 7、实收 9」的单：员工列表 / 导出 / 超管列表 / 超管详情（都走 totalPackageCountOf）跟员工详情一样写 9，不再一个 7 一个 9", () => {
  const item = { packageCount: 9, totalPackageCount: 9, products: [{ itemName: "玩具", packageCount: 3 }, { itemName: "文具", packageCount: 4 }] };
  assert.equal(grid.totalPackageCountOf(item), 9, "列表「总箱数」/ 导出「总件数」/ 超管详情「总箱数」要跟详情一样是实收 9（原来按产品行合计写 7）");
  assert.equal(grid.shipmentDetailTotalsText(item).packageCount, String(grid.totalPackageCountOf(item)), "详情和列表同一个数");
  // 产品行那几格照旧是客户报的 3、4（不替人改产品行）
  assert.deepEqual(grid.buildProductDetailRows(item).map((r: string[]) => r[1]), ["3箱", "4箱"]);
  // 没受影响的几类：后端没给整票数（客户端 / 老接口）照旧按产品行；待入库没件数照旧空；拆过柜没产品行照旧整票
  assert.equal(grid.totalPackageCountOf({ packageCount: 9, products: [{ packageCount: 3 }, { packageCount: 4 }] }), 7);
  assert.equal(grid.totalPackageCountOf({ packageCount: null, totalPackageCount: undefined, products: [] }), null);
  assert.equal(grid.shipmentDetailTotalsText({ packageCount: null, totalPackageCount: undefined }).packageCount, "");
  assert.equal(grid.totalPackageCountOf({ packageCount: 0, totalPackageCount: 30, products: [] }), 30);
  // 部分装柜（父单剩 4、子单 6，产品行 6 + 4）：两种算法同一个数
  assert.equal(grid.totalPackageCountOf({ packageCount: 4, totalPackageCount: 10, products: [{ packageCount: 6 }, { packageCount: 4 }] }), 10);
});

test("2026-10-08 袋装的单：产品明细写「袋」不写「箱」（客户端一直写袋，员工 / 超管写死箱，三端对不上）", () => {
  const bag = { packageUnit: "bag", products: [{ itemName: "电饭煲", packageCount: 16, productQuantity: 2 }] };
  // vm 里出来的数组原型不同，按 JSON 比（同本文件上面的写法）
  assert.equal(JSON.stringify(grid.buildProductDetailRows(bag)[0].slice(0, 3)), JSON.stringify(["电饭煲", "16袋", "2个/袋"]));
  assert.equal(JSON.stringify(grid.buildProductDetailRows({ ...bag, packageUnit: "box" })[0].slice(0, 3)), JSON.stringify(["电饭煲", "16箱", "2个/箱"]));
  assert.equal(grid.packageUnitZh("bag"), "袋");
  assert.equal(grid.packageUnitZh(undefined), "箱", "没填按箱（后端默认 box）");
});

console.log(`SUMMARY ${passed}/${passed} passed`);
