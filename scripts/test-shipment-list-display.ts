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
console.log(`SUMMARY ${passed}/${passed} passed`);
