/**
 * 2026-09-29 老板三个问题都选 A 之后修的 —— 不连库的回归（能真跑的真跑，跑不了的读源码按函数体钉住）。
 * 连库的那一半在 test-fix-0929-db.ts；迁移文件在 test-migration-number-seq-db.ts。
 *
 *   G1 太大的请求不发出去、当场给中文（线上 Next 转发那一跳 10MiB 封顶，原来卡 30 秒再报英文 500）——
 *      项目里所有请求都走 core-api 的 fetchWithSession，挡在这一处
 *   G2 前端上限 > 后端单张图上限 + JSON 外壳，且 < 10MiB（不然要么后端的中文提示永远弹不出来，要么照样撞 Next）
 *   G3 仓库版费用明细：「方数 × 单价」跟右边金额对得上（明细给精确方数，显示整 3 位的照旧 3 位）
 *   G4 金额统一两位小数（300.10 不再显示成 300.1）
 *   G5 客户建预报单时图片没传上：告诉客户哪张、为什么（原来吞掉照样说「创建成功」）；长提示停留得够久
 *   G6 五种单号都走 number_sequences 发号（号只往上加、删了不回收），号段名写对
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

/** 从 marker 往后找第一个「{」，数括号截出整段 */
function block(src: string, marker: string): string {
  const at = src.indexOf(marker);
  assert.ok(at >= 0, `源码里找不到「${marker}」`);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  throw new Error(`「${marker}」后面的大括号没配平`);
}

async function main(): Promise<void> {
  const calls: string[] = [];
  (globalThis as any).fetch = async (input: any) => { calls.push(String(input)); return new Response(JSON.stringify({ code: "OK", data: {} }), { status: 200 }); };
  const core = await import("../apps/web/src/services/core-api");
  const { UPLOAD_IMAGE_MAX_BASE64 } = await import("../apps/api/src/modules/core/upload-limit");

  await check("G1 请求体超过上限：不发出去，当场报中文（说了多大、让压缩）；没超的照常发", async () => {
    calls.length = 0;
    await assert.rejects(
      core.fetchWithSession("http://x/staff/orders/product-images", { method: "POST", body: JSON.stringify({ contentBase64: "A".repeat(9_900_000) }) }),
      (e: any) => /图片太大/.test(e.message) && /压缩/.test(e.message) && /MB/.test(e.message),
    );
    assert.equal(calls.length, 0, "太大的请求照样发出去了（线上会卡 30 秒再报英文 500）");
    await core.fetchWithSession("http://x/ok", { method: "POST", body: JSON.stringify({ contentBase64: "A".repeat(1000) }) });
    assert.equal(calls.length, 1, "正常大小的请求没发出去");
    // 走 apiRequest 的上传（整柜询价、客服对话等）：同一句中文原样抛给页面，不被改成「服务器繁忙 / 请求超时」
    await assert.rejects(core.apiRequest("http://x/api", { method: "POST", body: "A".repeat(9_900_000) }), (e: any) => /图片太大/.test(e.message));
    assert.equal(calls.length, 1);
  });

  await check("G1 中文字按 UTF-8 算字节（一个汉字 3 个字节），不按字数算", async () => {
    calls.length = 0;
    await assert.rejects(core.fetchWithSession("http://x/y", { method: "POST", body: "汉".repeat(3_400_000) }), /图片太大/);
    assert.equal(calls.length, 0, "3 百多万个汉字（1 千多万字节）照样发出去了");
  });

  await check("G2 上限前后对得上：后端单张图上限 + JSON 外壳 < 前端请求上限 < Next 转发 10MiB", () => {
    assert.ok(UPLOAD_IMAGE_MAX_BASE64 + 4096 < core.REQUEST_BODY_MAX_BYTES, "后端能收的最大一张图，前端先挡了（后端那句中文提示永远弹不出来）");
    assert.ok(core.REQUEST_BODY_MAX_BYTES < 10 * 1024 * 1024, "前端上限比 Next 转发的 10MiB 还大，照样撞墙");
  });

  await check("G3 仓库版费用明细：每一行「方数 × 单价」四舍五入到分正好等于金额；合并后同样对得上", async () => {
    const utils = await import("../apps/api/src/modules/whr-consolidation/utils");
    const prices = { unitPriceNormal: 850, unitPriceInspection: 950, unitPriceSensitive: 1200 };
    // 33.3×22.2×11.1cm × 7 件 = 0.057441 方（测试员实测那一票）
    const items = [
      { cargoType: "sensitive", volumeM3: 0.057441 },
      { cargoType: "normal", volumeM3: 1.23456 },
      { cargoType: "inspection", volumeM3: 0.0005 },
    ];
    const bd = utils.buildFeeBreakdown(items as any, prices, null);
    for (const r of bd.rows) {
      const shown = Math.round(r.volumeM3 * r.unitPrice * 100) / 100;
      assert.equal(shown, r.amount, `${r.label}：${r.volumeM3} × ${r.unitPrice} = ${shown}，金额却是 ${r.amount}`);
    }
    assert.equal(bd.rows.find((r: any) => r.cargoType === "sensitive")!.volumeM3, 0.057441, "明细还是先把方数抹成 3 位");
    const merged = utils.mergeFeeBreakdowns([bd, utils.buildFeeBreakdown([{ cargoType: "sensitive", volumeM3: 0.392459 }] as any, prices, null)]);
    const s = merged.rows.find((r: any) => r.cargoType === "sensitive")!;
    assert.ok(Math.abs(Math.round(s.volumeM3 * s.unitPrice * 100) / 100 - s.amount) <= 0.011, `合并后 ${s.volumeM3} × ${s.unitPrice} 跟 ${s.amount} 差太多`);
    // 钱没动：computedFee 跟改之前同一个算法
    assert.equal(bd.computedFee, utils.calcFeeFromItems(items as any, prices));
  });

  await check("G3 方数显示：整 3 位小数的照旧 3 位；不是的写到精确值（去掉末尾 0）", async () => {
    const { formatBreakdownVolume } = await import("../apps/web/src/modules/shared/volume-format");
    assert.equal(formatBreakdownVolume(2), "2.000");
    assert.equal(formatBreakdownVolume(0.5), "0.500");
    assert.equal(formatBreakdownVolume(2.369), "2.369");
    assert.equal(formatBreakdownVolume(0.057441), "0.057441");
    assert.equal(formatBreakdownVolume(0.0575), "0.0575");
    for (const f of ["apps/web/src/app/client/whr-consolidation/page.tsx", "apps/web/src/app/admin/whr-consolidation/page.tsx", "apps/web/src/app/staff/whr-consolidation/page.tsx"]) {
      const src = read(f);
      assert.doesNotMatch(src, /r\.volumeM3\.toFixed\(3\)/, `${f} 明细方数还是写死 3 位`);
      assert.match(src, /\{formatBreakdownVolume\(r\.volumeM3\)\} 方 × \{r\.unitPrice\}/, `${f} 没用 formatBreakdownVolume`);
    }
    assert.match(read("apps/web/src/components/agent/AgentWhr.tsx"), /formatBreakdownVolume\(r\.volumeM3\)\} 方 ×/, "代理端明细没改");
  });

  await check("G4 金额统一两位小数：amount2 行为 + 集货 / 整柜页面不再有裸 toLocaleString()", async () => {
    const { amount2 } = await import("../apps/web/src/modules/shared/money-format");
    assert.equal(amount2(300.1), "300.10");
    assert.equal(amount2(1534.6), "1,534.60");
    assert.equal(amount2(0), "0.00");
    assert.equal(amount2(null), "—");
    for (const f of ["apps/web/src/app/client/consolidation/page.tsx", "apps/web/src/app/staff/consolidation/page.tsx", "apps/web/src/app/client/fcl-containers/page.tsx", "apps/web/src/components/fcl/FclContainerWorkbench.tsx", "apps/web/src/app/staff/whr-consolidation/page.tsx"]) {
      const bare = read(f).split("\n").filter((l) => /\.toLocaleString\(\)/.test(l) && !/Date|date|time|Time/.test(l));
      assert.equal(bare.length, 0, `${f} 还有裸 toLocaleString()：${bare[0]?.trim().slice(0, 80)}`);
    }
  });

  await check("G5 客户建预报单时图片没传上：记下是哪张、为什么，提示里说出来（不再吞掉照样说成功）", () => {
    const src = read("apps/web/src/app/client/page.tsx");
    const at = src.indexOf("const result = await createClientPrealert(payload);");
    assert.ok(at > 0);
    const seg = src.slice(at, at + 2500);
    assert.doesNotMatch(seg, /catch \{ \/\* skip \*\/ \}/, "图片上传失败还是被吞掉");
    assert.match(seg, /failedImages\.push\(`「\$\{file\.name\}」\$\{e instanceof Error \? e\.message : "上传失败"\}`\)/, "没记下哪张、为什么");
    assert.match(seg, /failedImages\.length === 0\s*\?\s*"预报单创建成功"\s*:\s*`预报单已创建，但有 \$\{failedImages\.length\} 张图片没传上：\$\{failedImages\.join\("；"\)\}/, "提示里没说哪几张没传上");
  });

  await check("G5 客户端提示停留时间跟着字数走（长提示最长 12 秒），计时和 Toast 用的是同一个数", () => {
    const src = read("apps/web/src/app/client/page.tsx");
    assert.match(src, /const toastDuration = Math\.min\(12_000, Math\.max\(2200, toast\.length \* 120\)\);/);
    assert.match(src, /window\.setTimeout\(\(\) => setToast\(""\), toastDuration\)/, "清提示的计时还是写死的");
    assert.match(src, /<Toast open=\{toast\.length > 0\} message=\{toast\} duration=\{toastDuration\} \/>/, "Toast 自己的计时没跟着改");
  });

  await check("G6 五种单号都走 number_sequences 发号，号段名写对，不再是「最大号 + 1」", () => {
    const want: Array<[string, string, string]> = [
      ["apps/api/src/modules/consolidation/routes.ts", "async function generateTaskNo(", "\"JH\""],
      ["apps/api/src/modules/consolidation/routes.ts", "async function generateTrackingNo(", "\"JH-YW\""],
      ["apps/api/src/modules/whr-consolidation/routes.ts", "async function generatePlanNoInTx(", "\"WHR\""],
    ];
    for (const [f, fn, name] of want) {
      const body = block(read(f), fn);
      assert.match(body, new RegExp(`await nextSequenceValue\\(tx, ${name.replace(/[-]/g, "\\-")},`), `${fn} 没走 number_sequences（号段 ${name}）`);
      assert.doesNotMatch(body, /\) \+ 1;|\?\? 0\) \+ 1/, `${fn} 还留着「最大号 + 1」`);
    }
    const whrClient = read("apps/api/src/modules/whr-consolidation/client-routes.ts");
    assert.match(whrClient, /const nextNum = await nextSequenceValue\(tx, "WHRP", Number\(rows\?\.\[0\]\?\.maxno \?\? 0\)\);/, "仓库版预报单号没走 number_sequences");
    const ops = read("apps/api/src/modules/admin-ops/routes.ts");
    assert.match(ops, /deliveryNo = `WD\$\{String\(await nextSequenceValue\(tx, "WD", num\)\)\.padStart\(6, "0"\)\}`;/, "派送单号没走 number_sequences");
    assert.doesNotMatch(ops, /String\(num \+ 1\)/, "派送单号还留着「最大号 + 1」");
  });

  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
