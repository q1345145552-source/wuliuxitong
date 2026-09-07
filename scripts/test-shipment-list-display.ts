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
      const expected = labels[i] === "总箱数" ? (zero ? "0箱" : "2箱") : labels[i].startsWith("体积") ? (zero ? "0.000" : "1.235") : (zero ? "0.00" : "19.75");
      assert.equal(numbers[i], expected, `${role} ${labels[i]} 取值/精度保持`);
    }
    assert.equal(JSON.stringify(item), before);
  }
});

console.log(`SUMMARY ${passed}/${passed} passed`);
