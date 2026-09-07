/** 渲染管理员页面真正挂载的详情 JSX，防止仅测新组件却漏掉页面接线。 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = path.resolve("apps/web/src");
const requireWeb = createRequire(path.join(root, "app/admin/page.tsx"));
const cache = new Map<string, { exports: any }>();
function compile(source: string, filename: string, requireFn: (id: string) => any) {
  const output = ts.transpileModule(source, { fileName: filename, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const module = { exports: {} as any };
  vm.runInNewContext(`(function(exports,require,module){${output}\n})`, {}, { filename })(module.exports, requireFn, module);
  return module.exports;
}
function load(filename: string): any {
  if (cache.has(filename)) return cache.get(filename)!.exports;
  const exported = compile(readFileSync(filename, "utf8"), filename, (id) => {
    if (!id.startsWith(".")) return requireWeb(id);
    const base = path.resolve(path.dirname(filename), id);
    const resolved = [base, base + ".ts", base + ".tsx"].find(existsSync);
    assert.ok(resolved, `Missing import ${id}`);
    return load(resolved);
  });
  cache.set(filename, { exports: exported });
  return exported;
}
const filename = path.join(root, "app/admin/page.tsx"), source = readFileSync(filename, "utf8");
const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const dialogs: ts.JsxElement[] = [];
function visit(node: ts.Node) {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === "DetailModal" &&
    node.openingElement.attributes.properties.some(p => ts.isJsxAttribute(p) && p.name.getText(ast) === "title" && p.initializer && ts.isStringLiteral(p.initializer) && p.initializer.text === "运单详情")) dialogs.push(node);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(dialogs.length, 1, "须定位管理员真正的运单详情弹窗");
const mounted = compile(`export default function Detail(ctx: any) {
 const { o, warehouseOptions, orderImagesCache, DetailModal, AdminShipmentDetail, warehouseLabelFromId, apiBaseUrl, setExpandedOrderId, deleteStaffOrderProductImage, fetchShipmentImages, setOrderImagesCache, uploadStaffOrderProductImage, setToast, setMessage } = ctx;
 return (${dialogs[0].getText(ast)});
}`, "mounted-detail.tsx", requireWeb).default;
const utils = load(path.join(root, "modules/staff/utils.ts"));
const detailPath = path.join(root, "components/admin/AdminShipmentDetail.tsx");
const { createElement } = requireWeb("react"), { renderToStaticMarkup } = requireWeb("react-dom/server");
const product = { id: "p1", itemName: "真实渲染产品", packageCount: 2, productQuantity: 17, lengthCm: 60, widthCm: 40, heightCm: 30, weightKg: 9.8765, domesticTrackingNo: "SF0001", cargoType: "inspection" };
const order = { id: "s1", orderId: "o1", trackingNo: "JL-TEST-01", orderNo: "ORDER0001", clientId: "MARK0001", clientName: "测试唛头", warehouseId: "wh_dongguan_01", currentStatus: "unloading", transportMode: "sea", shipDate: "2026-07-01", createdAt: "2026-07-01T01:00:00Z", packageUnit: "box", packageCount: 2, productQuantity: 34, totalVolumeM3: 1.23456, totalWeightKg: 19.753, volumeM3: 0.1, weightKg: 0.2, itemName: "整单品名", domesticTrackingNo: "ORDER-DOMESTIC", receiverAddressTh: "测试地址", remark: "测试备注", productImages: [], products: [product], batchNo: "NEVER-RENDER-CONTAINER", containerNo: "NEVER-RENDER-CONTAINER", receivableAmountCny: 987654.32 };
function render(overrides: object = {}, images: Record<string, unknown[]> = {}) {
  return renderToStaticMarkup(createElement(mounted, {
    o: { ...order, ...overrides }, warehouseOptions: [{ id: "wh_dongguan_01", label: "东莞仓" }], orderImagesCache: images,
    DetailModal: load(path.join(root, "modules/layout/DetailModal.tsx")).default,
    AdminShipmentDetail: existsSync(detailPath) ? load(detailPath).default : undefined,
    warehouseLabelFromId: utils.warehouseLabelFromId, apiBaseUrl: () => "",
  }));
}
let passed = 0;
function test(name: string, f: () => void) { f(); passed++; console.log("PASS", name); }
const contains = (html: string, values: string[]) => { for (const v of values) assert.ok(html.includes(v), `详情漏显示: ${v}`); };
test("合计名称统一为总箱数，暂不调整重量标签与取值", () => {
  const html = render();
  contains(html, ["<dt>总箱数</dt><dd>2</dd>", "<dt>总重量 (kg)</dt><dd>19.75</dd>", ">重量(kg)</th>", "<td>9.88</td>"]);
  assert.doesNotMatch(html, /总件数|单箱重量\(kg\)/);
});
test("无图片也渲染产品与整票信息，真实页面已挂载", () => {
  contains(render(), ["真实渲染产品", "物流状态", "正在卸柜", "测试唛头", "东莞仓", "海运", "2026-07-01", "ORDER0001", "测试地址", "测试备注", "产品明细", "暂无产品图片"]);
});
test("完整七列产品取值，包括外层已隐藏的单箱数量", () => {
  contains(render(), ["单箱数量", "17个/箱", "2箱", "60×40×30cm", "SF0001", "商检", "9.88"]);
});
test("整票合计优先于剩余值，体积3位重量2位", () => {
  contains(render(), ["1.235", "19.75", "总体积 (m³)", "总重量 (kg)"]);
});
for (const count of [1, 2, 3, 43]) test(`${count}项产品全部展示`, () => {
  const html = render({ products: Array.from({ length: count }, (_, i) => ({ ...product, id: `p${i}`, itemName: `产品_${i}_结束` })) });
  for (let i = 0; i < count; i++) contains(html, [`产品_${i}_结束`]);
  assert.equal((html.match(/个\/箱/g) ?? []).length, count);
});
test("旧单无products时保留品名、国内单号、整单数量及合计", () => {
  contains(render({ products: undefined }), ["整单品名", "ORDER-DOMESTIC", "产品数量", ">34<", "1.235", "19.75"]);
});
test("显式0不当成缺失，空字符串有占位", () => {
  const html = render({ receiverAddressTh: "  ", remark: "", clientName: "", totalWeightKg: 0, totalVolumeM3: 0, products: [{ ...product, packageCount: 0, productQuantity: 0, weightKg: 0 }] });
  contains(html, ["0.000", "0.00", "0个/箱", "0箱", "MARK0001", "<dd>—</dd>"]);
});
test("缺失合计时沿用运单值，不编造产品行重量", () => {
  contains(render({ totalVolumeM3: undefined, totalWeightKg: undefined, products: [{ ...product, weightKg: null }] }), ["0.100", "0.20", "<td>—</td>"]);
});
test("详情不输出柜号字样、容器字段值或普通运单金额", () => {
  assert.doesNotMatch(render(), /柜号|NEVER-RENDER-CONTAINER|987654\.32/);
});
test("海陆/异常/未知/缺失状态沿用共享名称", () => {
  for (const status of ["atPortCn", "borderDelay", "inWarehouseTH", "delivered", "exception", "oldUnknown", undefined]) contains(render({ currentStatus: status, transportMode: "land" }), [utils.shipmentStatusZh(status), "陆运"]);
});
test("已有图片和上传入口仍存在，缓存优先", () => {
  const image = { id: "img1", fileName: "原产品图.png", imageUrl: "/images/fixture.png" };
  contains(render({ productImages: [image] }), ["原产品图.png", "/images/fixture.png"]);
  const html = render({ productImages: [image] }, { o1: [{ ...image, fileName: "新产品图.png" }] });
  contains(html, ["新产品图.png", 'aria-label="上传产品图片"', 'type="file"']);
  assert.ok(!html.includes("原产品图.png"));
});
test("不修改输入对象或现有产品字段", () => {
  const before = JSON.stringify(order); render(); assert.equal(JSON.stringify(order), before);
});
console.log(`SUMMARY ${passed}/${passed} passed`);
