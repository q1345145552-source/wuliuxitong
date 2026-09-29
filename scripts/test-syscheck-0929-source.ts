/**
 * 2026-09-29 晚 Codex 全系统检查修的前端 / 不连库的部分（老板选 A）。能直接调函数的调函数，页面里的写法按源码核。
 *
 *   P1 客户批量下单：有问题的行不许悄悄丢 / 悄悄改（「2箱3」、未知包装、品名空、箱数认不出）
 *   P2 表单「整格」核对数字（普通集货件数 1.9 不许变 1）
 *   P3 老写法的请求遇到 5xx：英文换成中文；后端自己写的中文照给
 *   P4 物流轨迹时间按北京时间
 *   P5 超管页建单 / 批量导入带上运单号；员工建单图片失败照样按「已建好」走
 *   P6 客户页面：已取消任务进「已完成」、余额没读到不当 0、整柜详情认主人、地址失败要提示
 *   P7 产品行清空后，自动填的总重量 / 总体积跟着清空（员工、客户两页）
 *   P8 其它：服务端 500 中文、快递查询不甩英文、导出文件名北京日期、列表截断写总数、整柜日期上限、价格保存防连点
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`✅ ${name}`); }
  catch (e: any) { failed++; console.log(`❌ ${name}\n   ${e?.message ?? e}`); }
}

async function main(): Promise<void> {
  const { normalizeRows, isRowBad, readStrictNumber } = await import("../apps/web/src/modules/client-import/import-rows");

  await check("P1 客户批量下单：品名空、箱数认不出、「2箱3」、不认识的包装都留在预览里标红，不丢、不改；空白行才跳过", () => {
    const rows = normalizeRows([
      { "仓库 *": "义乌仓", "品名 *": "鞋", "箱数 *": "2箱3", "包装类型（箱/袋，默认箱）": "桶", "运输方式 *（海运/陆运）": "海运" },
      { "仓库 *": "义乌仓", "品名 *": "", "箱数 *": 5, "运输方式 *（海运/陆运）": "海运" },
      { "仓库 *": "义乌仓", "品名 *": "包", "箱数 *": "abc", "运输方式 *（海运/陆运）": "海运" },
      { "仓库 *": "", "品名 *": "", "箱数 *": "", "运输方式 *（海运/陆运）": "" }, // 空白行
      { "仓库 *": "义乌仓", "品名 *": "帽", "箱数 *": "3", "包装类型（箱/袋，默认箱）": "袋", "长cm（数字）": "12cm", "运输方式 *（海运/陆运）": "陆运" },
    ]);
    assert.equal(rows.length, 4, `应该留 4 行（空白行跳过），实际 ${rows.length}`);
    assert.deepEqual(rows.map((r) => r.rowNo), [2, 3, 4, 6], "行号要对着表格（表头是第 1 行）");
    const [a, b, c, d] = rows;
    assert.ok(isRowBad(a) && a.issues.some((s) => s.includes("2箱3")), `「2箱3」没标红：${a.issues}`);
    assert.ok(a.issues.some((s) => s.includes("桶")), `「桶」没标红：${a.issues}`);
    assert.notEqual(a.packageCount, 23, "「2箱3」被当成了 23 箱");
    assert.ok(isRowBad(b) && b.issues.includes("品名没填"), `品名空没标红：${b.issues}`);
    assert.ok(isRowBad(c) && c.issues.some((s) => s.includes("abc")), `箱数 abc 没标红：${c.issues}`);
    assert.equal(isRowBad(d), false, `正常的行被标红了：${d.issues}`);
    assert.equal(d.packageUnit, "bag");
    assert.equal(d.packageCount, 3);
    assert.deepEqual(readStrictNumber("12cm"), { value: 12, bad: false, raw: "12cm" });
    assert.equal(readStrictNumber("1,200").value, 1200, "千分位「1,200」应该认成 1200（dsh 复核）");
    assert.equal(readStrictNumber("1,2").bad, true, "「1,2」不是千分位，不许认成 12");
    assert.equal(readStrictNumber("1.2.3").bad, true);
    assert.equal(readStrictNumber("").bad, false);
  });

  await check("P1 客户批量下单页：换文件先清掉上一份预览；有标红的行整批不交", () => {
    const src = read("apps/web/src/app/client/imports/page.tsx");
    const at = src.indexOf("const ticket = parseGate.begin();");
    const seg = src.slice(at, at + 900);
    assert.match(seg, /previewRef\.current = \[\];\s*setRows\(\[\]\);/, "换文件时没先清掉上一份预览（新文件解析失败还能把上一份再交一次）");
    assert.match(src, /if \(rows\.some\(isRowBad\)\) return;/, "提交那里没兜住有标红行的情况");
    assert.doesNotMatch(src, /\.filter\(\(item\) => item\.itemName && Number\.isFinite\(item\.packageCount\)/, "又在悄悄过滤掉有问题的行");
  });

  await check("P2 普通集货：件数 / 每箱数量要整格是正整数，重量尺寸要整格是数字（不再 parseInt 只读开头）", async () => {
    const { isPositiveIntText, isPositiveNumberText } = await import("../apps/web/src/modules/shared/number-text");
    assert.equal(isPositiveIntText("3"), true);
    for (const v of ["1.9", "12abc", "", " ", "0", "-1"]) assert.equal(isPositiveIntText(v), false, `「${v}」不该算正整数`);
    assert.equal(isPositiveNumberText("1.25"), true);
    for (const v of ["1.25kg", "abc", "0", "-1", ""]) assert.equal(isPositiveNumberText(v), false, `「${v}」不该算正数`);
    // 客户页和超管「强制编辑」是同一功能的两套界面（dsh 复核：原来只改了客户那套）
    for (const f of ["apps/web/src/app/client/consolidation/page.tsx", "apps/web/src/app/admin/consolidation/page.tsx"]) {
      const src = read(f);
      assert.doesNotMatch(src, /parseInt\(r\.packageCount\)|parseInt\(r\.quantityPerBox\)|parseFloat\(r\.(unitWeightKg|lengthCm|widthCm|heightCm)\)/, `${f} 还在用只读开头的 parseInt / parseFloat`);
      assert.match(src, /isPositiveIntText\(r\.packageCount\)/, `${f} 件数没整格核对`);
    }
  });

  await check("P3 老写法的请求（parseApiResponse）：5xx 的英文换成中文，后端写的中文照给，网关的英文网页不原样显示", async () => {
    const core = await import("../apps/web/src/services/core-api");
    const resp = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "application/json" } });
    await assert.rejects(core.parseApiResponse(resp(500, JSON.stringify({ code: "INTERNAL_ERROR", message: "Internal server error" }))), (e: any) => /服务器出错了/.test(e.message) && !/Internal/.test(e.message));
    await assert.rejects(core.parseApiResponse(resp(502, JSON.stringify({ code: "INTERNAL_ERROR", message: "kuaidi100 request failed: connect ECONNREFUSED 10.23.4.7:443" }))), (e: any) => /服务器出错了/.test(e.message) && !/ECONNREFUSED/.test(e.message));
    await assert.rejects(core.parseApiResponse(resp(502, "<html><body>502 Bad Gateway</body></html>")), (e: any) => /服务器出错了/.test(e.message) && !/html/i.test(e.message));
    await assert.rejects(core.parseApiResponse(resp(500, JSON.stringify({ code: "INTERNAL_ERROR", message: "图片没存上（服务器出错），请稍后再传一次" }))), /图片没存上/);
    await assert.rejects(core.parseApiResponse(resp(400, JSON.stringify({ code: "BAD_REQUEST", message: "运单号为必填" }))), /运单号为必填/);
  });

  await check("P4 物流轨迹时间按北京时间（泰国客户、员工看到的一样）", async () => {
    const { formatTime } = await import("../apps/web/src/modules/shipment/track-time");
    assert.equal(formatTime("2026-09-28T16:30:00.000Z"), "09-29 00:30");
    assert.equal(formatTime("2026-09-29T02:05:00.000Z"), "09-29 10:05");
    const wallet = read("apps/web/src/app/client/wallet/page.tsx");
    assert.equal((wallet.match(/toLocaleString\("zh-CN", \{[^}]*timeZone: "Asia\/Shanghai"/g) ?? []).length, 2, "余额页两处时间没都按北京时间");
  });

  await check("P5 超管页「创建订单」「批量导入」带上运单号；员工建单图片失败照样按「已建好」走、说清哪几张", () => {
    const api = read("apps/web/src/services/business-api.ts");
    const at = api.indexOf("export interface StaffCreateOrderPayload");
    assert.match(api.slice(at, at + 600), /\n  trackingNo: string;/, "StaffCreateOrderPayload.trackingNo 还是选填（漏传编译照样过）");
    const admin = read("apps/web/src/app/admin/page.tsx");
    assert.match(admin, /const headers = \[[^\]]*"货型", "运单号"\];/, "批量模板的「运单号」没加在最后一列");
    assert.match(admin, /trackingNo: String\(r\["运单号"\] \?\? r\.trackingNo \?\? ""\)\.trim\(\)/, "批量导入没把运单号传给后端");
    assert.match(admin, /trackingNo: createForm\.trackingNo\.trim\(\),/, "单个创建没传运单号");
    assert.match(admin, /if \(!createForm\.trackingNo\.trim\(\)\) \{ setMessage\("请填写运单号"\); return; \}/);
    assert.doesNotMatch(admin, /receiverNameTh: createForm\.receiverNameTh/, "建单弹窗还在收泰国收货人（后端 6-04 起不存）");
    const staff = read("apps/web/src/app/staff/page.tsx");
    const s = staff.indexOf("const result = await createStaffOrder({");
    const seg = staff.slice(s, s + 3500);
    assert.doesNotMatch(seg, /setMessage\(`图片上传失败：[^`]*`\);\s*return;/, "图片失败还是直接 return（运单其实已建好，员工会再点一次）");
    assert.match(seg, /failedImages\.push\(/, "没记下哪几张没传上");
    assert.match(seg, /订单已创建：\$\{displayNo\}。但有 \$\{failedImages\.length\} 张图片没传上/, "提示里没说清");
  });

  await check("P6 客户页面：已取消任务进「已完成」页签、按北京日期筛；余额没读到显示「—」不当 0、付款前现读；整柜详情认主人；地址失败要提示", () => {
    const cons = read("apps/web/src/app/client/consolidation/page.tsx");
    assert.match(cons, /t\.status === "completed" \|\| t\.status === "cancelled"/, "已取消的任务还是两个页签都看不到");
    assert.match(cons, /beijingDate\(t\.createdAt\) >= searchDateFrom/, "日期筛选没按北京日期");
    for (const f of ["apps/web/src/app/client/consolidation/page.tsx", "apps/web/src/app/client/whr-consolidation/page.tsx"]) {
      const src = read(f);
      assert.match(src, /useState<number \| null>\(null\)/, `${f} 余额还是默认 0`);
      assert.doesNotMatch(src, /catch \{ setBalance\(0\); \}/, `${f} 读失败还当 0`);
      assert.match(src, /const nowBalance = await loadBalance\(\);/, `${f} 付款前没现读余额`);
    }
    const wallet = read("apps/web/src/app/client/wallet/page.tsx");
    assert.match(wallet, /Promise\.allSettled\(\[/, "余额页三个请求还是 Promise.all 一起等");
    assert.match(wallet, /balance === null \? "—"/, "余额没读到还显示 ¥0.00");
    const fcl = read("apps/web/src/app/client/fcl-containers/page.tsx");
    assert.match(fcl, /const seq = \+\+detailSeqRef\.current;[\s\S]{0,200}if \(seq !== detailSeqRef\.current\) return;/, "整柜详情没认主人");
    const home = read("apps/web/src/app/client/page.tsx");
    assert.match(home, /setToast\(error instanceof Error && error\.message \? `创建失败：\$\{error\.message\}` : "创建失败"\);/, "客户建预报单失败还是只弹「创建失败」（后端的中文原因被吞了）");
        const addr = read("apps/web/src/app/client/address-book/page.tsx");
    assert.match(addr, /设为默认失败：/);
    assert.match(addr, /删除失败：/);
  });

  await check("P7 自动填的总体积 / 总重量：加行自动填、删光跟着清；手改过的重量不被产品行覆盖（员工、客户两页共用一份）", async () => {
    const { nextAutoTotals } = await import("../apps/web/src/modules/orders/auto-totals");
    // 一步步模拟页面上的操作（Codex 复查：上一版只查源码写法，照不到「删光」「手改后再改品名」）
    let form = { volumeM3: "", weightKg: "" };
    let mem = { volumeM3: null as string | null, weightKg: null as string | null };
    const step = (vol: string | null, wt: string | null) => { const n = nextAutoTotals(form, mem, vol, wt); form = { volumeM3: n.volumeM3, weightKg: n.weightKg }; mem = n.memory; };
    step("0.002000", "6.00");                       // 加一行、填尺寸重量
    assert.deepEqual(form, { volumeM3: "0.002000", weightKg: "6.00" });
    step(null, null);                                // 把唯一一行删掉
    assert.deepEqual(form, { volumeM3: "", weightKg: "" }, "删光产品行后自动填的合计没清");
    step("0.002000", "6.00");                       // 再加回来
    form = { ...form, weightKg: "9.5" };             // 按实际称重手改总重量
    step("0.002000", "6.00");                       // 改一下品名（产品行合计没变）
    assert.equal(form.weightKg, "9.5", "手改的重量被产品行改回去了");
    step("0.004000", "12.00");                      // 箱数改了，合计变了
    assert.equal(form.weightKg, "9.5", "手改的重量被新合计覆盖了");
    assert.equal(form.volumeM3, "0.004000", "体积框（有产品行时只读）没跟着产品行");
    step(null, null);                                // 删光
    assert.equal(form.weightKg, "9.5", "删光产品行时把手填的重量也清了");
    assert.equal(form.volumeM3, "", "删光后自动填的体积没清");
    form = { ...form, weightKg: "" };                // 把手填的清掉
    step(null, "3.00");                              // 再加一行只有重量
    assert.equal(form.weightKg, "3.00", "框空着时应该用自动算的");
    // 不分产品行时按整票尺寸算出来的体积（不是产品行自动填的）：加产品行前后都不许被「清空」逻辑误清
    let f2 = { volumeM3: "0.024000", weightKg: "" }; let m2 = { volumeM3: null as string | null, weightKg: null as string | null };
    const n2 = nextAutoTotals(f2, m2, null, null);
    assert.equal(n2.volumeM3, "0.024000", "不是自动填的体积被清了");
    // 两页都用这一份
    for (const f of ["apps/web/src/app/staff/page.tsx", "apps/web/src/app/client/page.tsx"]) {
      const src = read(f);
      const eff = src.slice(src.indexOf("// Auto-fill volume and weight from multi-product form"), src.indexOf("autoTotalsRef.current = next.memory;"));
      assert.ok(eff.length > 0, `${f} 没用 nextAutoTotals`);
      assert.doesNotMatch(eff, /\.length === 0\) return;/, `${f} 产品行删光时还是直接 return`);
      assert.match(src, /const next = nextAutoTotals\(\{ volumeM3: v\.volumeM3, weightKg: v\.weightKg \?\? "" \}, auto, volStr, wtStr\);/);
    }
  });

  await check("P8 其它：服务端 500 中文、快递查询不甩英文、导出文件名北京日期、列表截断写总数、整柜日期上限、价格保存防连点", () => {
    const server = read("apps/api/src/server.ts");
    assert.doesNotMatch(server, /message: "Internal server error"|\? "Internal server error"/, "服务端 500 还是英文");
    const ship = read("apps/api/src/modules/shipments/routes.ts");
    assert.doesNotMatch(ship, /`kuaidi100 (web )?(request|query) failed: \$\{text\}`/, "快递查询还把英文原文给前端");
    assert.doesNotMatch(ship, /"kuaidi100 (web )?query failed"/);
    assert.doesNotMatch(read("apps/api/src/modules/orders/routes.ts"), /`保存图片失败：\$\{err instanceof Error \? err\.message/, "图片保存失败还把系统报错原文给前端");
    assert.match(read("apps/web/src/app/admin/page.tsx"), /订单数据_\$\{beijingToday\(\)\}\.xlsx/);
    assert.match(read("apps/web/src/app/staff/page.tsx"), /运单列表_\$\{beijingToday\(\)\}\.xlsx/);
    const whr = read("apps/web/src/app/admin/whr-consolidation/page.tsx");
    assert.match(whr, /共 \{total\} 条，这里只显示最近的 \{logs\.length\} 条/);
    assert.match(whr, /共 \{pa\.statusLogTotal\} 条，只显示最近 \{pa\.statusLogs\.length\} 条/);
    assert.match(read("apps/web/src/app/admin/page.tsx"), /共 \{sessionMemoryTotal\} 条，这里只显示最近的 \{sessionMemoryList\.length\} 条/);
    assert.match(read("apps/web/src/app/client/whr-consolidation/page.tsx"), /detail\.totalPrealerts > detail\.prealerts\.length/);
    assert.match(read("apps/web/src/components/fcl/FclContainerWorkbench.tsx"), /type="date" style=\{fi\} max=\{beijingToday\(\)\}/);
    const cfg = read("apps/web/src/components/admin/ShippingConfig.tsx");
    assert.match(cfg, /disabled=\{savingClientPrices\}/);
    assert.match(cfg, /finally \{ setSavingClientPrices\(false\); \}/);
  });

  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
