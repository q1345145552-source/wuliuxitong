/**
 * 财务系统2 客户余额（2026-11-27，ADR 0191，约定第 12 节）—— 不连库那一半。连库的在 test-finance2-balance-db.ts。
 *
 *   S1 配置：开关只认 "true"；没配齐 / 跟只读接口同一把钥匙 → 关着；新旧两把
 *   S2 路径：四条精确路径；server.ts 只对它们跳过登录解析；main.ts 注册了；推送归类不误伤
 *   S3 收进来的格式：金额只认两位小数字符串，requestId / billKind / reason / 唛头 / 账单号逐个挡
 *   S4 指纹：内容一样 ⇔ 指纹一样；多带的字段不算；扣款和退回不会撞
 *   S5 发出去的：金额格式（负零给 0.00）、流水 11 个字段、操作人规则、游标来回
 *   S6 源码规矩：不许 ...row；事务第一句是编号排队锁、已在锁序测试登记；钱包函数先锁后读、扣款不建钱包行、退回先建行再锁；
 *      关联类型不跟集货共用；推送只推那一个客户的 wallet；客户余额页的中文名覆盖全部流水类型
 *   S7 环境变量进了两份样例和 docker-compose（只透传给 api 一处）；迁移文件只加不删、可重复跑
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
/** 去掉注释（看真代码用） */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; console.log(`❌ ${name}\n   ${(e instanceof Error ? e.stack ?? e.message : String(e)).split("\n").slice(0, 6).join("\n   ")}`); }
}

async function main(): Promise<void> {
  const { readFinance2BalanceConfig } = await import("../apps/api/src/modules/finance2-balance/config");
  const paths = await import("../apps/api/src/modules/finance2-balance/paths");
  const views = await import("../apps/api/src/modules/finance2-balance/views");
  const { sha256HexOf } = await import("../apps/api/src/modules/finance2/api-key");
  const { isFinance2Path } = await import("../apps/api/src/modules/finance2/paths");
  const { topicForWrite } = await import("../apps/api/src/modules/realtime/topics");
  const { publishAfterWrite } = await import("../apps/api/src/modules/realtime/publish");
  const { Prisma } = await import("@prisma/client");

  const KEY = "k3y-for-balance-0123456789abcdefghij";
  const fp = sha256HexOf(KEY);
  const base = { FINANCE2_BALANCE_ENABLED: "true", FINANCE2_COMPANY_ID: "c1", FINANCE2_BALANCE_KEY_SHA256: fp };

  await check("S1 配置：开关只认 \"true\"；公司 / 指纹没配齐、指纹格式不对、新旧同一把、跟只读接口同一把 → 关着；配齐了新旧两把都在", () => {
    for (const v of [undefined, "", "1", "TRUE", "yes", " true"]) assert.equal(readFinance2BalanceConfig({ ...base, FINANCE2_BALANCE_ENABLED: v }).ok, false, `开关=${v}`);
    assert.equal(readFinance2BalanceConfig({ ...base, FINANCE2_COMPANY_ID: "" }).ok, false);
    assert.equal(readFinance2BalanceConfig({ ...base, FINANCE2_COMPANY_ID: " c1" }).ok, false);
    assert.equal(readFinance2BalanceConfig({ ...base, FINANCE2_BALANCE_KEY_SHA256: "" }).ok, false);
    assert.equal(readFinance2BalanceConfig({ ...base, FINANCE2_BALANCE_KEY_SHA256: KEY }).ok, false, "填了密钥本身而不是指纹");
    assert.equal(readFinance2BalanceConfig({ ...base, FINANCE2_BALANCE_KEY_SHA256: fp.toUpperCase() }).ok, false);
    assert.equal(readFinance2BalanceConfig({ ...base, FINANCE2_BALANCE_KEY_SHA256_PREV: fp }).ok, false, "新旧同一把");
    assert.equal(readFinance2BalanceConfig({ ...base, FINANCE2_API_KEY_SHA256: fp }).ok, false, "跟只读接口同一把");
    assert.equal(readFinance2BalanceConfig({ ...base, FINANCE2_API_KEY_SHA256_PREV: fp.toUpperCase() }).ok, false, "跟只读接口上一把同一把（大小写不同也算）");
    const ok = readFinance2BalanceConfig({ ...base, FINANCE2_BALANCE_KEY_SHA256_PREV: sha256HexOf("old"), FINANCE2_API_KEY_SHA256: sha256HexOf("read") });
    assert.ok(ok.ok);
    if (ok.ok) {
      assert.equal(ok.cfg.companyId, "c1");
      assert.equal(ok.cfg.fingerprints.length, 2);
    }
  });

  await check("S2 路径：四条精确路径，只认精确的；不跟只读接口那组混；server.ts 只对它们跳过登录解析；main.ts 注册了；推送归类不误伤", () => {
    const four = [paths.FINANCE2_BALANCE_BALANCES_PATH, paths.FINANCE2_BALANCE_CHARGES_PATH, paths.FINANCE2_BALANCE_REFUNDS_PATH, paths.FINANCE2_BALANCE_LEDGER_PATH];
    assert.deepEqual(four, ["/integrations/finance2-balance/v1/balances", "/integrations/finance2-balance/v1/charges", "/integrations/finance2-balance/v1/refunds", "/integrations/finance2-balance/v1/ledger"]);
    for (const p of four) {
      assert.equal(paths.isFinance2BalancePath(p), true);
      assert.equal(isFinance2Path(p), false, "跟只读接口那组分开");
      // 对接请求没有登录身份，server.ts 的自动推送本来就不推；这里再确认路径不会被归成别的类
      assert.equal(topicForWrite(p), null);
    }
    for (const p of ["/integrations/finance2-balance/v1", "/integrations/finance2-balance/v1/", "/integrations/finance2-balance/v1/charges/", "/integrations/finance2-balance/v1/charges/x", "/integrations/finance2-balance/v2/charges", "/integrations/finance2/v1/charges"]) {
      assert.equal(paths.isFinance2BalancePath(p), false, p);
    }
    const server = code("apps/api/src/server.ts");
    assert.match(server, /if \(path && isFinance2BalancePath\(path\)\) return undefined;/);
    assert.ok(server.indexOf("isFinance2BalancePath(path)") < server.indexOf("const authHeader"), "要在解析令牌之前");
    assert.match(code("apps/api/src/main.ts"), /\nregisterFinance2BalanceRoutes\(app\);/);
    // 没登录身份的写请求，自动推送一条都不发
    const sent: unknown[] = [];
    publishAfterWrite({ method: "POST", path: paths.FINANCE2_BALANCE_CHARGES_PATH, query: {}, headers: {} } as any, 200, { publish: (e: unknown) => sent.push(e) } as any);
    assert.deepEqual(sent, []);
  });

  await check("S3 收进来的格式：金额只认大于 0 的两位小数字符串；requestId / 唛头 / 账单号 / 种类 / 原因逐个挡；多带的字段不报错", () => {
    const good = { requestId: "c2-chg-1042", customerMark: "cm3client0001", billNo: "B202612-003", billKind: "bulk", maxAmount: "530.00" };
    const ok = views.parseChargeBody({ ...good, extra: 1 });
    assert.ok(ok.ok);
    if (ok.ok) assert.deepEqual(ok.value, good, "多带的字段不往下传");
    assert.ok(views.parseChargeBody({ ...good, billKind: "fcl", maxAmount: "0.01", requestId: "A".repeat(64) }).ok);
    assert.ok(views.parseChargeBody({ ...good, maxAmount: "999999999999.99" }).ok, "12 位整数是 Decimal(14,2) 的上限");
    const badMoney = [530, "530", "530.0", "530.000", "0.00", "-1.00", "+1.00", "1,000.00", " 530.00", "530.00 ", "¥530.00", "0530.00", "1e3", "1000000000000.00", "", null, true];
    for (const m of badMoney) assert.equal(views.parseChargeBody({ ...good, maxAmount: m }).ok, false, `maxAmount=${JSON.stringify(m)}`);
    for (const id of ["", "a".repeat(65), "有中文", "a b", "a/b", "a.b", 12, null]) assert.equal(views.parseChargeBody({ ...good, requestId: id }).ok, false, `requestId=${id}`);
    for (const m of ["", " x", "x ", "a\nb", "x".repeat(129), 1, null]) assert.equal(views.parseChargeBody({ ...good, customerMark: m }).ok, false, `customerMark=${JSON.stringify(m)}`);
    for (const b of ["", " B1", "B1 ", "B\t1", "x".repeat(65), 1]) assert.equal(views.parseChargeBody({ ...good, billNo: b }).ok, false, `billNo=${JSON.stringify(b)}`);
    for (const k of ["BULK", "other", "", null]) assert.equal(views.parseChargeBody({ ...good, billKind: k }).ok, false, `billKind=${k}`);
    for (const body of [null, undefined, [], "x", 1, [good]]) assert.equal(views.parseChargeBody(body).ok, false);

    const r = { requestId: "c2-rfd-1042-1", chargeRequestId: "c2-chg-1042", amount: "530.00", reason: "billVoided" };
    assert.ok(views.parseRefundBody(r).ok);
    for (const reason of ["billVoided", "receiptVoided", "overCharged"]) assert.ok(views.parseRefundBody({ ...r, reason }).ok);
    for (const reason of ["voided", "", null]) assert.equal(views.parseRefundBody({ ...r, reason }).ok, false);
    for (const amount of badMoney) assert.equal(views.parseRefundBody({ ...r, amount }).ok, false, `amount=${JSON.stringify(amount)}`);
    for (const id of ["", "a b", null]) assert.equal(views.parseRefundBody({ ...r, chargeRequestId: id }).ok, false);
  });

  await check("S4 指纹：内容一样指纹一样（多带的字段不算）；任何一个字段变了指纹就变；扣款和退回不会撞", () => {
    const c = { requestId: "x", customerMark: "M", billNo: "B", billKind: "bulk" as const, maxAmount: "1.00" };
    assert.equal(views.chargeFingerprint(c), views.chargeFingerprint({ ...c }));
    assert.equal(views.chargeFingerprint(c), views.chargeFingerprint({ ...c, requestId: "y" }), "编号本身不算内容（同号才比）");
    for (const ch of [{ customerMark: "M2" }, { billNo: "B2" }, { billKind: "fcl" as const }, { maxAmount: "1.01" }]) {
      assert.notEqual(views.chargeFingerprint(c), views.chargeFingerprint({ ...c, ...ch }), JSON.stringify(ch));
    }
    // 拼接不会串：「M」+「B,x」跟「M,B」+「x」不能一样
    assert.notEqual(views.chargeFingerprint({ ...c, customerMark: "M", billNo: "B,x" }), views.chargeFingerprint({ ...c, customerMark: "M,B", billNo: "x" }));
    const r = { requestId: "x", chargeRequestId: "C", amount: "1.00", reason: "billVoided" as const };
    for (const ch of [{ chargeRequestId: "C2" }, { amount: "2.00" }, { reason: "overCharged" as const }]) {
      assert.notEqual(views.refundFingerprint(r), views.refundFingerprint({ ...r, ...ch }));
    }
    assert.match(views.chargeFingerprint(c), /^[0-9a-f]{64}$/);
  });

  await check("S5 发出去的：金额两位小数（负零给 0.00）；流水就 11 个字段；客户自己付的显示唛头、系统的 null、员工的照写名字；游标来回不变、坏的不收", () => {
    assert.equal(views.money(new Prisma.Decimal("5300")), "5300.00");
    assert.equal(views.money(new Prisma.Decimal("-120")), "-120.00");
    assert.equal(views.money(new Prisma.Decimal("-0")), "0.00");
    assert.equal(views.money("0.10"), "0.10");
    const row = { id: "l1", client_id: "M1", type: "pay", amount: "-100.00", balance_after: "0.00", ref_type: "normal", ref_id: "t1", ref_no: "JH1", remark: "r", operator_id: "M1", operator_name: "客户真名", created_at: "2026-12-05T03:10:00.000Z", tx_id: "9" };
    const m = views.mapLedgerRow(row);
    assert.deepEqual(Object.keys(m), [...views.LEDGER_ITEM_KEYS]);
    assert.deepEqual(views.LEDGER_ITEM_KEYS, ["id", "customerMark", "type", "amount", "balanceAfter", "refType", "refId", "refNo", "remark", "operatorName", "createdAt"]);
    assert.equal(m.operatorName, "M1", "客户自己付的：唛头，不是名字");
    assert.equal(m.customerMark, "M1");
    assert.equal(views.mapLedgerRow({ ...row, operator_id: null, operator_name: null }).operatorName, null);
    assert.equal(views.mapLedgerRow({ ...row, operator_id: "admin1", operator_name: "管理员甲" }).operatorName, "管理员甲");
    assert.equal("tx_id" in m, false, "事务号不往外给");

    const cur = { x: "123456789012", t: "2026-12-05T03:10:00.000Z", i: "clxyz" };
    assert.deepEqual(views.decodeLedgerCursor(views.encodeLedgerCursor(cur)), cur);
    assert.deepEqual(views.decodeLedgerCursor(views.encodeLedgerCursor(views.LEDGER_START)), views.LEDGER_START);
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    for (const bad of [
      "", "!!", "a".repeat(1001), enc([]), enc({ x: "1", t: cur.t }), enc({ ...cur, extra: "1" }), enc({ ...cur, x: "1.5" }), enc({ ...cur, x: "-2" }),
      enc({ ...cur, x: "01" }), enc({ ...cur, x: "99999999999999999999" }), enc({ ...cur, t: "2026-12-05T03:10:00Z" }), enc({ ...cur, t: "2026-02-31T00:00:00.000Z" }),
      enc({ ...cur, i: 1 }), enc({ ...cur, i: "a\nb" }),
    ]) assert.equal(views.decodeLedgerCursor(bad), null, bad.slice(0, 40));
  });

  await check("S6 源码规矩：不许 ...row；事务第一句是编号排队锁（已登记锁序）；钱包先锁后读、扣款不建行、退回先建行再锁、锁里重算能退多少；关联类型不共用；推送只推那一个客户的 wallet", () => {
    for (const f of ["routes.ts", "views.ts", "ledger.ts", "ops.ts"]) {
      assert.doesNotMatch(code(`apps/api/src/modules/finance2-balance/${f}`), /\.\.\.\s*(row|r|stored|seen|l|item|it|a|c)\b/, `${f} 里整条展开了（CLAUDE.md 第 31 条）`);
    }
    const ops = code("apps/api/src/modules/finance2-balance/ops.ts");
    const txBodies = ops.split("$transaction(async (tx) => {").slice(1);
    assert.equal(txBodies.length, 2, "扣款、退回两个事务");
    // 2026-11-27 审查第 4 条：第一句先给等锁 / 单条语句设时限（数据库自己的 lock_timeout / statement_timeout），紧接着才是编号排队锁
    for (const body of txBodies) assert.match(body.trimStart(), /^await limitWaits\(tx\);\s*await lockFinance2BalanceRequest\(tx, req\.requestId\);/, "事务开头必须是：设时限 → 编号排队锁");
    assert.match(ops, /SET LOCAL lock_timeout = '4s'/);
    assert.match(ops, /SET LOCAL statement_timeout = '5s'/);
    assert.match(ops, /const TX_OPTIONS = \{ maxWait: 1_500, timeout: 6_000 \} as const;/, "等连接 + 事务 ≤ 7.5 秒（财务等 10 秒）");
    assert.match(ops, /pg_advisory_xact_lock\(\$\{REQUEST_LOCK_KEY\}::int, hashtext\(\$\{requestId\}\)\)/);
    assert.match(ops, /const REQUEST_LOCK_KEY = 83092;/);
    assert.match(read("scripts/test-lock-order.ts"), /lockFinance2BalanceRequest: \["advisory_finance2_balance_request"\]/);
    // 83092 全仓只有这一处在用
    const hits: string[] = [];
    const walk = (dir: string): void => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".ts") && /83092/.test(fs.readFileSync(p, "utf8"))) hits.push(path.relative(ROOT, p)); } };
    walk(path.join(ROOT, "apps/api/src"));
    assert.deepEqual(hits, ["apps/api/src/modules/finance2-balance/ops.ts"]);

    const wal = code("apps/api/src/modules/wallet/consolidation-balance.ts");
    const lockRead = wal.slice(wal.indexOf("async function lockAndReadWallet"), wal.indexOf("function positiveMoney"));
    assert.match(lockRead, /SELECT balance::text AS balance FROM client_wallet_accounts\s+WHERE "clientId" = \$\{clientId\} AND currency = \$\{CONSOLIDATION_CURRENCY\}\s+FOR UPDATE/, "锁和读是同一句；列名 \"clientId\" 是驼峰的");
    const chargeFn = wal.slice(wal.indexOf("export async function chargeBillUpTo"), wal.indexOf("export async function refundBillCharge"));
    assert.ok(chargeFn.indexOf("lockAndReadWallet(") >= 0 && chargeFn.indexOf("lockAndReadWallet(") < chargeFn.indexOf("clientWalletAccount.update"), "先锁后改");
    assert.doesNotMatch(chargeFn, /INSERT INTO|upsert|findUnique/, "扣款不建钱包行、不另外再读一遍");
    assert.match(chargeFn, /Decimal\.min\(cap, Decimal\.max\(have, 0\)\)/, "实扣 = min(上限, max(余额, 0))");
    assert.match(chargeFn, /"bill_charge",\s*charged\.neg\(\)/);
    const refundFn = wal.slice(wal.indexOf("export async function refundBillCharge"));
    const iIns = refundFn.indexOf("ON CONFLICT DO NOTHING"), iLock = refundFn.indexOf("lockAndReadWallet("), iAgg = refundFn.indexOf("consolidationBalanceLedger.aggregate"), iUpd = refundFn.indexOf("clientWalletAccount.update");
    assert.ok(iIns > 0 && iIns < iLock && iLock < iAgg && iAgg < iUpd, "退回：先保证行在 → 锁 → 锁里按流水算能退多少 → 改");
    assert.match(refundFn, /"bill_refund",\s*amount,/);
    assert.match(wal, /export const FINANCE2_CHARGE_REF_TYPE = "finance2_charge";/);
    for (const [fnName, refType] of [["chargeBillUpTo", "FINANCE2_CHARGE_REF_TYPE"], ["refundBillCharge", "FINANCE2_CHARGE_REF_TYPE"]]) {
      const body = wal.slice(wal.indexOf(`export async function ${fnName}`));
      assert.match(body.slice(0, 2500), new RegExp(`refType: ${refType},`), `${fnName} 的关联类型`);
    }
    // 集货那几条路照旧写自己的关联类型，没人用 finance2_charge
    for (const f of ["apps/api/src/modules/consolidation/routes.ts", "apps/api/src/modules/whr-consolidation/routes.ts", "apps/api/src/modules/whr-consolidation/client-routes.ts", "apps/api/src/modules/admin/routes.ts"]) {
      assert.doesNotMatch(code(f), /finance2_charge|FINANCE2_CHARGE_REF_TYPE|chargeBillUpTo|refundBillCharge/, f);
    }

    const routes = code("apps/api/src/modules/finance2-balance/routes.ts");
    assert.match(routes, /realtimeHub\.publish\(\{\s*companyId,\s*topic: "wallet",\s*actor: \{ userId: "system:finance2-balance", role: "staff", agentId: null \},\s*clientIds: \[clientId\],\s*\}\)/);
    assert.match(routes, /if \(!duplicate && stored\.ledgerId\) notifyWalletChanged\(cfg\.companyId, stored\.clientId\);/, "扣款：真扣了才推");
    assert.match(routes, /if \(!duplicate\) notifyWalletChanged\(cfg\.companyId, stored\.clientId\);/, "退回：不是重复的才推");
    // 出错一律带 serverTime + error
    assert.match(routes, /res\.status\(status\)\.json\(\{ serverTime: new Date\(\)\.toISOString\(\), error, message \}\)/);
    assert.doesNotMatch(routes, /\bok\(res|\bfail\(res/, "不走 {code,data} 外壳");
  });

  await check("S6b 客户余额页：流水类型的全集（LedgerType）每一种都有中文名；关联类型 finance2_charge 有中文名", () => {
    const wal = read("apps/api/src/modules/wallet/consolidation-balance.ts");
    const union = wal.slice(wal.indexOf("export type LedgerType ="), wal.indexOf(";", wal.indexOf("export type LedgerType =")));
    const types = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    assert.deepEqual(types, ["pay", "refund", "recharge", "bill_charge", "bill_refund", "topup", "topup_reversal", "deduction"]);
    const cc = code("apps/api/src/modules/client-compliance/routes.ts");
    const typeZh = cc.slice(cc.indexOf("const typeZh"), cc.indexOf("};", cc.indexOf("const typeZh")));
    for (const t of types) assert.match(typeZh, new RegExp(`\\b${t}: "[^"a-z]+"`), `${t} 没有中文名`);
    assert.match(typeZh, /bill_charge: "运费账单扣款"/);
    assert.match(typeZh, /bill_refund: "账单作废退回"/);
    assert.match(typeZh, /topup: "管理员充值"/);
    assert.match(typeZh, /topup_reversal: "冲掉充值"/);
    assert.match(typeZh, /deduction: "管理员减金额"/);
    assert.match(cc, /finance2_charge: "运费账单"/);
  });

  await check("S7 三个环境变量进了 .env.example / env.example（不写值）、docker-compose 只透传给 api 一处；迁移只加不删、可重复跑", () => {
    for (const file of [".env.example", "env.example"]) {
      const s = read(file);
      for (const name of ["FINANCE2_BALANCE_ENABLED", "FINANCE2_BALANCE_KEY_SHA256", "FINANCE2_BALANCE_KEY_SHA256_PREV"]) {
        assert.match(s, new RegExp(`^${name}=$`, "m"), `${file} 里 ${name}`);
      }
    }
    const compose = read("docker-compose.yml");
    for (const name of ["FINANCE2_BALANCE_ENABLED", "FINANCE2_BALANCE_KEY_SHA256", "FINANCE2_BALANCE_KEY_SHA256_PREV"]) {
      assert.equal(compose.split("\n").filter((l) => new RegExp(`\\b${name}\\b`).test(l) && !l.trim().startsWith("#")).join("\n"), `      ${name}: \${${name}:-}`, `${name} 只透传给 api 一处`);
      assert.ok(compose.indexOf(`${name}:`) < compose.indexOf("NEXT_PUBLIC_API_BASE_URL"), "要在 api 那一段");
    }
    const mig = read("apps/api/prisma/migrations/20261127_finance2_balance/migration.sql").replace(/--[^\n]*/g, "");
    assert.doesNotMatch(mig, /\bDROP\b|\bDELETE\s+FROM\b|\bUPDATE\s+"?\w+"?\s+SET\b|\bTRUNCATE\b/i, "只加不删（外键的 ON DELETE RESTRICT 不算）");
    assert.match(mig, /ALTER TABLE "consolidation_balance_ledger"\s+ADD COLUMN IF NOT EXISTS "tx_id" BIGINT NOT NULL DEFAULT 0,\s+ALTER COLUMN "tx_id" SET DEFAULT \(\(pg_current_xact_id\(\)\)::text\)::bigint;/, "加列和换默认值同一句");
    assert.match(mig, /CREATE TABLE IF NOT EXISTS "finance2_balance_requests"/);
    assert.equal((mig.match(/CREATE INDEX IF NOT EXISTS/g) ?? []).length, 3);
    assert.equal((mig.match(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/g) ?? []).length, 3);
    // schema 里的默认值跟迁移一字不差（不然 prisma migrate diff 永远有差异）
    assert.match(read("apps/api/prisma/schema.prisma"), /txId\s+BigInt\s+@default\(dbgenerated\("\(\(pg_current_xact_id\(\)\)::text\)::bigint"\)\) @map\("tx_id"\)/);
    // 账号引用清单登记了新表的客户列（员工号改客户号时要查）
    assert.match(read("apps/api/src/modules/admin/user-references.ts"), /\["finance2_balance_requests", "client_id"\]/);
  });

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
