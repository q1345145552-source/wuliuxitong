/**
 * 客户余额第 2 轮（2026-11-27，财务系统2 ADR 0191）—— 不连库那一半。连库的在 test-wallet-adjust-db.ts。
 *
 *   W1 后端格式：金额（字符串核、不经浮点）、备注 / 原因、水单（只认图片 data URL 和站内 /images/）
 *   W2 后端规矩：加减冲只给管理员；事务第一句是提交编号排队锁（已登记锁序、83093 只此一处）；冲掉先锁调整单；钱走公共函数；
 *      减金额不许负、冲掉许负；关联类型 admin_adjust 不跟别的共用；看流水的操作人只给管理员
 *   W3 推送：加减冲只推给那一个客户（员工 / 管理员照旧收全公司）；别的钱包接口照旧
 *   W4 页面：管理员菜单「客户余额」；弹窗两步、确认时唛头和金额大字再显示；金额默认空；提交编号打开时生成、回去改才换；
 *      提交中禁用（ref 当场挡第二下）；员工能看流水不能调；客户余额页文案；负数标红
 *   W5 「集货余额」改名：给人看的字里一个不剩（注释、标识符不算）；菜单 / 标题 / 代理入口改名但不打开
 *   W6 前端手写类型跟后端返回字段对得上（CLAUDE.md 第 22 条）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
/** 去掉注释（看真代码用；JSX 的 {/* *\/} 也去） */
const code = (rel: string) => read(rel).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; console.log(`❌ ${name}\n   ${(e instanceof Error ? e.stack ?? e.message : String(e)).split("\n").slice(0, 6).join("\n   ")}`); }
}

function walk(dir: string, exts: string[]): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === ".next" ? [] : walk(p, exts);
    return exts.some((x) => p.endsWith(x)) ? [p] : [];
  });
}

async function main(): Promise<void> {
  const routesMod = await import("../apps/api/src/modules/wallet/admin-adjust-routes");
  const { publishAfterWrite } = await import("../apps/api/src/modules/realtime/publish");
  const { topicForWrite } = await import("../apps/api/src/modules/realtime/topics");

  await check("W1 金额只认大于 0、最多两位小数（字符串核，不经浮点）；备注 ≤200 字无控制字符；水单只认图片 data URL / 站内 /images/、8MB 以内", () => {
    const amt = (v: unknown) => routesMod.parseAdjustAmount(v)?.toFixed(2) ?? null;
    assert.equal(amt("5000"), "5000.00");
    assert.equal(amt("0.01"), "0.01");
    assert.equal(amt(" 12.5 "), "12.50");
    assert.equal(amt(12.5), "12.50");
    assert.equal(amt("999999999999.99"), "999999999999.99");
    for (const bad of ["0", "0.00", "-1", "1.005", "1e3", "abc", "", "1,000", "01", "1000000000000", " ", null, undefined, true, [5], NaN, Infinity]) {
      assert.equal(amt(bad), null, JSON.stringify(bad));
    }
    assert.deepEqual(routesMod.parseAdjustText(undefined), { ok: true, text: "" });
    assert.deepEqual(routesMod.parseAdjustText("  线下转账  "), { ok: true, text: "线下转账" });
    assert.deepEqual(routesMod.parseAdjustText("第一行\n第二行"), { ok: true, text: "第一行\n第二行" });
    for (const bad of ["x".repeat(201), "a\u0000b", "a\tb", 12, {}]) assert.equal(routesMod.parseAdjustText(bad).ok, false);
    assert.equal(routesMod.proofImageIssue(""), null);
    assert.equal(routesMod.proofImageIssue("data:image/png;base64,iVBORw0KGgo="), null);
    assert.equal(routesMod.proofImageIssue("/images/a_b-1.jpg"), null);
    for (const bad of ["javascript:alert(1)", "data:text/html;base64,PHNjcmlwdD4=", "data:image/svg+xml;base64,PHN2Zz4=", 'x" onerror="alert(1)', "/images/../x", "/images/..", "/images/.env", "/images/a..b.png", "https://evil.example/x.png", `data:image/png;base64,${"A".repeat(8 * 1024 * 1024)}`]) {
      assert.ok(routesMod.proofImageIssue(bad), bad.slice(0, 40));
    }
  });

  await check("W2 后端规矩：加减冲只给管理员、看流水员工也行；事务第一句是提交编号排队锁；冲掉先锁调整单再查冲过没有；钱走公共函数；减不许负、冲许负、加许负", () => {
    const r = code("apps/api/src/modules/wallet/admin-adjust-routes.ts");
    for (const p of ["/admin/wallet/adjustments/topup", "/admin/wallet/adjustments/deduct", "/admin/wallet/adjustments/reverse", "/admin/wallet/adjustments/proof"]) {
      const i = r.indexOf(`"${p}"`);
      assert.ok(i > 0, p);
      assert.match(r.slice(i, i + 200), /requireRole\(req, res, \["admin"\]\)/, `${p} 只给管理员`);
    }
    for (const p of ["/staff/wallet/clients", "/staff/wallet/ledger"]) {
      const i = r.indexOf(`"${p}"`);
      assert.match(r.slice(i, i + 200), /requireRole\(req, res, \["staff", "admin"\]\)/, `${p} 员工和管理员`);
    }
    const txs = r.split("prisma.$transaction(async (tx) => {").slice(1);
    assert.equal(txs.length, 2, "加减一个事务、冲掉一个事务");
    for (const t of txs) assert.match(t.trimStart(), /^await limitWaits\(tx\);\s*await lockWalletAdjustSubmit\(tx, input\.submitKey\);/, "事务开头必须是：设等锁时限 → 提交编号排队锁");
    assert.match(r, /SET LOCAL lock_timeout = '5s'/);
    // 水单原图不随调整单 / 流水读出来（只在库里算有没有、一样不一样）
    assert.doesNotMatch(r.slice(r.indexOf("const ADJ_SELECT = {"), r.indexOf("satisfies Prisma.WalletAdjustmentSelect")), /proofImage/);
    assert.match(r, /proof_image IS NOT NULL AS has_proof/);
    assert.equal((r.match(/select: \{ proofImage: true \}/g) ?? []).length, 1, "只有「看水单」那一个接口读原图");
    // 一个提交编号不许既拿来加 / 减又拿来冲掉
    assert.match(r, /const usedForReverse = await db\.walletAdjustment\.findUnique\(\{ where: \{ reverseSubmitKey: input\.submitKey \}/);
    assert.match(r, /const usedForCreate = await db\.walletAdjustment\.findUnique\(\{ where: \{ submitKey: input\.submitKey \}/);
    const rev = txs[1];
    assert.ok(rev.indexOf("FROM wallet_adjustments WHERE id = ${input.adjustmentId} AND company_id = ${auth.companyId} FOR UPDATE") < rev.indexOf("if (adj.reversedAt)"), "冲掉：先锁调整单再看冲过没有");
    assert.ok(rev.indexOf("if (adj.reversedAt)") < rev.indexOf("adminReverseTopup("), "看过没冲才动钱");
    assert.match(r, /const SUBMIT_LOCK_KEY = 83093;/);
    assert.match(r, /pg_advisory_xact_lock\(\$\{SUBMIT_LOCK_KEY\}::int, hashtext\(\$\{submitKey\}\)\)/);
    assert.match(read("scripts/test-lock-order.ts"), /lockWalletAdjustSubmit: \["advisory_wallet_adjust_submit"\]/);
    const hits = walk(path.join(ROOT, "apps/api/src"), [".ts"]).filter((f) => /\b83093\b/.test(fs.readFileSync(f, "utf8")));
    assert.deepEqual(hits.map((f) => path.relative(ROOT, f)), ["apps/api/src/modules/wallet/admin-adjust-routes.ts"]);
    // 钱只走公共函数，这个文件里不直接改钱包、不直接记流水
    assert.doesNotMatch(r, /clientWalletAccount\.(update|upsert|create)|consolidationBalanceLedger\.(create|update)|UPDATE client_wallet_accounts/);
    const w = code("apps/api/src/modules/wallet/consolidation-balance.ts");
    assert.match(w, /export async function adminTopup[\s\S]*?adminMove\(tx, args, "topup", 1, true\)/, "加金额：余额原来是负数也能加");
    assert.match(w, /export async function adminDeduct[\s\S]*?adminMove\(tx, args, "deduction", -1, false\)/, "减金额：不许减成负数");
    assert.match(w, /export async function adminReverseTopup[\s\S]*?adminMove\(tx, args, "topup_reversal", -1, true\)/, "冲掉：可以冲成负数");
    const move = w.slice(w.indexOf("async function adminMove"), w.indexOf("export async function adminTopup"));
    const iEnsure = move.indexOf("ensureWalletRow("), iLock = move.indexOf("lockAndReadWallet("), iCheck = move.indexOf("after.lt(0)"), iUpd = move.indexOf("clientWalletAccount.update");
    assert.ok(iEnsure > 0 && iEnsure < iLock && iLock < iCheck && iCheck < iUpd, "先保证行在 → 锁 + 读 → 锁里判断 → 改");
    assert.match(move, /refType: ADMIN_ADJUST_REF_TYPE,/);
    assert.match(w, /export const ADMIN_ADJUST_REF_TYPE = "admin_adjust";/);
    for (const f of ["apps/api/src/modules/consolidation/routes.ts", "apps/api/src/modules/whr-consolidation/routes.ts", "apps/api/src/modules/whr-consolidation/client-routes.ts", "apps/api/src/modules/admin/routes.ts", "apps/api/src/modules/finance2-balance/ops.ts"]) {
      assert.doesNotMatch(code(f), /admin_adjust|ADMIN_ADJUST_REF_TYPE/, `${f} 不许用 admin_adjust`);
    }
    // 看流水：操作人 / 谁冲的只给管理员；不整行展开
    assert.match(r, /const seeOperator = canSeeOperatorIdentity\(auth\.role\);/);
    assert.match(r, /byName: seeOperator \? \(adj\.reversed_by_name \?\? ""\) : undefined,/);
    assert.doesNotMatch(r, /\.\.\.\s*(r|row|adj|a|seen)\b(?!\w)(?!:)/, "不许整行展开（CLAUDE.md 第 31 条）");
    assert.match(read("apps/api/src/main.ts"), /\nregisterWalletAdjustRoutes\(app\);/);
  });

  await check("W3 推送：加 / 减 / 冲掉只推给那一个客户的 wallet（员工、管理员照旧收）；充值审核等老接口照旧推给全公司", () => {
    const sent: any[] = [];
    const hub = { publish: (e: unknown) => sent.push(e) } as any;
    const admin = { userId: "a1", companyId: "co1", role: "admin" as const, name: "", agentId: null };
    for (const p of ["/admin/wallet/adjustments/topup", "/admin/wallet/adjustments/deduct", "/admin/wallet/adjustments/reverse"]) {
      assert.equal(topicForWrite(p), "wallet", p);
      sent.length = 0;
      publishAfterWrite({ method: "POST", path: p, query: {}, headers: {}, body: { clientId: " C1 " }, auth: admin } as any, 200, hub);
      assert.deepEqual(sent.map((e) => [e.topic, e.clientIds]), [["wallet", ["C1"]]], p);
      sent.length = 0;
      publishAfterWrite({ method: "POST", path: p, query: {}, headers: {}, body: { clientId: "C1" }, auth: admin } as any, 400, hub);
      assert.deepEqual(sent, [], "没办成不推");
    }
    sent.length = 0;
    publishAfterWrite({ method: "POST", path: "/admin/wallet/recharges/approve", query: {}, headers: {}, body: { id: "r1" }, auth: admin } as any, 200, hub);
    assert.deepEqual(sent.map((e) => [e.topic, e.clientIds]), [["wallet", undefined]], "充值审核照旧");
    // 冲掉那条：后端核过 clientId 就是那一笔的客户
    assert.match(code("apps/api/src/modules/wallet/admin-adjust-routes.ts"), /if \(adj\.clientId !== input\.clientId\) return \{ kind: "wrongClient" as const \};/);
  });

  const page = code("apps/web/src/app/admin/client-balance/page.tsx");
  await check("W4 管理员「客户余额」页：菜单在充值审核旁边；弹窗两步、确认那一步唛头和金额大字再显示；金额默认空；提交编号打开时生成、回去改才换；提交中禁用、ref 当场挡第二下；只显示唛头", () => {
    const menu = read("apps/web/src/modules/layout/menu-config.ts");
    assert.match(menu, /label: "充值审核", href: "\/admin#wallet-recharges" \},\s*(\/\/[^\n]*\n\s*)*\{ id: "admin-func-client-balance", label: "客户余额", href: "\/admin\/client-balance" \}/);
    assert.match(read("apps/web/src/modules/layout/WorkbenchFrame.tsx"), /"\/admin\/client-balance": "客户余额",/);
    // 金额默认空：打开弹窗时清空，输入框不带 defaultValue
    assert.match(page, /const openCreate = \(kind: "topup" \| "deduct"\) => \{\s*setAmount\(""\);/);
    assert.match(page, /const \[amount, setAmount\] = useState\(""\);/);
    assert.doesNotMatch(page, /defaultValue/);
    // 提交编号：打开时生成；回去改换新的；网断重试不换
    assert.match(page, /setDialog\(\{ kind, step: "fill", submitKey: newSubmitKey\(\) \}\)/);
    assert.match(page, /setDialog\(\{ kind: "reverse", row, submitKey: newSubmitKey\(\) \}\)/);
    assert.match(page, /const backToFill = \(\) => \{[\s\S]*?submitKey: newSubmitKey\(\)/);
    assert.match(read("apps/web/src/modules/wallet/submit-keys.ts"), /crypto\.getRandomValues\(bytes\)/);
    // 交出去用哪个编号：同样的内容之前「不知道办成没有」→ 用回原来那个（2026-11-27 审查第 1 条）
    assert.match(page, /const ck = contentKeyOf\(content\);\s*const submitKey = pickSubmitKey\(uncertain, ck, dialog\.submitKey\);/);
    for (const fn of ["adminWalletTopup", "adminWalletDeduct", "adminWalletReverse"]) assert.match(page, new RegExp(`await ${fn}\\(\\{[^}]*submitKey \\}\\);\\s*uncertain\\.forget\\(ck\\);`), `${fn}：成功（含重复回话）才把记录清掉`);
    assert.match(page, /if \(e instanceof SubmitOutcomeUnknownError\) \{\s*uncertain\.remember\(ck, submitKey\);[\s\S]*?setReloadKey\(\(k\) => k \+ 1\);\s*void loadClients\(\{ silent: true \}\);\s*\} else \{\s*uncertain\.forget\(ck\);/, "不知道办成没有：记下编号、重拉流水和余额；明确没办：清掉");
    // 两步：先「下一步：核对」，核对那一步大字显示唛头和金额，才有「确认加金额」
    assert.match(page, />下一步：核对</);
    assert.match(page, /请再核对一遍[\s\S]*?唛头：<strong style=\{\{ fontSize: 18 \}\}>\{selected\}<\/strong>[\s\S]*?<strong style=\{\{ fontSize: 22,[^}]*\}\}>\{parsedAmount === null \? "—" : yuan\(parsedAmount\)\}<\/strong>/);
    assert.match(page, /dialog\.kind !== "reverse" && dialog\.step === "fill" \? \(\s*<button type="button" style=\{primary\} onClick=\{goConfirm\}>下一步：核对<\/button>/);
    // 防连点
    assert.match(page, /if \(!dialog \|\| !selected \|\| submittingRef\.current\) return;\s*submittingRef\.current = true;/);
    assert.match(page, /disabled=\{submitting\} onClick=\{\(\) => void submit\(\)\}/);
    // 减金额要原因、冲掉要原因
    assert.match(page, /if \(!text\.trim\(\)\) \{ setDialogError\("请写减金额的原因"\); return; \}/);
    assert.match(page, /if \(!text\.trim\(\)\) \{ setDialogError\("请写冲掉的原因"\); return; \}/);
    // 只显示唛头：页面不读客户名字
    assert.doesNotMatch(page, /\.name\b|companyName/);
  });

  await check("W4b 员工「客户余额」：能点进去看流水（只读，不出冲掉按钮）；流水组件冲掉 / 水单只给管理员；客户余额页文案和负数标红", () => {
    const staff = code("apps/web/src/app/staff/page.tsx");
    assert.match(staff, /<ClientLedgerPanel clientId=\{walletLedgerClient\} isAdmin=\{false\} \/>/);
    assert.match(staff, /\{walletLedgerClient === b\.clientId \? "收起" : "看流水"\}/);
    const panel = code("apps/web/src/modules/wallet/ClientLedgerPanel.tsx");
    assert.match(panel, /\{isAdmin \? \(\s*<td/);
    assert.match(panel, /r\.adjustment\?\.canReverse && onReverse \?/);
    const wallet = code("apps/web/src/app/client/wallet/page.tsx");
    assert.match(wallet, /<h2 style=\{\{ margin: 0 \}\}>余额<\/h2>/);
    assert.equal((wallet.match(/运费账单出来会自动从这里扣/g) ?? []).length, 2, "两处都改");
    assert.doesNotMatch(wallet, /只能用于集货拼柜/);
    assert.match(wallet, /color: balance !== null && balance < 0 \? "var\(--c-red-deep\)"/);
    assert.match(wallet, /color: r\.balanceAfter < 0 \? "var\(--c-red-deep\)"/);
    assert.match(code("apps/web/src/app/admin/finance/page.tsx"), /个客户账上还有钱（负数余额已抵减）/);
  });

  await check("W4c 窄屏：流水和客户列表按这一块的宽度换成「一条一块」，冲掉按钮在块里（不用横着滚）；弹窗手机上能滚、底下留出底栏；两个集货付款弹窗负数余额写「−¥」标红", () => {
    const panel = code("apps/web/src/modules/wallet/ClientLedgerPanel.tsx");
    assert.match(panel, /const \{ ref: boxRef, narrow \} = useNarrowBox<HTMLDivElement>\(860\);/);
    assert.match(panel, /\) : narrow \? \(\s*<div style=\{\{ display: "grid", gap: 8 \}\}>[\s\S]*?<span>\{actions\(r\)\}<\/span>/, "一条一块里有「冲掉」");
    assert.match(page, /const \{ ref: listBoxRef, narrow \} = useNarrowBox<HTMLElement>\(640\);/);
    assert.match(page, /maxHeight: "calc\(100dvh - 84px - env\(safe-area-inset-bottom\)\)", overflowY: "auto"/);
    assert.match(page, /padding: "12px 12px calc\(72px \+ env\(safe-area-inset-bottom\)\)"/);
    const hook = read("apps/web/src/modules/wallet/useNarrowBox.ts");
    assert.match(hook, /new ResizeObserver\(sync\)/);
    for (const f of ["apps/web/src/app/client/consolidation/page.tsx", "apps/web/src/app/client/whr-consolidation/page.tsx"]) {
      assert.match(code(f), /当前余额：<strong style=\{\{ color: balance !== null && balance < 0 \? "var\(--c-red-deep\)" : undefined \}\}>\{balance === null \? "正在读取…（一直读不出来请刷新页面）" : `\$\{balance < 0 \? "−" : ""\}¥\$\{Math\.abs\(balance\)\.toFixed\(2\)\}`\}<\/strong>/, f);
    }
  });

  await check("W7 行为：提交编号跟内容绑在一起（不知道办成没有 → 同样内容再交用回原编号；成功 / 明确没办 → 清掉；改了内容 → 新的；记在浏览器里 24 小时）", async () => {
    const sk = await import("../apps/web/src/modules/wallet/submit-keys");
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
    let clock = 1_000_000;
    const store = sk.createUncertainStore(storage, () => clock);
    const c = (amount: string, text = "线下转账") => sk.contentKeyOf({ kind: "topup", clientId: "C1", amount, text, proof: "" });
    assert.equal(c("100"), c("100.00"), "100 和 100.00 是同一个数");
    assert.equal(c("100", " 线下转账 "), c("100"), "首尾空白不算");
    assert.notEqual(c("100"), c("100.01"));
    assert.notEqual(c("100"), c("100", "别的备注"));
    assert.notEqual(sk.contentKeyOf({ kind: "topup", clientId: "C1", amount: "100", text: "", proof: "" }), sk.contentKeyOf({ kind: "deduct", clientId: "C1", amount: "100", text: "", proof: "" }));
    assert.notEqual(sk.contentKeyOf({ kind: "topup", clientId: "C1", amount: "1", text: "", proof: "data:image/png;base64,AAA" }), sk.contentKeyOf({ kind: "topup", clientId: "C1", amount: "1", text: "", proof: "data:image/png;base64,AAB" }));
    assert.match(sk.newSubmitKey(), /^[0-9a-f]{32}$/);
    // 第一次交：没记录 → 用弹窗的新编号；不知道办成没有 → 记下
    const k1 = sk.pickSubmitKey(store, c("100"), "fresh-1");
    assert.equal(k1, "fresh-1");
    store.remember(c("100"), k1);
    // 返回修改没改 / 关掉重开填同一个数（弹窗给了新编号）→ 还是原来那个
    assert.equal(sk.pickSubmitKey(store, c("100.00"), "fresh-2"), "fresh-1");
    // 刷新页面（新的 store、同一个浏览器存储）→ 还认得
    assert.equal(sk.pickSubmitKey(sk.createUncertainStore(storage, () => clock), c("100"), "fresh-3"), "fresh-1");
    // 改了内容 → 新编号
    assert.equal(sk.pickSubmitKey(store, c("200"), "fresh-4"), "fresh-4");
    // 后端回了（成功 / 重复回话 / 明确没办）→ 清掉，之后同样的内容是新的一笔
    store.forget(c("100"));
    assert.equal(sk.pickSubmitKey(store, c("100"), "fresh-5"), "fresh-5");
    // 24 小时后作废
    store.remember(c("300"), "old");
    clock += 24 * 60 * 60 * 1000 + 1;
    assert.equal(sk.pickSubmitKey(store, c("300"), "fresh-6"), "fresh-6");
    // 浏览器存储坏了 / 拿不到：只记在内存里，照样认
    const broken = sk.createUncertainStore({ getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } });
    broken.remember(c("1"), "m1");
    assert.equal(sk.pickSubmitKey(broken, c("1"), "f"), "m1");
    assert.equal(sk.pickSubmitKey(sk.createUncertainStore(null), c("1"), "f"), "f");
  });

  await check("W8 行为：加 / 减 / 冲掉的请求分清「后端明确没办」和「不知道办没办成」（网断、超时、5xx、2xx 读不全 → SubmitOutcomeUnknownError；4xx 照原因）", async () => {
    const api = await import("../apps/web/src/services/business-api");
    const sk = await import("../apps/web/src/modules/wallet/submit-keys");
    const realFetch = globalThis.fetch;
    const payload = { clientId: "C1", amount: "1.00", remark: "", proofImage: "", submitKey: "k".repeat(32) };
    const outcome = async (impl: () => Promise<Response>) => {
      (globalThis as any).fetch = impl;
      try { return { ok: await api.adminWalletTopup(payload) }; }
      catch (e) { return { unknown: e instanceof sk.SubmitOutcomeUnknownError, message: (e as Error).message }; }
      finally { (globalThis as any).fetch = realFetch; }
    };
    const json = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    assert.deepEqual(await outcome(async () => { throw new TypeError("Failed to fetch"); }), { unknown: true, message: (await outcome(async () => { throw new TypeError("x"); })).message });
    for (const status of [500, 502, 503, 504]) assert.equal((await outcome(json(status, { code: "INTERNAL_ERROR", message: "busy" }))).unknown, true, String(status));
    assert.equal((await outcome(async () => new Response("<html>bad gateway</html>", { status: 502 }))).unknown, true);
    assert.equal((await outcome(async () => new Response("{\"code\":\"OK\",\"da", { status: 200 }))).unknown, true, "2xx 读不全");
    const bad = await outcome(json(400, { code: "BAD_REQUEST", message: "余额不够减：现在 ¥1.00，要减 ¥2.00。没有减，一分没动" }));
    assert.equal(bad.unknown, false, "4xx 是后端明确没办");
    assert.match(bad.message!, /余额不够减/);
    const conflict = await outcome(json(409, { code: "VALIDATION_ERROR", message: "这次提交的编号已经用过了" }));
    assert.equal(conflict.unknown, false);
    const good = await outcome(json(200, { code: "OK", message: "success", data: { adjustment: { id: "adj_1" }, balanceAfter: 1, duplicate: false } }));
    assert.equal((good as any).ok.adjustment.id, "adj_1");
    assert.match((await outcome(async () => { throw new TypeError("x"); })).message!, /不确定办成没有.*请先看下面的流水，已经有这一笔就不要再点/);
  });

  await check("W9 行为：流水「加载中」不会卡死（前台在路上、静默刷新后发先回）；办完一笔回第 1 页、晚到的旧页用不上；静默失败不吭声", async () => {
    const { createLedgerLoader } = await import("../apps/web/src/modules/wallet/ledger-loader");
    type Pending = { q: { clientId: string; page: number }; resolve: (v: any) => void; reject: (e: Error) => void };
    const pending: Pending[] = [];
    const shown: Array<{ page: number; tag: string }> = [];
    const loadingLog: boolean[] = [];
    const errors: string[] = [];
    const loader = createLedgerLoader<string>({
      fetchPage: (q) => new Promise((resolve, reject) => pending.push({ q, resolve, reject })),
      onData: (d) => shown.push({ page: d.page, tag: d.items[0] }),
      onError: (m) => { if (m) errors.push(m); },
      onLoading: (l) => loadingLog.push(l),
    });
    const page = (tag: string, p: number) => ({ items: [tag], page: p, total: 200, balance: 0 });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    // 审查说的那个时序：前台 A（回第 1 页）在路上，推送触发的静默刷新 B 后发、先回；A 后回
    const a = loader.goTo("C1", 1);
    const b = loader.refreshSilently();
    pending[1].resolve(page("B", 1));
    await b;
    pending[0].resolve(page("A", 1));
    await a;
    assert.equal(loadingLog.at(-1), false, "「加载中」熄了（原来这里永远是 true）");
    assert.deepEqual(shown, [{ page: 1, tag: "B" }], "后发先回的 B 用上了，比它旧的 A 不再盖回去");
    // 停在第 3 页时，静默刷新（第 3 页）在路上；管理员办完一笔 → 回第 1 页；第 3 页那次晚到也用不上
    const g3 = loader.goTo("C1", 3);
    pending[2].resolve(page("P3", 3));
    await g3;
    const s3 = loader.refreshSilently();
    const g1 = loader.goTo("C1", 1);
    pending[4].resolve(page("NEW", 1));
    await g1;
    pending[3].resolve(page("P3-late", 3));
    await s3;
    assert.deepEqual(shown.at(-1), { page: 1, tag: "NEW" }, "办完一笔回到第 1 页，看得到刚加的那一笔");
    assert.equal(loadingLog.at(-1), false);
    // 静默刷新失败：不吭声、不动「加载中」；前台失败：报出来、「加载中」照样熄
    const before = errors.length;
    const s = loader.refreshSilently();
    pending[5].reject(new Error("断了"));
    await s;
    assert.equal(errors.length, before, "静默失败不吭声");
    const f = loader.goTo("C1", 2);
    pending[6].reject(new Error("流水没加载出来：网络断了"));
    await f;
    assert.equal(errors.at(-1), "流水没加载出来：网络断了");
    assert.equal(loadingLog.at(-1), false);
    // 两个前台请求一前一后：先回的那个不许提前熄掉后一个的「加载中」
    const x = loader.goTo("C1", 1);
    const y = loader.goTo("C1", 2);
    pending[7].resolve(page("X", 1));
    await x;
    assert.equal(loadingLog.at(-1), true, "第二个还在路上，「加载中」还亮着");
    pending[8].resolve(page("Y", 2));
    await y;
    assert.equal(loadingLog.at(-1), false);
    assert.deepEqual(shown.at(-1), { page: 2, tag: "Y" });
    await tick();
  });

  await check("W5 「集货余额」给人看的字一个不剩（注释、标识符、老测试的历史数据不算）；菜单 / 标题改名；代理入口改名但照旧关着", () => {
    const left: string[] = [];
    for (const f of [...walk(path.join(ROOT, "apps/web/src"), [".ts", ".tsx"]), ...walk(path.join(ROOT, "apps/api/src"), [".ts"])]) {
      const src = fs.readFileSync(f, "utf8").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
      src.split("\n").forEach((l, i) => { if (l.includes("集货余额")) left.push(`${path.relative(ROOT, f)}:${i + 1} ${l.trim()}`); });
    }
    assert.deepEqual(left, [], `还有给人看的「集货余额」：\n${left.join("\n")}`);
    const menu = read("apps/web/src/modules/layout/menu-config.ts");
    assert.match(menu, /\{ id: "staff-func-wallet", label: "客户余额", href: "\/staff#staff-wallet" \}/);
    assert.match(menu, /\{ id: "client-func-wallet", label: "余额", href: "\/client\/wallet" \}/);
    assert.match(menu, /\.\.\.\(AGENT_WHR_FEATURES_ENABLED\s*\?\s*\[[\s\S]*?\{ id: "agent-func-wallet", label: "客户余额", href: "\/agent#wallet" \}/, "代理入口改名、照旧在开关后面");
    assert.match(read("apps/web/src/modules/agent/agent-features.ts"), /AGENT_WHR_FEATURES_ENABLED = false/);
    assert.match(read("apps/web/src/modules/layout/WorkbenchFrame.tsx"), /"\/client\/wallet": "余额",/);
  });

  await check("W6 前端手写类型跟后端返回字段对得上（客户列表、流水、加减结果、冲掉结果）", () => {
    const api = read("apps/web/src/services/business-api.ts");
    const fieldsOf = (iface: string) => {
      const body = api.slice(api.indexOf(`export interface ${iface} {`), api.indexOf("\n}", api.indexOf(`export interface ${iface} {`)));
      return [...body.matchAll(/^\s+(\w+)\??:/gm)].map((m) => m[1]).sort();
    };
    assert.deepEqual(fieldsOf("StaffWalletClientItem"), ["balance", "clientId", "status", "updatedAt"]);
    assert.deepEqual(fieldsOf("StaffWalletLedgerItem"), ["adjustment", "amount", "balanceAfter", "createdAt", "id", "operatorName", "refNo", "remark", "source", "type", "typeLabel"]);
    assert.deepEqual(fieldsOf("StaffWalletLedgerAdjustment"), ["canReverse", "hasProof", "id", "kind", "reversed"]);
    const r = code("apps/api/src/modules/wallet/admin-adjust-routes.ts");
    // 后端那边逐个列出来的字段（流水一行）
    const ledgerItem = r.slice(r.indexOf("        return {\n          id: r.id,"), r.indexOf("      page,\n      pageSize,\n      total,"));
    for (const k of ["id", "type", "typeLabel", "amount", "balanceAfter", "source", "refNo", "remark", "operatorName", "createdAt", "adjustment", "canReverse", "hasProof", "reversed", "at", "reason", "byName"]) {
      assert.match(ledgerItem, new RegExp(`\\b${k}:`), `后端流水一行没有 ${k}`);
    }
    for (const k of ["clientId", "status", "balance", "updatedAt"]) assert.match(r.slice(r.indexOf("clients: users.map"), r.indexOf("total: users.length")), new RegExp(`\\b${k}:`));
    assert.match(r, /adjustment: \{\s*id: a\.id,\s*kind: a\.kind,\s*clientId: a\.clientId,\s*amount: Number\(a\.amount\),\s*remark: a\.remark \?\? "",\s*hasProof,\s*createdAt: a\.createdAt\.toISOString\(\),\s*\},\s*balanceAfter: Number\(a\.balanceAfter\),\s*duplicate,/);
    assert.match(api, /adjustment: \{ id: string; kind: string; clientId: string; amount: number; remark: string; hasProof: boolean; createdAt: string \};\s*balanceAfter: number;/);
    for (const k of ["adjustmentId", "clientId", "amount", "reason", "reversedAt", "balanceAfter", "duplicate"]) {
      assert.match(r.slice(r.indexOf("ok(res, {\n      adjustmentId"), r.indexOf("duplicate: out.duplicate,") + 30), new RegExp(`\\b${k}:`));
      assert.match(api.slice(api.indexOf("export async function adminWalletReverse"), api.indexOf("export async function fetchAdminAdjustmentProof")), new RegExp(`\\b${k}: `));
    }
  });

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
