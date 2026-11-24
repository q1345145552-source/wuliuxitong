/**
 * 一票只有一个货型（2026-11-24 老板：「改一下逻辑，一票只会有一个货型，不能单独产品选择货型」）—— 不连库。
 *
 *   O1 共用那几个函数：去重、混着几种时的那句话、打开时整票显示哪个
 *   O2 后端 readOneCargoType：产品行填了的不止一种就拦；只有一种就是它（整票那格不看）；都没填看整票；都没填 explicit=false
 *   O3 编辑运单弹窗打开时：整票货型按产品行算（混着的取最严）；混着的老单「打开时的样子」里货型记成空串（随便存一次就统一）
 *   O4 到货通知草稿 → 请求：整票那个发到填了东西的每一款，空白那款发普货；老草稿按最严
 *   O5 到货通知改已转正式运单：没动货型不发；改了发；打开时混着几种的也发；产品行动了每款都是整票那个；同事改了货型比得出来
 *   O6 页面上（编辑运单、员工两套建单、超管建单、客户预报、到货通知、整柜）都只剩整票一个货型下拉，产品行上没有
 *   O7 后端四个入口（客户预报、员工建单、超管改单、到货通知保存）和整柜都过一票一个货型那道闸；转运单统一成一个
 *   O8 整柜传表格的货型（fclSheetCargo）：旧表头、表头带空格也认；几行不一样 / 认不出来报第几行（dsh 11-24 第 1 轮）
 *   O9 整柜真表格的行号（fclSheetRows）：中间整行空行、表头上面空行、真文件写读、整列刷过格式只读到有字的地方（dsh 第 2、3 轮）
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { distinctCargoTypes, mixedCargoTypeIssue, waybillCargoTypeOf } from "../packages/shared-types/cargo-type";
import { readOneCargoType } from "../apps/api/src/modules/orders/cargo-read";
import { waybillEditStateOf } from "../apps/web/src/modules/orders/waybill-edit-state";
import { draftToBody, noticeCargoTypeOf, type ArrivalNoticeDraft, type DraftProduct } from "../apps/web/src/services/arrival-notice-api";
import { buildAdminOrderPatch, sameConvertedDraft } from "../apps/web/src/modules/arrival-notice/converted-edit";
import { FCL_TEMPLATE_HEADERS, fclRowFromSheet, fclSheetCargo, fclSheetRows } from "../apps/web/src/modules/fcl/template";
import { createRequire } from "node:module";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
// xlsx 装在网页那边（同 test-cargo-regressions 的引法）
const XLSX: any = createRequire(__filename)(path.join(ROOT, "apps/web/node_modules/xlsx"));

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; console.log(`❌ ${name}\n   ${(e instanceof Error ? e.message : String(e)).split("\n").join("\n   ")}`); }
}

check("O1 共用函数：去重（认不出来按普货）、混着几种的那句话、打开时整票显示哪个", () => {
  assert.deepEqual(distinctCargoTypes(["sensitive", "normal", "sensitive", "商检", null, " INSPECTION "]), ["sensitive", "normal", "inspection"]);
  assert.equal(mixedCargoTypeIssue([]), null);
  assert.equal(mixedCargoTypeIssue(["special", "special"]), null);
  assert.equal(mixedCargoTypeIssue(["normal", "sensitive"]), "一票只能有一个货型，现在这票的产品里有「普货」「敏感货」2 种");
  assert.equal(waybillCargoTypeOf(["normal", "sensitive", "inspection"], "normal"), "sensitive", "混着的老单取最严（跟原来整票记的同一个）");
  assert.equal(waybillCargoTypeOf(["inspection", "inspection"], "normal"), "inspection", "产品行都一样、订单记的不一样（9-10 前的老数据）：跟产品行（列表上显示的就是它）");
  assert.equal(waybillCargoTypeOf([], "special"), "special", "没有产品行看订单自己的");
  assert.equal(waybillCargoTypeOf([], null), "normal");
  assert.equal(waybillCargoTypeOf([], "乱写"), "normal");
});

check("O2 后端 readOneCargoType：填了的不止一种拦下（叫他刷新）；只有一种就是它；都没填看整票；都没填不算说了", () => {
  const mixed = readOneCargoType("normal", [{ cargoType: "sensitive" }, { cargoType: "normal" }]);
  assert.ok("error" in mixed && /一票只能有一个货型/.test(mixed.error) && /刷新/.test(mixed.error), JSON.stringify(mixed));
  // 老页面：整票那格一直发默认的 normal、产品行才是真选的 → 跟产品行
  assert.deepEqual(readOneCargoType("normal", [{ cargoType: "sensitive" }, { cargoType: "sensitive" }]), { order: "sensitive", explicit: true });
  // 空着的产品行跟着填了的那行
  assert.deepEqual(readOneCargoType(undefined, [{ cargoType: "inspection" }, {}, { cargoType: "" }]), { order: "inspection", explicit: true });
  // 产品行都没填：整票那个
  assert.deepEqual(readOneCargoType("special", [{}, {}]), { order: "special", explicit: true });
  assert.deepEqual(readOneCargoType("special", undefined), { order: "special", explicit: true });
  // 什么都没说
  assert.deepEqual(readOneCargoType(undefined, [{}]), { order: "normal", explicit: false });
  assert.deepEqual(readOneCargoType("", undefined), { order: "normal", explicit: false });
  // 认不出来的值照旧 400（不许静默当普货）
  for (const bad of ["商检", "made-up", true]) {
    const r1 = readOneCargoType(bad, undefined);
    const r2 = readOneCargoType(undefined, [{ cargoType: bad as any }]);
    assert.ok("error" in r1 && "error" in r2, `${String(bad)} 没拦住`);
  }
  // 产品行不是对象：照旧中文报错不 500
  assert.ok("error" in readOneCargoType(undefined, [null as any]));
  assert.ok("error" in readOneCargoType(undefined, "x" as any));
});

check("O3 编辑运单弹窗打开时：整票货型按产品行算；混着几种的老单列出来，「打开时的样子」里货型记空串（存一次就统一）；不混的照表单抄", () => {
  const base = { id: "s1", orderId: "o1", trackingNo: "T1", cargoType: "normal" };
  const mixed = waybillEditStateOf({ ...base, products: [{ id: "p1", itemName: "灯", packageCount: 1, cargoType: "normal" }, { id: "p2", itemName: "鞋", packageCount: 2, cargoType: "sensitive" }] as any });
  assert.equal(mixed.form.cargoType, "sensitive");
  assert.deepEqual(mixed.mixedCargo, ["normal", "sensitive"]);
  assert.equal(mixed.snapshot.form.cargoType, "");
  assert.equal(mixed.snapshot.form.trackingNo, "T1", "别的项照表单抄");
  const one = waybillEditStateOf({ ...base, products: [{ id: "p1", itemName: "灯", packageCount: 1, cargoType: "inspection" }] as any });
  assert.equal(one.form.cargoType, "inspection", "产品行商检、订单记普货的老单：显示产品行的（列表上就是这个）");
  assert.equal(one.mixedCargo, null);
  assert.equal(one.snapshot.form.cargoType, "inspection", "不混的「打开时的样子」照表单抄：没动货型就不发");
  const none = waybillEditStateOf({ ...base, cargoType: "special", products: [] });
  assert.equal(none.form.cargoType, "special");
  assert.equal(none.mixedCargo, null);
});

const dp = (o: Partial<DraftProduct>): DraftProduct => ({
  key: "k", itemName: "", packageCount: "", lengthCm: "", widthCm: "", heightCm: "", productQuantity: "", weightKg: "", domesticTrackingNo: "", cargoType: "normal", ...o,
});
const draft = (o: Partial<ArrivalNoticeDraft>): ArrivalNoticeDraft => ({
  clientId: "A", trackingNo: "T", weightKg: "", volumeM3: "", transportMode: "sea", warehouseId: "wh_yiwu_01", arrivedAt: "2026-11-24", remark: "", products: [dp({})], ...o,
});

check("O4 到货通知草稿 → 请求：整票那个发到填了东西的每一款（各款原来存的不算），空白那款发普货；老草稿（没有整票那一项）按最严", () => {
  const b = draftToBody(draft({ cargoType: "special", products: [dp({ itemName: "灯", cargoType: "normal" }), dp({}), dp({ itemName: "鞋", cargoType: "sensitive" })] }));
  assert.deepEqual(b.products.map((p) => p.cargoType), ["special", "normal", "special"]);
  assert.equal(b.cargoType, "special", "给旧后端的镜像也是这一个");
  const old = draftToBody(draft({ products: [dp({ itemName: "灯", cargoType: "inspection" }), dp({ itemName: "鞋", cargoType: "normal" })] }));
  assert.deepEqual(old.products.map((p) => p.cargoType), ["inspection", "inspection"]);
  assert.equal(noticeCargoTypeOf(draft({ products: [dp({ cargoType: "sensitive" })] })), "normal", "只有货型、别的都空的那款算空白，不算进整票");
  // 「打开时的样子」（base）照库里原样发：后端拿它跟库里逐款比，统一了的话混着的老通知一存就被当成「同事改过」
  const mixedBase = draft({ cargoType: "sensitive", products: [dp({ itemName: "灯", cargoType: "normal" }), dp({ itemName: "鞋", cargoType: "sensitive" })] });
  assert.deepEqual(draftToBody(mixedBase, { rowCargoAsStored: true }).products.map((p) => p.cargoType), ["normal", "sensitive"]);
  assert.match(read("apps/web/src/services/arrival-notice-api.ts"), /base: draftToBody\(base, \{ rowCargoAsStored: true \}\)/, "保存时 base 要照库里原样发");
});

check("O5 到货通知改已转正式运单：没动货型不发；改了发；打开时混着的也发；产品行动了每款都是整票那个；同事改了货型比得出来", () => {
  const rows = (a: string, b: string) => [dp({ key: "a", orderProductId: "op1", itemName: "灯", packageCount: "2", cargoType: a as any }), dp({ key: "b", orderProductId: "op2", itemName: "鞋", packageCount: "3", cargoType: b as any })];
  const base = draft({ cargoType: "inspection", products: rows("inspection", "inspection") });
  // 只改了备注：货型、产品行都不发
  const r0 = buildAdminOrderPatch("s1", base, { ...base, remark: "新备注" });
  assert.equal(r0.patch.cargoType, undefined); assert.equal(r0.patch.products, undefined);
  // 改了整票货型：发货型，产品行没动就不整份发（不顺带改总重量总体积）
  const r1 = buildAdminOrderPatch("s1", base, { ...base, cargoType: "special" });
  assert.equal(r1.patch.cargoType, "special"); assert.equal(r1.patch.products, undefined); assert.equal(r1.changed, true);
  // 打开时运单上混着几种：随便存一次也发（弹窗上写明了保存后统一）
  const mixedBase = draft({ cargoType: "sensitive", products: rows("normal", "sensitive") });
  const r2 = buildAdminOrderPatch("s1", mixedBase, { ...mixedBase, arrivedAt: "2026-11-25" });
  assert.equal(r2.patch.cargoType, "sensitive");
  // 产品行动了：每款都是整票那个
  const edited = { ...mixedBase, products: mixedBase.products.map((p, i) => (i === 0 ? { ...p, packageCount: "4" } : p)) };
  const r3 = buildAdminOrderPatch("s1", mixedBase, edited);
  assert.deepEqual(r3.patch.products?.map((p) => p.cargoType), ["sensitive", "sensitive"]);
  // 同事在「运单管理」改了货型（库里各款变了）：保存前比对要看得出来
  assert.equal(sameConvertedDraft(base, draft({ cargoType: "special", products: rows("special", "special") })), false);
  assert.equal(sameConvertedDraft(base, draft({ cargoType: "inspection", products: rows("inspection", "inspection") })), true);
});

check("O6 页面上只剩整票一个货型下拉，产品行上没有（编辑运单、员工两套建单、超管建单、客户预报、到货通知、整柜）", () => {
  const dialog = read("apps/web/src/modules/orders/WaybillEditDialog.tsx");
  assert.ok(!/`第\$\{i \+ 1\}行 货型`/.test(dialog), "编辑运单产品行还有货型");
  assert.ok(!/"货型"\] as const|"货型", "国内单号"/.test(dialog.match(/PRODUCT_COLUMN_NAMES = \[[^\]]*\]/)?.[0] ?? ""), "编辑运单产品行列名还有货型");
  assert.match(dialog, /<Named caption="货型"><select aria-label="货型" value=\{form\.cargoType\}/);
  assert.match(dialog, /cargoType: form\.cargoType \|\| "normal",/, "编辑运单的产品行要发整票那个");
  assert.match(dialog, /保存后整票统一成上面选的/, "混着的老单要写明保存后统一");

  const staff = read("apps/web/src/app/staff/page.tsx");
  assert.ok(!/n\[i\] = \{ \.\.\.n\[i\], cargoType: e\.target\.value \}/.test(staff), "员工建单产品行还能选货型");
  assert.equal((staff.match(/<select aria-label="货型" value=\{form\.cargoType\}/g) ?? []).length, 2, "员工两套建单（侧边栏 + 弹窗）都要有整票货型");
  assert.match(staff, /cargoType: form\.cargoType, \/\* 一票一个货型/, "员工建单产品行要发整票那个");

  const admin = read("apps/web/src/app/admin/page.tsx");
  assert.ok(!/n\[i\]\.cargoType = e\.target\.value/.test(admin), "超管建单产品行还能选货型");
  assert.match(admin, /<select aria-label="货型" value=\{createForm\.cargoType\}/);
  assert.match(admin, /cargoType: createForm\.cargoType, \/\/ 一票一个货型/);

  const client = read("apps/web/src/app/client/page.tsx");
  assert.ok(!/n\[i\] = \{ \.\.\.n\[i\], cargoType: e\.target\.value \}/.test(client), "客户预报产品行还能选货型");
  assert.ok(!/strictestCargoType/.test(client), "客户预报还在取最严");

  const notice = read("apps/web/src/modules/arrival-notice/ArrivalNoticesView.tsx");
  assert.ok(!/setProduct\(p\.key, "cargoType"/.test(notice), "到货通知每款还能选货型");
  assert.match(notice, /set\("cargoType", cargoTypeOf\(e\.target\.value\)\)/);

  const fcl = read("apps/web/src/components/fcl/FclContainerWorkbench.tsx");
  assert.ok(!/setCell\("cargoType"/.test(fcl), "整柜清单每行还能选货型");
  assert.match(fcl, /products: filled\.map\(\(r\) => \(\{ \.\.\.r, cargoType: fclCargo \}\)\)/, "整柜提交要每行发上面选的那个");
  assert.match(fcl, /const sheetCargo = fclSheetCargo\(all\.flatMap\(\(r, i\) => \(readIn\.has\(r\) \? \[\{ rowNo: rowNoOf\(i\), raw: json\[i\] \}\] : \[\]\)\)\);/, "整柜传表格要用 fclSheetCargo 认货型（跟读表同一把尺子）");
  assert.match(fcl, /setFclCargo\(sheetCargo\.cargoType\);/);

  // 集货那几页（集货预报单）不在这次范围：照旧每个产品选货型（仓库版按货型算钱）
  assert.match(read("apps/web/src/app/client/whr-consolidation/page.tsx"), /cargoType: e\.target\.value/);
});

check("O7 后端：客户预报、员工建单、超管改单都过 readOneCargoType；到货通知保存、整柜拦混着的；转运单统一成一个；收货改货型产品行跟着", () => {
  const orders = read("apps/api/src/modules/orders/routes.ts");
  assert.equal((orders.match(/= readOneCargoType\(body\.cargoType, body\.products\);/g) ?? []).length, 2, "客户预报 / 员工建单");
  assert.ok(!/strictestCargoType\((cargo|staffCargo)\.products\)/.test(orders), "建单还在取最严");
  assert.match(orders, /if \(updateData\.cargoType !== undefined\) \{\s*await tx\.orderProduct\.updateMany\(\{ where: \{ orderId, companyId: auth\.companyId \}, data: \{ cargoType: updateData\.cargoType \} \}\);/);
  const admin = read("apps/api/src/modules/admin/routes.ts");
  assert.match(admin, /const cargo = readOneCargoType\(body\.cargoType, body\.products\);/);
  assert.match(admin, /if \(nextCargo !== undefined\) \{\s*await tx\.orderProduct\.updateMany\(\{ where: \{ orderId, companyId: auth\.companyId \}, data: \{ cargoType: nextCargo \} \}\);/);
  assert.ok(!/整票货型须与产品明细的最严货型一致/.test(admin), "老的「请在产品行修改货型」那句还在");
  const notices = read("apps/api/src/modules/arrival-notices/routes.ts");
  assert.match(notices, /const mixed = mixedCargoTypeIssue\(kept\.map\(\(p\) => p\.cargoType\)\);/);
  assert.match(notices, /productQuantity: p\.productQuantity,\s*cargoType,\s*domesticTrackingNo/, "转运单 / 同步时订单产品行要统一成一个");
  const fcl = read("apps/api/src/modules/fcl-containers/routes.ts");
  assert.match(fcl, /const mixed = mixedCargoTypeIssue\(rows\.map\(\(r\) => r\.cargoType\)\);/);
});

check("O8 整柜传表格的货型（fclSheetCargo）：跟读表同一把尺子 —— 旧表头、表头带空格也认；几行不一样 / 认不出来报第几行；只填了几行跟着填了的；都没填普货", () => {
  const H = FCL_TEMPLATE_HEADERS[8];
  const row = (cargo: string, header = H) => ({ [FCL_TEMPLATE_HEADERS[0]]: "鞋", [FCL_TEMPLATE_HEADERS[1]]: "2", [header]: cargo });
  // 10-11 前、10-11～10-16 的旧模板表头；表头前后多打空格 —— dsh 11-24 第 1 轮：原来这几种整柜都按普货存了
  for (const header of ["货型（普货/商检货/敏感货，默认普货）", "货型（普货/商检货/敏感货/特别货，默认普货）", `  ${H} `]) {
    const raw = row("敏感货", header);
    assert.equal(fclRowFromSheet(raw).cargoType, "sensitive", `读表本身认 ${header}`);
    assert.deepEqual(fclSheetCargo([{ rowNo: 2, raw }]), { cargoType: "sensitive" }, `货型检查也得认 ${header}`);
  }
  assert.deepEqual(fclSheetCargo([{ rowNo: 2, raw: row("特别货") }, { rowNo: 3, raw: row("特货") }]), { cargoType: "special" }, "旧叫法「特别货」跟「特货」是同一个");
  assert.deepEqual(fclSheetCargo([{ rowNo: 2, raw: row("") }, { rowNo: 3, raw: row("商检货") }]), { cargoType: "inspection" }, "空着的跟着填了的");
  assert.deepEqual(fclSheetCargo([{ rowNo: 2, raw: row("") }]), { cargoType: "normal" });
  const mixed = fclSheetCargo([{ rowNo: 2, raw: row("普货") }, { rowNo: 5, raw: row("敏感货") }]);
  assert.ok("error" in mixed && /一票只能有一个货型/.test(mixed.error) && /第 2 行填的「普货」/.test(mixed.error) && /第 5 行填的「敏感货」/.test(mixed.error), JSON.stringify(mixed));
  const bad = fclSheetCargo([{ rowNo: 4, raw: row("危险品") }]);
  assert.ok("error" in bad && /第 4 行/.test(bad.error) && /危险品/.test(bad.error), JSON.stringify(bad));
});

check("O9 整柜真表格（xlsx 真读）：中间有整行空行、表头上面空了两行，报的「第几行」还是表格里那一行", () => {
  const H = FCL_TEMPLATE_HEADERS;
  const line = (name: string, cargo: string) => H.map((h, i) => (i === 0 ? name : i === 1 ? 2 : h === H[8] ? cargo : ""));
  // 表头第 1 行、第 2 行普货、第 3 行整行空、第 4 行敏感货
  const ws1 = XLSX.utils.aoa_to_sheet([H as unknown as string[], line("鞋", "普货"), [], line("包", "敏感货")]);
  const rows1 = fclSheetRows(XLSX, ws1).filter((r) => String(r.raw[H[0]] ?? "").trim() !== "");
  assert.deepEqual(rows1.map((r) => r.rowNo), [2, 4]);
  const err1 = fclSheetCargo(rows1);
  assert.ok("error" in err1 && /第 2 行填的「普货」/.test(err1.error) && /第 4 行填的「敏感货」/.test(err1.error), JSON.stringify(err1));
  // 表头放在第 3 行（上面空两行）
  const ws2 = XLSX.utils.aoa_to_sheet([[], [], H as unknown as string[], line("鞋", "危险品")]);
  ws2["!ref"] = "A3:I4";
  const rows2 = fclSheetRows(XLSX, ws2);
  assert.deepEqual(rows2.map((r) => r.rowNo), [4]);
  const err2 = fclSheetCargo(rows2);
  assert.ok("error" in err2 && /第 4 行/.test(err2.error), JSON.stringify(err2));
  // 真文件写一遍再读回来（不只是内存里的表）：表头第 1 行、第 2 行整行空、第 3 行填了箱数没品名、第 4 行正常
  const ws3 = XLSX.utils.aoa_to_sheet([H as unknown as string[], [], H.map((h, i) => (i === 1 ? 3 : "")), line("鞋", "敏感货")]);
  const wb3 = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb3, ws3, "清单");
  const back = XLSX.read(XLSX.write(wb3, { type: "buffer", bookType: "xlsx" }), { type: "buffer" });
  const rows3 = fclSheetRows(XLSX, back.Sheets[back.SheetNames[0]]);
  assert.deepEqual(rows3.map((r) => r.rowNo), [2, 3, 4]);
  assert.equal(fclRowFromSheet(rows3[1].raw).itemName, "", "第 3 行是没品名那行");
  // 整列刷过格式：!ref 拉到第 100 万行，只读到最后一行有字的地方
  const ws4 = XLSX.utils.aoa_to_sheet([H as unknown as string[], line("鞋", "普货")]);
  ws4["!ref"] = "A1:I1048576";
  const t0 = Date.now();
  const rows4 = fclSheetRows(XLSX, ws4);
  assert.deepEqual(rows4.map((r) => r.rowNo), [2], "尾巴上的空行不该读进来");
  assert.ok(Date.now() - t0 < 2000, `读一张只有一行货的表花了 ${Date.now() - t0} 毫秒`);
  assert.deepEqual(fclSheetRows(XLSX, {}), [], "没有 !ref（空表）就是一行都没有");
  // 页面那几句：读表用它、没品名的行号和货型的行号都按它、空表判断要把「每一行都是空的」也算上
  const page = read("apps/web/src/components/fcl/FclContainerWorkbench.tsx");
  assert.match(page, /const sheetRows = fclSheetRows\(XLSX, sheet\);/, "页面要用 fclSheetRows 读表（带行号）");
  assert.match(page, /noName\.push\(rowNoOf\(i\)\)/, "没品名那句的行号要按表格行号");
  assert.match(page, /if \(json\.length === 0 \|\| json\.every\(\(row\) => Object\.values\(row\)\.every\(\(v\) => String\(v \?\? ""\)\.trim\(\) === ""\)\)\) \{/, "空模板（第二行一排空格子）也要说「一行货都没填」");
});

console.log(`\n${failed === 0 ? "✅" : "❌"} 一票一个货型：${passed} 项通过${failed ? `，${failed} 项失败` : ""}`);
if (failed > 0) process.exit(1);
