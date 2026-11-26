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
    for (const bad of ["javascript:alert(1)", "data:text/html;base64,PHNjcmlwdD4=", "data:image/svg+xml;base64,PHN2Zz4=", 'x" onerror="alert(1)', "/images/../x", "https://evil.example/x.png", `data:image/png;base64,${"A".repeat(8 * 1024 * 1024)}`]) {
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
    for (const t of txs) assert.match(t.trimStart(), /^await lockWalletAdjustSubmit\(tx, input\.submitKey\);/, "事务第一句必须是提交编号排队锁");
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
    assert.match(r, /byName: seeOperator \? \(adj\.reversedByName \?\? ""\) : undefined,/);
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
    assert.match(page, /crypto\.getRandomValues\(bytes\)/);
    for (const fn of ["adminWalletTopup", "adminWalletDeduct", "adminWalletReverse"]) assert.match(page, new RegExp(`${fn}\\(\\{[^}]*submitKey: dialog\\.submitKey`), fn);
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
    assert.match(menu, /\.\.\.\(AGENT_WHR_FEATURES_ENABLED\s*\?\s*\[[\s\S]*?\{ id: "agent-func-wallet", label: "余额", href: "\/agent#wallet" \}/, "代理入口改名、照旧在开关后面");
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
    assert.match(r, /adjustment: \{\s*id: a\.id,\s*kind: a\.kind,\s*clientId: a\.clientId,\s*amount: Number\(a\.amount\),\s*remark: a\.remark \?\? "",\s*hasProof: !!a\.proofImage,\s*createdAt: a\.createdAt\.toISOString\(\),\s*\},\s*balanceAfter: Number\(a\.balanceAfter\),\s*duplicate,/);
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
