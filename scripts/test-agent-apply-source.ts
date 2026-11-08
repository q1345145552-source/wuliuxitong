/**
 * 代理申请（2026-11-08，老板：「财务提交，物流审批」）不连库测试：字段规则、返回格式、接线、迁移文件。
 * 用法：npx tsx scripts/test-agent-apply-source.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  APPLICATIONS_PER_WAREHOUSE_MAX,
  FINANCE_APPLICATION_SELECT,
  WAREHOUSE_ID_MAX,
  cleanApplyText,
  mapFinanceAgentApplication,
  parseAgentApplicationBody,
  parseWarehouseIdQuery,
} from "../apps/api/src/modules/finance-link/agent-application-views";
import { AGENT_APPLICATIONS_PATH, FINANCE_LINK_PATHS } from "../apps/api/src/modules/finance-link/paths";

const ROOT = path.join(__dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
let passes = 0;
let failures = 0;
function check(name: string, fn: () => void): void {
  try { fn(); passes++; console.log(`✅ ${name}`); } catch (e) { failures++; console.log(`❌ ${name}\n   ${e instanceof Error ? e.message.split("\n").slice(0, 8).join("\n   ") : String(e)}`); }
}

const GOOD = { warehouseId: 12, warehouseName: "曼谷 A 仓", submittedBy: "张三", agentName: "曼谷 A 仓", contactName: "李四", contactPhone: "0812345678", loginId: "bkk-a", remark: "可以不传" };
const parse = (extra: Record<string, unknown>) => parseAgentApplicationBody({ ...GOOD, ...extra });
const msg = (r: ReturnType<typeof parseAgentApplicationBody>) => (r.ok ? "" : r.message);
const APPLICATION_KEYS = ["agentName", "approvedLoginId", "contactName", "contactPhone", "createdAt", "id", "loginId", "rejectReason", "remark", "reviewedAt", "status", "submittedBy"];

check("S1 合格的请求体照收；文字去首尾空格、去控制字符；备注不传 / 空 = null", () => {
  assert.deepEqual(parseAgentApplicationBody(GOOD), { ok: true, value: GOOD });
  const r = parse({ warehouseName: " \t曼谷\u0000 A 仓\u0085 ", loginId: "  bkk-a ", remark: "\u001b  备注 " });
  assert.ok(r.ok);
  assert.equal(r.value.warehouseName, "曼谷 A 仓");
  assert.equal(r.value.loginId, "bkk-a");
  assert.equal(r.value.remark, "备注");
  const noRemark = parseAgentApplicationBody({ ...GOOD, remark: undefined });
  assert.ok(noRemark.ok && noRemark.value.remark === null);
  const { remark: _drop, ...withoutRemark } = GOOD;
  const absent = parseAgentApplicationBody(withoutRemark);
  assert.ok(absent.ok && absent.value.remark === null);
  const blank = parse({ remark: "  " });
  assert.ok(blank.ok && blank.value.remark === null);
  assert.equal(cleanApplyText(12), null);
  assert.equal(cleanApplyText(" a\u0007b "), "ab");
});

check("S2 每个字段的边界：长度刚好过、多一个字不过；仓号只认 1～2147483647 的整数", () => {
  assert.ok(parse({ warehouseName: "仓".repeat(100), submittedBy: "张".repeat(100), agentName: "代".repeat(50), contactName: "联".repeat(50), contactPhone: "1".repeat(40), remark: "备".repeat(500) }).ok);
  assert.match(msg(parse({ warehouseName: "仓".repeat(101) })), /仓名太长了（最多 100 个字）/);
  assert.match(msg(parse({ submittedBy: "张".repeat(101) })), /提交人太长了（最多 100 个字）/);
  assert.match(msg(parse({ agentName: "代".repeat(51) })), /代理名字太长了（最多 50 个字）/);
  assert.match(msg(parse({ contactName: "联".repeat(51) })), /联系人太长了（最多 50 个字）/);
  assert.match(msg(parse({ contactPhone: "1".repeat(41) })), /联系电话太长了（最多 40 个字）/);
  assert.match(msg(parse({ remark: "备".repeat(501) })), /备注太长了（最多 500 个字）/);
  assert.ok(parse({ warehouseId: 1 }).ok);
  assert.ok(parse({ warehouseId: WAREHOUSE_ID_MAX }).ok);
  for (const bad of [0, -1, 1.5, WAREHOUSE_ID_MAX + 1, "12", Number.NaN, Number.POSITIVE_INFINITY, true, [12], { a: 1 }]) {
    assert.match(msg(parse({ warehouseId: bad })), /仓库编号要是正整数/, JSON.stringify(bad));
  }
  for (const missing of [undefined, null, ""]) assert.match(msg(parse({ warehouseId: missing })), /请填仓库编号/);
});

check("S3 必填的缺了 / 空的 / 只有空格或控制字符：中文说填什么；不是文字说要是文字", () => {
  const cases: Array<[string, string]> = [["warehouseName", "请填仓名"], ["submittedBy", "请填提交人"], ["agentName", "请填代理名字"], ["contactName", "请填联系人"], ["contactPhone", "请填联系电话"], ["loginId", "请填登录账号"]];
  for (const [key, text] of cases) {
    for (const v of [undefined, null, "", "   ", "\u0001\u0002"]) assert.equal(msg(parse({ [key]: v })), text, `${key}=${JSON.stringify(v)}`);
  }
  for (const key of ["warehouseName", "submittedBy", "agentName", "contactName", "contactPhone", "loginId", "remark"]) {
    assert.match(msg(parse({ [key]: 123 })), /要是文字/, key);
  }
});

check("S4 登录账号跟开代理同一个规则（validateAgentLoginId）；交申请时不查账号有没有人用（这里压根不碰库）", () => {
  for (const bad of ["ab", "bkk a", "曼谷", "a".repeat(41), "bkk/a", "bkk#a"]) assert.match(msg(parse({ loginId: bad })), /登录账号只能用字母、数字和 _ \. @ -，3 到 40 位/, bad);
  for (const okId of ["abc", "bkk-a", "bkk_a.1@x", "A".repeat(40)]) assert.ok(parse({ loginId: okId }).ok, okId);
  const views = read("apps/api/src/modules/finance-link/agent-application-views.ts");
  assert.ok(views.includes('import { validateAgentLoginId } from "../agents/agent-rules";'));
  assert.ok(!/prisma/.test(views.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), "纯函数文件不碰库");
  const routes = read("apps/api/src/modules/finance-link/agent-applications.ts");
  assert.ok(!/user\.findUnique|user\.findFirst|agentCreateTakenMessage|loginId: input\.loginId \}/.test(routes.replace(/\/\*[\s\S]*?\*\//g, "")), "交申请那条不许查账号占没占用");
});

check("S5 多传不认识的字段 400 并点名；请求体不是对象 400", () => {
  assert.equal(msg(parse({ price: 1 })), "不认识的字段：price");
  assert.equal(msg(parse({ agentId: "x", password: "y" })), "不认识的字段：agentId、password");
  assert.equal(msg(parse({ status: "approved" })), "不认识的字段：status", "不许交进来就是已通过");
  for (const bad of [null, undefined, "x", 12, [GOOD]]) assert.match(msg(parseAgentApplicationBody(bad)), /JSON 对象/);
});

check("S6 按仓查的仓号：只认十进制正整数（不带正负号、小数点、空格、前导 0、太大）", () => {
  assert.deepEqual(parseWarehouseIdQuery("12"), { ok: true, value: 12 });
  assert.deepEqual(parseWarehouseIdQuery(String(WAREHOUSE_ID_MAX)), { ok: true, value: WAREHOUSE_ID_MAX });
  for (const bad of ["", undefined, null, "0", "-1", "+1", "1.5", "01", " 1", "1 ", "abc", "2147483648", "12345678901", ["12"], 12]) {
    const r = parseWarehouseIdQuery(bad as unknown);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
  assert.equal(APPLICATIONS_PER_WAREHOUSE_MAX, 20);
});

check("S7 给财务的「申请」正好 12 个字段（时间是 ISO UTC）；选库只选这 12 列，没有代理 id、审批人、公司、仓号、在审标记", () => {
  const row = { id: "a1", status: "approved", agentName: "n", contactName: "c", contactPhone: "p", loginId: "l", remark: null, submitterName: "s",
    createdAt: new Date("2026-11-08T01:02:03.004Z"), reviewedAt: new Date("2026-11-08T02:00:00Z"), rejectReason: null, approvedLoginId: "l2",
    // 多塞几个不该给的，看会不会被带出去
    approvedAgentId: "ag", reviewedById: "admin", companyId: "co", pendingWarehouseId: 1, warehouseId: 1 } as any;
  const v = mapFinanceAgentApplication(row);
  assert.deepEqual(Object.keys(v).sort(), APPLICATION_KEYS);
  assert.equal(v.createdAt, "2026-11-08T01:02:03.004Z");
  assert.equal(v.reviewedAt, "2026-11-08T02:00:00.000Z");
  assert.equal(mapFinanceAgentApplication({ ...row, reviewedAt: null }).reviewedAt, null);
  assert.equal(mapFinanceAgentApplication({ ...row, status: "weird" }).status, "pending");
  assert.equal(v.submittedBy, "s", "库里叫 submitterName，给财务时叫 submittedBy");
  assert.deepEqual(Object.keys(FINANCE_APPLICATION_SELECT).sort(), APPLICATION_KEYS.map((k) => (k === "submittedBy" ? "submitterName" : k)).sort());
  const views = read("apps/api/src/modules/finance-link/agent-application-views.ts");
  const mapper = views.slice(views.indexOf("export function mapFinanceAgentApplication"));
  assert.ok(!/\.\.\.row/.test(mapper), "不许 ...row");
  assert.ok(!/price|password|hash/i.test(mapper), "拼申请的地方不许出现价、密码、哈希");
});

check("S8 接线：路径精确放行；两条都先过对接密钥；公司只认有正常超管的那一家；在审冲突 409 APPLICATION_PENDING；启动时注册了", () => {
  assert.equal(AGENT_APPLICATIONS_PATH, "/integrations/finance/v1/agent-applications");
  assert.ok(FINANCE_LINK_PATHS.has(AGENT_APPLICATIONS_PATH));
  assert.ok(!FINANCE_LINK_PATHS.has("/integrations/finance/v1/agent-applications/"), "精确路径，不按前缀放");
  const routes = read("apps/api/src/modules/finance-link/agent-applications.ts");
  const post = routes.slice(routes.indexOf("app.post(AGENT_APPLICATIONS_PATH"), routes.indexOf("app.get(AGENT_APPLICATIONS_PATH"));
  const get = routes.slice(routes.indexOf("app.get(AGENT_APPLICATIONS_PATH"));
  for (const h of [post, get]) {
    assert.ok(h.length > 0);
    assert.match(h.split("\n")[1] ?? "", /if \(!requireFinanceSecret\(req, res\)\) return;/, "第一句就核密钥");
    assert.match(h, /resolveApplicationCompanyId\((tx)?\)/);
    assert.match(h, /select: FINANCE_APPLICATION_SELECT/);
  }
  // 交申请：排队锁 → 定公司（用事务里的 tx）→ 写，都在一个事务里（Codex 第 2 轮：首次绑定公司不许并发裂开）
  const lockAt = post.indexOf("await lockAgentApplicationIntake(tx);");
  const resolveAt = post.indexOf("const companyId = await resolveApplicationCompanyId(tx);");
  const createAt = post.indexOf("return tx.agentApplication.create({");
  assert.ok(post.indexOf("prisma.$transaction(") > 0 && lockAt > 0 && resolveAt > lockAt && createAt > resolveAt, `${lockAt} ${resolveAt} ${createAt}`);
  assert.match(routes, /async function lockAgentApplicationIntake\([\s\S]*?\): Promise<void> \{\s*await tx\.\$executeRaw`SELECT pg_advisory_xact_lock\(83090\)`;/);
  const page = read("apps/web/src/app/admin/agents/page.tsx");
  assert.match(page, /const appGate = useRef\(createQueryGate<null>\(\)\)\.current;/, "待审数：成功才作废旧的，失败的不作废（request-gate 用法三）");
  assert.match(page, /if \(!appGate\.accept\(ticket, null\)\) return;/);
  assert.match(post, /pendingWarehouseId: input\.warehouseId/);
  assert.match(post, /linkError\(res, 409, "APPLICATION_PENDING", APPLICATION_PENDING_MESSAGE\)/);
  assert.match(get, /where: \{ companyId, warehouseId: wid\.value \}/);
  assert.match(get, /orderBy: \[\{ createdAt: "desc" \}, \{ id: "desc" \}\]/);
  assert.match(get, /take: APPLICATIONS_PER_WAREHOUSE_MAX/);
  assert.match(routes, /where: \{ role: "admin", status: "active" \}/);
  assert.match(routes, /if \(admins\.length !== 1\) return null;/);
  assert.match(routes, /if \(bound\.length > 1 \|\| \(bound\.length === 1 && bound\[0\]\.companyId !== companyId\)\) return null;/, "跟已有申请的公司对不上不收（不悄悄改记到别家）");
  const main = read("apps/api/src/main.ts");
  assert.match(main, /registerFinanceAgentApplicationRoutes\(app\);/);
  assert.match(main, /registerAgentApplicationAdminRoutes\(app\);/);
});

check("S9 超管三条：都 requireRole([\"admin\"])、都按 auth.companyId 查；通过 = 一个事务里先带条件改状态（改到 1 行）再建号再记账号；驳回带条件改", () => {
  const src = read("apps/api/src/modules/agents/application-routes.ts");
  const handlers = ["/admin/agents/applications/list", "/admin/agents/applications/approve", "/admin/agents/applications/reject"].map((p) => {
    const start = src.indexOf(`"${p}"`);
    assert.ok(start > 0, p);
    const next = src.indexOf("app.", start + 10);
    return src.slice(start, next > 0 ? next : undefined);
  });
  for (const h of handlers) {
    assert.match(h, /const auth = requireRole\(req, res, \["admin"\]\);\n\s+if \(!auth\) return;/);
    assert.match(h, /companyId: auth\.companyId/);
  }
  assert.ok(!src.includes('"/admin/agents"'), "接口不许用 /admin/agents 本身");
  const approve = handlers[1];
  assert.match(approve, /parseAgentCreateBody\(body\)/, "跟开代理同一份校验");
  const tx = approve.slice(approve.indexOf("prisma.$transaction"));
  const lock = tx.indexOf("SELECT status FROM agent_applications WHERE id = ${applicationId} AND company_id = ${auth.companyId} FOR UPDATE");
  const claim = tx.indexOf('where: { id: applicationId, companyId: auth.companyId, status: "pending" }');
  assert.ok(lock > 0 && lock < claim, "先锁这张申请、锁里重读，再改（CLAUDE.md #28）");
  assert.match(tx, /if \(locked\[0\]\.status !== "pending"\) throw new BusinessError\(ALREADY_HANDLED, 409/);
  const create = tx.indexOf("tx.agent.create({ data: agentCreateData(auth.companyId, input, logoPath)");
  const record = tx.indexOf("data: { approvedAgentId: created.id, approvedLoginId: input.loginId }");
  assert.ok(claim > 0 && create > claim && record > create, "顺序：带条件改状态 → 建号 → 记开出来的号，都在事务里");
  assert.match(tx, /if \(claimed\.count !== 1\) throw new BusinessError\(ALREADY_HANDLED, 409/);
  assert.match(approve, /if \(logoPath\) \{ try \{ deleteImageFile\(logoPath\); \}/, "失败了 logo 删掉");
  assert.match(tx, /const recorded = await tx\.agentApplication\.updateMany\(\{\s*where: \{ id: applicationId, companyId: auth\.companyId \},/, "最后记账号那一步也带公司条件（#27）");
  assert.ok(!/tx\.agentApplication\.update\(/.test(tx), "事务里不许用只按 id 的 update");
  assert.match(approve, /\{ timeout: 15_000, maxWait: 5_000 \}/, "等锁 + 干活不超过 20 秒，比网页 30 秒短");
  // 两个超管用同一个预填账号点通过：后到的查到账号被占时，要回头看申请是不是已经处理过了（是就 409，不报「账号被占」）——
  // 这条只有两个请求恰好错开时才走得到，连库测试撞不准，这里钉死写法
  assert.match(approve, /if \(taken\) \{\s*[^]*?findFirst\(\{ where: \{ id: applicationId, companyId: auth\.companyId \}, select: \{ status: true \} \}\);\s*if \(now && now\.status !== "pending"\) return fail\(res, 409, "VALIDATION_ERROR", ALREADY_HANDLED\);\s*return fail\(res, 400, "BAD_REQUEST", taken\);/);
  const modal = read("apps/web/src/components/admin/agents/AgentFormModal.tsx");
  assert.ok(modal.includes('{application ? "登录密码（你来设，线下告诉对方）" : "登录密码（代理提供）"}'), "通过申请时密码由超管设（老板 11-08），直接开代理照旧");
  const okAt = approve.lastIndexOf("ok(res, { id: applicationId, status: \"approved\"");
  assert.ok(okAt > approve.indexOf("throw error;"), "回响应放在 try 外面：回响应出错不会把已经用着的 logo 删掉");
  const reject = handlers[2];
  assert.match(reject, /where: \{ id: applicationId, companyId: auth\.companyId, status: "pending" \}/);
  assert.match(reject, /pendingWarehouseId: null/, "驳回清在审标记，这个仓能再交");
  assert.match(reject, /if \(!reason\) return fail\(res, 400, "BAD_REQUEST", "请填驳回原因"\)/);
});

check("S10 /admin/agents/create 用同一份共用函数，返回照旧 { id, loginId }；校验顺序没变（名字 → 后缀 → 域名 → 价 → 账号 → 密码 → 电话 → logo）", () => {
  const src = read("apps/api/src/modules/agents/admin-routes.ts");
  const create = src.slice(src.indexOf('app.post("/admin/agents/create"'), src.indexOf('app.post("/admin/agents/update"'));
  assert.match(create, /const parsed = parseAgentCreateBody\(body\);/);
  assert.match(create, /data: agentCreateData\(auth\.companyId, input, logoPath\)/);
  assert.match(create, /ok\(res, \{ id: created\.id, loginId: input\.loginId \}\);/);
  const parseFn = src.slice(src.indexOf("export function parseAgentCreateBody"), src.indexOf("export async function agentCreateTakenMessage"));
  const order = ["请填代理名字", "validateAgentSlug", "validateAgentDomain", "readPrices(body)", "validateAgentLoginId", "请填代理登录密码", "checkPasswordStrength", "str(body.phone).slice(0, 40)", "readLogo(body)"].map((k) => parseFn.indexOf(k));
  assert.ok(order.every((i) => i > 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "顺序变了");
});

check("S11 迁移文件只建 agent_applications 一张表和它的索引，全部 IF NOT EXISTS；不改别的表、不删东西；结构体检清单登记了 19 个字段", () => {
  const sql = read("apps/api/prisma/migrations/20261108_agent_applications/migration.sql").replace(/--.*$/gm, "");
  assert.ok(!/\b(ALTER|DROP|DELETE|UPDATE|TRUNCATE|INSERT)\b/i.test(sql), "只许建");
  const stmts = sql.split(";").map((x) => x.trim()).filter(Boolean);
  assert.equal(stmts.length, 4);
  assert.match(stmts[0], /^CREATE TABLE IF NOT EXISTS "agent_applications"/);
  for (const s of stmts.slice(1)) assert.match(s, /^CREATE (UNIQUE )?INDEX IF NOT EXISTS "agent_applications_[a-z_]+" ON "agent_applications"/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "agent_applications_company_id_pending_warehouse_id_key" ON "agent_applications"\("company_id", "pending_warehouse_id"\)/);
  const schema = read("apps/api/prisma/schema.prisma");
  const model = schema.slice(schema.indexOf("model AgentApplication {"), schema.indexOf('@@map("agent_applications")'));
  const columns = [...model.matchAll(/@map\("([a-z_]+)"\)/g)].map((m) => m[1]);
  const plain = [...model.matchAll(/^\s{2}(remark|status|id)\s/gm)].map((m) => m[1]);
  const all = [...plain, ...columns].sort();
  assert.equal(all.length, 19, all.join(","));
  const drift = read("scripts/check-schema-drift.sql");
  const listed = [...drift.matchAll(/\('agent_applications','([a-z_]+)'\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(listed, all, "结构体检清单跟设计图对不上");
  assert.match(drift, /共 64 张表 \/ 809 个字段/);
  for (const col of all) assert.ok(sql.includes(`"${col}"`), `迁移里少了 ${col}`);
});

console.log(`\n通过 ${passes}，失败 ${failures}`);
if (failures > 0) process.exit(1);
