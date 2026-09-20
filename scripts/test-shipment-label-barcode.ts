/**
 * 运单打印标签 CODE128 回归：执行真实 renderTrackingBarcode / openPrintLabel，
 * SVG 条纹逐模块与实际安装的 JsBarcode 编码对数。仅模拟打印窗口和一次编码异常；
 * 不调用真实打印、不启动服务、不发网络请求、不连接数据库。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

type Row = Record<string, any>;
type Encoding = { data: string };
const printFile = path.resolve('apps/web/src/modules/shipment/ShipmentPrintLabel.tsx');
const barcodeFile = path.resolve('apps/web/src/modules/shipment/trackingBarcode.ts');
const webRequire = createRequire(printFile);
const JsBarcode: (target: { encodings?: Encoding[] }, text: string, options: Row) => unknown = webRequire('jsbarcode');
const forbidden: string[] = [];
function blocked(name: string): never { forbidden.push(name); throw new Error(`FORBIDDEN ${name}`); }
function harness(options: { popupBlocked?: boolean; failEncoding?: boolean } = {}) {
  const events: string[] = [];
  const calls: Array<{ text: string; options: Row }> = [];
  const openCalls: unknown[][] = [];
  let html = '';
  let closes = 0;
  const win = { document: {
    write(value: string) { events.push('write'); html += value; },
    close() { events.push('close'); closes++; },
  } };
  const context = vm.createContext({
    window: { open: (...args: unknown[]) => { events.push('open'); openCalls.push(args); return options.popupBlocked ? null : win; }, print: () => blocked('real-window.print') },
    fetch: () => blocked('fetch'), XMLHttpRequest: function () { blocked('XMLHttpRequest'); },
    document: new Proxy({}, { get(_target, key) { return () => blocked(`document.${String(key)}`); } }),
    setTimeout: () => blocked('setTimeout'), setInterval: () => blocked('setInterval'),
  });
  const cache = new Map<string, Row>();
  function load(file: string): Row {
    const previous = cache.get(file); if (previous) return previous;
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file, compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    }, reportDiagnostics: true });
    assert.deepEqual((code.diagnostics ?? []).filter((entry) => entry.category === ts.DiagnosticCategory.Error), [], `TS syntax: ${file}`);
    const mod: { exports: Row } = { exports: {} }; cache.set(file, mod.exports);
    const requireLocal = (name: string) => {
      if (name === 'jsbarcode') return (target: { encodings?: Encoding[] }, text: string, config: Row) => {
        events.push('encode'); calls.push({ text, options: config });
        if (options.failEncoding) throw new Error('single injected encoding failure');
        return JsBarcode(target, text, config); // 其余用例全部运行真实库，不复制编码实现。
      };
      assert.ok(name.startsWith('.'), `Unexpected dependency: ${name}`);
      const base = path.resolve(path.dirname(file), name);
      const resolved = [`${base}.ts`, `${base}.tsx`].find(existsSync);
      assert.ok(resolved, `Missing local import ${name}`);
      return load(resolved);
    };
    new vm.Script(`(function(exports,require,module){${code.outputText}\n})`, { filename: file }).runInContext(context, { timeout: 1000 })(mod.exports, requireLocal, mod);
    return mod.exports;
  }
  const barcode = load(barcodeFile);
  const print = load(printFile);
  return {
    render: (value: string): string => barcode.renderTrackingBarcode(value),
    open: (props: Row): void => print.openPrintLabel(props),
    html: () => html, events, calls, openCalls, closes: () => closes,
  };
}
function actualEncoding(trackingNo: string): string {
  const result: { encodings?: Encoding[] } = {};
  JsBarcode(result, trackingNo, { format: 'CODE128', displayValue: false });
  const bars = result.encodings?.map((encoding) => encoding.data).join('');
  assert.ok(bars && /^[01]+$/.test(bars), 'Reference JsBarcode did not produce binary CODE128');
  return bars;
}
function attrs(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
}
function closeTo(actual: number, expected: number, label: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${label}: actual=${actual}, expected=${expected}`);
}
/** 不只数 SVG 个数：按黑条位置/宽度恢复条纹，与真实库对照完整 CODE128（含校验和）。 */
function verifySvg(svg: string, trackingNo: string): { moduleWidth: number; width: number } {
  const tag = svg.match(/^<svg\b[^>]*>/)?.[0]; assert.ok(tag, `No complete SVG for ${JSON.stringify(trackingNo)}`);
  assert.ok(svg.endsWith('</svg>'));
  const meta = attrs(tag);
  assert.equal(meta['data-format'], 'CODE128');
  assert.equal(meta.role, 'img');
  assert.ok(meta['aria-label']);
  assert.equal(meta['shape-rendering'], 'crispEdges');
  const width = Number(meta.width), height = Number(meta.height);
  assert.ok(Number.isFinite(width) && width > 0 && width <= 256, 'Barcode must fit existing label width without arbitrary scaling');
  assert.ok(Number.isFinite(height) && height > 0);
  assert.equal(meta.viewBox, `0 0 ${width} ${height}`, 'Physical size and viewBox must not silently shrink modules');
  const rectangles = [...svg.matchAll(/<rect\b[^>]*\/>/g)].map((match) => attrs(match[0]));
  const whites = rectangles.filter((rectangle) => rectangle.fill === '#fff');
  const blacks = rectangles.filter((rectangle) => rectangle.fill === '#000');
  assert.equal(whites.length, 1, 'Exactly one white background is required');
  assert.equal(rectangles.length, whites.length + blacks.length, 'Barcode must be strictly black on white');
  assert.equal(Number(whites[0].width), width); assert.equal(Number(whites[0].height), height);
  assert.equal(Number(whites[0].x ?? 0), 0); assert.equal(Number(whites[0].y ?? 0), 0);
  const expected = actualEncoding(trackingNo);
  const runs = [...expected.matchAll(/1+/g)];
  assert.equal(blacks.length, runs.length, 'Missing/extra black runs');
  const moduleWidth = Number(blacks[0].width) / runs[0][0].length;
  assert.ok(moduleWidth >= 1, `Modules narrower than 1px: ${moduleWidth}`);
  const leftQuiet = Number(blacks[0].x);
  assert.ok(leftQuiet / moduleWidth >= 10, 'Left quiet zone must be >=10 modules');
  const lastBar = blacks.at(-1)!;
  const rightQuiet = width - Number(lastBar.x) - Number(lastBar.width);
  assert.ok(rightQuiet / moduleWidth >= 10 - 1e-8, 'Right quiet zone must be >=10 modules');
  const recovered = Array.from({ length: expected.length }, () => '0');
  for (let i = 0; i < runs.length; i++) {
    const black = blacks[i], run = runs[i];
    closeTo(Number(black.x), leftQuiet + run.index * moduleWidth, `bar ${i} x`);
    closeTo(Number(black.width), run[0].length * moduleWidth, `bar ${i} width`);
    assert.equal(Number(black.y), 4); assert.equal(Number(black.height), 44);
    assert.ok(!('transform' in black) && !('opacity' in black), 'Bars must not be transformed or made transparent');
    const actualStart = (Number(black.x) - leftQuiet) / moduleWidth;
    const actualLength = Number(black.width) / moduleWidth;
    assert.ok(Number.isInteger(actualStart) && Number.isInteger(actualLength), 'Black runs must align to complete modules');
    for (let j = actualStart; j < actualStart + actualLength; j++) recovered[j] = '1';
  }
  assert.equal(recovered.join(''), expected, 'Scanned CODE128 data/checksum must match original tracking number');
  assert.doesNotMatch(svg, /<script\b|<image\b|<img\b|\bsrc=|\bhref=|<text\b|<foreignObject\b/);
  return { moduleWidth, width };
}
function labelBlocks(html: string): string[] {
  const body = html.match(/<body>([\s\S]*?)<script>/)?.[1]; assert.ok(body, 'Actual print HTML body not found');
  return body.split('<div class="label">').slice(1).map((label) => `<div class="label">${label}`);
}
function svgBlocks(html: string): string[] { return [...html.matchAll(/<svg\b[\s\S]*?<\/svg>/g)].map((match) => match[0]); }
function escaped(text: string): string { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
const base = { marks: 'ACCOUNT-MARK-001', packageCount: 1, trackingNo: 'YW000001', itemName: '鞋', productQuantity: 12, transportMode: 'sea' };
const tests: Array<[string, () => void]> = [];
const test = (label: string, body: () => void) => tests.push([label, body]);

for (const trackingNo of ['YW000001', 'yw000001', 'Yw-001-09', '000012345678', 'Ab 001', ' Ab-01 ', 'A<&>"\'']) {
  test(`真实 CODE128 精确编码原值 ${JSON.stringify(trackingNo)}，不改大小写/空格/横杠/前导零`, () => {
    const view = harness(); const svg = view.render(trackingNo); verifySvg(svg, trackingNo);
    assert.equal(view.calls.length, 1); assert.equal(view.calls[0].text, trackingNo);
    assert.equal(view.calls[0].options.format, 'CODE128'); assert.equal(view.calls[0].options.displayValue, false);
  });
}
test('单/多产品标签保留运单号连续及首尾空格，运单文字专用样式不影响其他字段', () => {
  const trackingNo = ' YW  0001379 ';
  for (const multi of [false, true]) {
    const view = harness();
    view.open({ ...base, trackingNo, packageCount: 2,
      ...(multi ? { products: [{ itemName: '鞋', packageCount: 2 }] } : {}) });
    const html = view.html();
    assert.match(html, /\.tracking-no\s*\{\s*white-space:\s*break-spaces;\s*\}/);
    for (const label of labelBlocks(html)) {
      const numbers = [...label.matchAll(/<span class="tracking-no">([^<]*)<\/span>/g)];
      assert.equal(numbers.length, 1, '每张标签仅运单号使用保留空格样式');
      assert.equal(numbers[0][1], trackingNo);
      verifySvg(svgBlocks(label)[0], trackingNo);
    }
    assert.equal(view.calls[0].text, trackingNo, 'CSS修复不能改扫码原值');
  }
});
test('真实库证明大小写、空格和横杠的编码不同，不能用规范化号码冒充原号', () => {
  const numbers = ['YW001', 'yw001', ' YW001 ', 'YW-001', 'YW0001'];
  assert.equal(new Set(numbers.map(actualEncoding)).size, numbers.length);
});
test('1箱真实标签同时保留唛头/运输方式/品名/箱号/单箱数量/运单文字和条码', () => {
  const view = harness(); view.open(base); const html = view.html(); const labels = labelBlocks(html);
  assert.equal(labels.length, 1); assert.equal(svgBlocks(labels[0]).length, 1);
  verifySvg(svgBlocks(labels[0])[0], base.trackingNo);
  for (const text of ['ACCOUNT-MARK-001', '海运', '鞋', '箱号：1/1', '单箱数量：12个', 'YW000001']) assert.ok(labels[0].includes(text), `Missing original label text ${text}`);
  assert.ok(labels[0].indexOf('YW000001') < labels[0].indexOf('<svg'));
  assert.doesNotMatch(html, /湘泰物流网站|\.footer|class="footer"/);
});
test('单产品多箱：每箱一张、条码相同、箱号只在文字中不混进扫码值', () => {
  const view = harness(); view.open({ ...base, packageCount: '3', transportMode: 'land' }); const labels = labelBlocks(view.html());
  assert.equal(labels.length, 3); assert.equal(view.calls.length, 1, 'Same tracking number should encode once per print request');
  labels.forEach((label, index) => {
    assert.ok(label.includes(`箱号：${index + 1}/3`)); assert.ok(label.includes('陆运'));
    assert.ok(label.includes('单箱数量：12个')); assert.ok(label.includes('ACCOUNT-MARK-001'));
    assert.equal(svgBlocks(label).length, 1); verifySvg(svgBlocks(label)[0], base.trackingNo);
  });
  assert.equal(new Set(svgBlocks(view.html())).size, 1);
});
test('多产品多箱：两分支都每张有原文字和同运单条码，产品与箱号对应不变', () => {
  const view = harness(); view.open({ ...base, packageCount: 3, products: [{ itemName: '鞋', packageCount: 2 }, { itemName: '包', packageCount: 1 }] });
  const html = view.html(), labels = labelBlocks(html); assert.equal(labels.length, 3); assert.equal(view.calls.length, 1);
  labels.forEach((label, index) => {
    for (const text of ['ACCOUNT-MARK-001', '海运', base.trackingNo, `箱号：${index + 1}/3`, index < 2 ? '鞋' : '包']) assert.ok(label.includes(text), `Product branch missing ${text}`);
    assert.equal(svgBlocks(label).length, 1); verifySvg(svgBlocks(label)[0], base.trackingNo);
  });
  assert.doesNotMatch(html, /湘泰物流网站|\.footer|class="footer"/);
});
test('空products保持原单产品分支，缺运输方式不擅自打印海运/陆运', () => {
  const view = harness(); view.open({ ...base, products: [], transportMode: undefined });
  assert.equal(labelBlocks(view.html()).length, 1); verifySvg(svgBlocks(view.html())[0], base.trackingNo);
  assert.doesNotMatch(labelBlocks(view.html())[0], /海运|陆运/); assert.ok(view.html().includes('单箱数量：12个'));
});
test('原 packageCount=0 的1张回退行为不因条码变更，条码仍可用', () => {
  const view = harness(); view.open({ ...base, packageCount: 0 }); assert.equal(labelBlocks(view.html()).length, 1); verifySvg(svgBlocks(view.html())[0], base.trackingNo);
});
for (const trackingNo of ['', ' ', '   ', '\t\n']) {
  test(`空白号 ${JSON.stringify(trackingNo)} 明示未提供，不生成错码`, () => {
    const view = harness(); const result = view.render(trackingNo);
    assert.match(result, /class="barcode-warning"/); assert.match(result, /条码未生成.*未提供运单号/);
    assert.doesNotMatch(result, /<svg\b/); assert.equal(view.calls.length, 0);
  });
}
for (const trackingNo of ['运单001', 'ไทย001', 'ＡＢ１２', 'A\u0000B', 'A\nB', 'A\rB', 'A\tB', 'A\u001fB', 'A\u007fB', 'A\u00f1B']) {
  test(`非ASCII/控制或功能码 ${JSON.stringify(trackingNo)} 拒绝编码并有提示`, () => {
    const view = harness(); const result = view.render(trackingNo);
    assert.match(result, /条码未生成.*不支持的字符/); assert.doesNotMatch(result, /<svg\b/); assert.equal(view.calls.length, 0);
  });
}
test('长度>128前置拒绝，不调用库；宽度超限也拒绝而不是缩成不可扫的细条', () => {
  const view = harness(); assert.match(view.render('9'.repeat(129)), /条码未生成.*过长/); assert.equal(view.calls.length, 0);
  const constrained = harness(); assert.match(constrained.render('A'.repeat(30)), /条码未生成.*过长/); assert.equal(constrained.calls.length, 1);
});
test('数字/字母长度1..128真实边界：宽度<=256、左右>=10modules、moduleWidth>=1；否则明确提示', () => {
  let narrow = 0, wide = 0, rejected = 0;
  for (const character of ['A', '9']) for (let length = 1; length <= 128; length++) {
    const trackingNo = character.repeat(length), bits = actualEncoding(trackingNo), result = harness().render(trackingNo);
    if (bits.length + 20 <= 256) {
      const measured = verifySvg(result, trackingNo); if (measured.moduleWidth === 1) narrow++; else wide++;
    } else { assert.match(result, /条码未生成.*过长/); assert.doesNotMatch(result, /<svg\b/); rejected++; }
  }
  assert.ok(narrow && wide && rejected, 'Fixture must exercise both readable module widths and overflow rejection');
});
test('每箱的非法号保留文字且各显示失败提示，不让整张标签消失', () => {
  for (const trackingNo of ['', '运单中文001', 'A\tB', 'A'.repeat(30)]) for (const multi of [false, true]) {
    const view = harness(); view.open({ ...base, trackingNo, packageCount: 2, ...(multi ? { products: [{ itemName: '原品名', packageCount: 2 }] } : {}) });
    const labels = labelBlocks(view.html()); assert.equal(labels.length, 2);
    for (const label of labels) {
      assert.ok(label.includes(escaped(trackingNo))); assert.ok(label.includes('ACCOUNT-MARK-001'));
      assert.match(label, /class="barcode-warning"/); assert.doesNotMatch(label, /<svg\b/);
    }
    assert.equal(view.closes(), 1);
  }
});
test('仅此用例注入库抛错：原标签/运单文字保留，明确提示编码失败', () => {
  const view = harness({ failEncoding: true }); view.open({ ...base, packageCount: 2 }); const labels = labelBlocks(view.html());
  assert.equal(labels.length, 2); assert.equal(view.calls.length, 1);
  for (const label of labels) { assert.ok(label.includes(base.trackingNo)); assert.match(label, /条码未生成.*编码失败/); assert.doesNotMatch(label, /<svg\b/); }
  assert.equal(view.closes(), 1);
});
test('用户文字HTML转义：两分支唛头/品名/运单号不能注入标签或执行脚本', () => {
  const trackingNo = 'A<&>"\'';
  const hostile = '<img src=x onerror="bad()">&END';
  for (const multi of [false, true]) {
    const view = harness(); view.open({ ...base, marks: hostile, itemName: hostile, trackingNo, ...(multi ? { products: [{ itemName: hostile, packageCount: 1 }] } : {}) });
    const html = view.html(); assert.ok(html.includes(escaped(hostile))); assert.ok(html.includes(escaped(trackingNo)));
    assert.doesNotMatch(html, /<img\b|<iframe\b|<script[^>]*src=/); assert.equal((html.match(/<script>/g) ?? []).length, 1);
    verifySvg(svgBlocks(html)[0], trackingNo);
  }
});
test('弹窗被拦直接返回，不调用编码库/打印/文档写入/网络，也不抛错', () => {
  const view = harness({ popupBlocked: true, failEncoding: true }); assert.doesNotThrow(() => view.open(base));
  assert.equal(view.openCalls.length, 1); assert.equal(view.calls.length, 0); assert.equal(view.html(), ''); assert.equal(view.closes(), 0);
  assert.deepEqual(view.events, ['open']);
});
test('真实HTML先含全部SVG再执行print脚本；只有模拟回调，没有图片/CDN/异步等待', () => {
  const view = harness(); view.open({ ...base, packageCount: 3 }); const html = view.html();
  assert.deepEqual(view.openCalls, [['', '_blank', 'width=340,height=520']]);
  assert.deepEqual(view.events, ['open', 'encode', 'write', 'close']);
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]; assert.equal(scripts.length, 1); assert.equal(scripts[0][1], '');
  assert.ok(html.lastIndexOf('</svg>') < html.indexOf('<script>')); assert.equal(svgBlocks(html).length, 3);
  assert.doesNotMatch(html, /<img\b|<image\b|<link\b[^>]*href=|<script\b[^>]*src=|data:image|JsBarcode\(/);
  let simulatedPrints = 0;
  new vm.Script(scripts[0][2]).runInNewContext({ window: { print() {
    simulatedPrints++; assert.equal(svgBlocks(html).length, 3, 'Print called before completed SVGs were available');
    for (const svg of svgBlocks(html)) verifySvg(svg, base.trackingNo);
  } } }, { timeout: 1000 });
  assert.equal(simulatedPrints, 1); assert.equal(view.closes(), 1);
});
test('打印过程中不改唛头、原运单号或产品列表输入', () => {
  const props = { ...base, packageCount: 3, products: [{ itemName: '鞋', packageCount: 2 }, { itemName: '包', packageCount: 1 }] };
  const original = structuredClone(props); Object.freeze(props); props.products.forEach(Object.freeze); Object.freeze(props.products);
  harness().open(props); assert.deepEqual(props, original);
});
// 员工端仅移除占位标签工具，正式运单打印与相邻业务工具必须保留。
// 按 JSX/调用表达式定位真实结构，不把注释或整页偶然出现的文字当作功能存在的证据。
function astNodes<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const matches: T[] = [];
  function visit(node: ts.Node) { if (predicate(node)) matches.push(node); ts.forEachChild(node, visit); }
  visit(root);
  return matches;
}
function readPage(role: 'staff' | 'admin'): ts.SourceFile {
  const file = path.resolve(`apps/web/src/app/${role}/page.tsx`);
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function sectionById(page: ts.SourceFile, id: string): ts.JsxElement {
  const matches = astNodes(page, (node): node is ts.JsxElement => ts.isJsxElement(node) &&
    node.openingElement.tagName.getText(page) === 'section' &&
    node.openingElement.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute) &&
      attribute.name.getText(page) === 'id' && attribute.initializer && ts.isStringLiteral(attribute.initializer) && attribute.initializer.text === id));
  assert.equal(matches.length, 1, `须保留唯一真实 section#${id}`);
  return matches[0];
}
function jsxTexts(node: ts.Node): string[] {
  return astNodes(node, ts.isJsxText).map((text) => text.text.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
function evaluatePageExpression(expression: ts.Expression, page: ts.SourceFile, bindings: Row): any {
  const code = ts.transpileModule(`export function evaluate(ctx: any) {
    const { ${Object.keys(bindings).join(', ')} } = ctx;
    return (${expression.getText(page)});
  }`, { fileName: page.fileName, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as Row };
  new vm.Script(`(function(exports,require,module){${code}\n})`, { filename: page.fileName })
    .runInNewContext({}, { timeout: 1000 })(module.exports, (name: string) => blocked(`unexpected-page-import:${name}`), module);
  return module.exports.evaluate(bindings);
}
test('员工占位标签草稿state与引用已清除，不留下labelDraft/setLabelDraft死代码', () => {
  const page = readPage('staff');
  const obsolete = astNodes(page, (node): node is ts.Identifier => ts.isIdentifier(node) &&
    ['labelDraft', 'setLabelDraft'].includes(node.text));
  assert.equal(obsolete.length, 0, '仅移除占位标签工具时，也须清除它的state声明和引用');
});
test('staff-ops-tools不再挂载占位标签表单/按钮或直接打开打印窗口', () => {
  const page = readPage('staff'), section = sectionById(page, 'staff-ops-tools');
  const texts = jsxTexts(section);
  for (const label of ['标签打印系统', '一键打印标签', 'FBA 标签', '内部箱号条码']) {
    assert.ok(!texts.includes(label), `占位打印UI仍存在：${label}`);
  }
  const popups = astNodes(section, (node): node is ts.CallExpression => ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(page) === 'window' && node.expression.name.text === 'open');
  assert.equal(popups.length, 0, '已移除的占位工具不能仍藏有独立打印弹窗');
});
test('员工工具分区仍可切换显示，体积核算/装柜/拍照UI与业务调用保留', () => {
  const page = readPage('staff'), section = sectionById(page, 'staff-ops-tools');
  const texts = jsxTexts(section);
  for (const label of ['体积重量自动核算', '装柜/排舱管理（Container No.）', '入库拍照（责任留档）', '保存装柜号', '上传入库照片', '查询该运单照片']) {
    assert.ok(texts.includes(label), `误删相邻工具：${label}`);
  }
  const calls = astNodes(section, ts.isCallExpression).map((call) => call.expression.getText(page));
  for (const name of ['setSizeDraft', 'setStaffShipmentContainer', 'uploadStaffInboundPhoto', 'fetchStaffInboundPhotos']) {
    assert.ok(calls.includes(name), `相邻工具接线被删除：${name}`);
  }
  const style = section.openingElement.attributes.properties.find((attribute): attribute is ts.JsxAttribute =>
    ts.isJsxAttribute(attribute) && attribute.name.getText(page) === 'style');
  assert.ok(style?.initializer && ts.isJsxExpression(style.initializer) && style.initializer.expression);
  for (const activeSection of ['staff-ops-tools', 'staff-order-shipment']) {
    const value = evaluatePageExpression(style.initializer.expression, page, { activeSection });
    assert.equal(value.display, activeSection === 'staff-ops-tools' ? 'block' : 'none');
  }
});
for (const role of ['staff', 'admin'] as const) {
  test(`${role}正式运单行打印按钮仍调用真实openPrintLabel，单/多产品每箱原号条码不变`, () => {
    const page = readPage(role);
    const section = sectionById(page, role === 'staff' ? 'staff-order-shipment' : 'orders');
    const imports = astNodes(page, (node): node is ts.ImportDeclaration => ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) && path.resolve(path.dirname(page.fileName), `${node.moduleSpecifier.text}.tsx`) === printFile &&
      !!node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) &&
      node.importClause.namedBindings.elements.some((entry) => entry.name.text === 'openPrintLabel'));
    assert.equal(imports.length, 1, `${role}须继续引用共用正式标签实现`);
    const calls = astNodes(section, (node): node is ts.CallExpression => ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) && node.expression.text === 'openPrintLabel');
    assert.equal(calls.length, 1, `${role}正式运单列表打印入口不能误删或重复`);
    let node: ts.Node | undefined = calls[0];
    while (node && !ts.isJsxAttribute(node)) node = node.parent;
    assert.ok(node && ts.isJsxAttribute(node) && node.name.getText(page) === 'onClick');
    const attribute = node;
    assert.ok(attribute.initializer && ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression);
    const button = attribute.parent.parent.parent;
    assert.ok(ts.isJsxElement(button) && button.openingElement.tagName.getText(page) === 'button');
    assert.ok(jsxTexts(button).includes('打印'));
    for (const multi of [false, true]) {
      const view = harness();
      const row = { ...base, clientId: base.marks, packageCount: 3,
        ...(multi ? { products: [{ itemName: '鞋', packageCount: 2 }, { itemName: '包', packageCount: 1 }] } : {}) };
      const onClick = evaluatePageExpression(attribute.initializer.expression, page, {
        [role === 'staff' ? 'item' : 'o']: row, openPrintLabel: view.open,
      });
      onClick();
      const labels = labelBlocks(view.html());
      assert.equal(labels.length, 3);
      assert.equal(view.calls.length, 1);
      labels.forEach((label, index) => {
        for (const text of [base.marks, base.trackingNo, '海运', `箱号：${index + 1}/3`, multi && index === 2 ? '包' : '鞋']) assert.ok(label.includes(text), `${role}正式打印漏字段 ${text}`);
        verifySvg(svgBlocks(label)[0], base.trackingNo);
      });
    }
  });
}
test('全部测试未尝试真实打印/网络/定时器等副作用', () => assert.deepEqual(forbidden, []));

let passed = 0;
for (const [name, body] of tests) {
  try { body(); passed++; console.log(`PASS ${name}`); }
  catch (error) { process.exitCode = 1; console.error(`FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`); }
}
console.log(`SUMMARY ${passed}/${tests.length} passed; forbidden side effects ${forbidden.length}`);
if (passed !== tests.length || forbidden.length) process.exitCode = 1;
