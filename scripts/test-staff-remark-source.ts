/**
 * 员工账号备注（2026-10-20 老板：「给员工账号备注是哪里的员工，比如义乌仓管，广州仓管，泰国员工」→「管理员给员工账号进行备注」）—— 不连库那一半。
 * 连库的在 test-staff-remark-db.ts，迁移在 test-migration-user-remark-db.ts。计划：.audit/2026-10-20/staff-remark/plan.md。
 *
 *   R1 字段：schema.prisma 的 User 有 remark（可空、列名 remark）；迁移只加一列（IF NOT EXISTS，不删、不回填）；体检清单有 users.remark
 *   R2 后端：改备注那条只给超管；查到不是员工号 400；写的时候 where 再带 role=staff（查和写之间改了角色 → 409）；最多 50 字；
 *      建员工带备注、建客户不认；员工名单（两种）都给 remark；推送落「账号」那一类
 *   R3 超管页「员工管理」：建员工弹窗多一格「备注」（选填、最多 50、提示义乌仓管那几个例子），发请求带上去空格的备注；
 *      每个员工显示「备注」（没写显示「未写」）+「改备注」，在那一行下面展开；改备注跟「设置密码」一次只开一个
 *   R4 存备注：走账号写入那道边界（runAccountWrite，存之前发出的旧名单不许把备注盖回去）、用后端回的值改那一行、
 *      没存上的原因画在那一行（不写到页面最底下那行）、存完刷新名单
 *   R5 只有超管页用：员工 / 客户 / 代理页都不读、不显示员工备注
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

let passed = 0, failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; console.log(`❌ ${name}\n   ${(e instanceof Error ? e.stack ?? e.message : String(e)).split("\n").slice(0, 6).join("\n   ")}`); }
}
/** 取 `start` 第一次出现起、到下一个 `end` 为止的那一段（找不到就失败） */
function slice(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  assert.ok(i >= 0, `找不到：${start}`);
  const j = src.indexOf(end, i + start.length);
  assert.ok(j > i, `找不到结尾：${end}`);
  return src.slice(i, j);
}

check("R1 字段：User.remark 可空、列名 remark；迁移只加一列（IF NOT EXISTS、不删不回填）；体检清单有 users.remark", () => {
  const schema = read("apps/api/prisma/schema.prisma");
  const user = slice(schema, "model User {", "\n}");
  assert.match(user, /\n\s+remark\s+String\?\s+@map\("remark"\)/);
  const sql = read("apps/api/prisma/migrations/20261020_user_remark/migration.sql")
    .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
  assert.equal(sql, `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "remark" TEXT;`, "迁移里除了加这一列不许有别的");
  const drift = read("scripts/check-schema-drift.sql");
  assert.match(drift, /\('users','remark'\)/);
  assert.match(drift, /共 61 张表 \/ 769 个字段/);
});

const adminApi = code("apps/api/src/modules/admin/routes.ts");

check("R2a 后端改备注：只给超管、只认本公司员工号、写的时候再核一次、最多 50 字", () => {
  const ep = slice(adminApi, `app.post("/admin/users/staff-remark"`, "\n  });");
  assert.match(ep, /requireRole\(req, res, \["admin"\]\)/, "只给超管");
  assert.match(ep, /findFirst\(\{ where: \{ id, companyId: auth\.companyId \}/, "按本公司查");
  assert.match(ep, /user\.role !== "staff"[^\n]*fail\(res, 400/, "不是员工号 400");
  assert.match(ep, /updateMany\(\{ where: \{ id: user\.id, companyId: auth\.companyId, role: "staff" \}/, "写的时候 where 再带公司和 role=staff");
  assert.match(ep, /written\.count === 0[^\n]*fail\(res, 409/, "没写上 409");
  assert.match(adminApi, /export const STAFF_REMARK_MAX = 50;/);
  const helper = slice(adminApi, "function readStaffRemark(", "\n}");
  assert.match(helper, /\.trim\(\)/);
  assert.match(helper, /v\.length > STAFF_REMARK_MAX/);
  assert.match(helper, /value: v \|\| null/, "空白 = 清掉（存 null）");
});

check("R2b 建员工带备注、建客户不认；两种员工名单都给 remark；推送落「账号」", () => {
  const create = slice(adminApi, `app.post("/admin/users", async`, "\n  });");
  assert.match(create, /const remark = targetRole === "staff" \? readStaffRemark\(body\.remark\) : \{ value: null \};/);
  assert.match(create, /remark: remark\.value,/);
  const list = slice(adminApi, `app.get("/admin/users", async`, "\n  });");
  assert.equal((list.match(/remark: true,/g) ?? []).length, 2, "不分角色、按角色两种名单都要 select remark");
  assert.match(list, /remark: r\.remark \?\? null,/);
  const topics = code("apps/api/src/modules/realtime/topics.ts");
  assert.ok(!/staff-remark/.test(topics), "改备注不许放进「不推送」名单：别的超管开着的员工管理要跟着刷新");
});

const page = code("apps/web/src/app/admin/page.tsx");
const api = code("apps/web/src/services/business-api.ts");

check("R3a 前端接口：AdminUserItem 有 remark；建员工可带 remark；改备注发 /admin/users/staff-remark、带 signal", () => {
  assert.match(slice(api, "export interface AdminUserItem", "\n}"), /remark\?: string \| null;/);
  assert.match(slice(api, "export async function createAdminStaff(", "Promise<"), /remark\?: string;/);
  const fn = slice(api, "export async function setAdminStaffRemark(", "\n}");
  // 前端发的路径要跟后端挂的那条一字不差（只比前缀的话多一个字母也过）
  const sent = fn.match(/\$\{apiBaseUrl\(\)\}(\/[^`]+)`/)?.[1];
  assert.equal(sent, "/admin/users/staff-remark");
  assert.ok(adminApi.includes(`app.post("${sent}", async`), `后端没有 ${sent} 这条`);
  assert.match(fn, /method: "POST"/);
  assert.match(fn, /signal,/);
  assert.match(fn, /JSON\.stringify\(\{ id, remark \}\)/);
});

check("R3b 建员工弹窗多一格「备注」（选填、最多 50、提示例子），发请求带去空格的备注；开弹窗 / 建完都清空", () => {
  const modal = slice(page, "创建员工账号</h3>", "{showClientModal && (");
  assert.match(modal, />备注（选填）</);
  assert.match(modal, /value=\{staffForm\.remark\} onChange=\{\(e\) => setStaffForm\(\(f\) => \(\{ \.\.\.f, remark: e\.target\.value \}\)\)\} maxLength=\{50\}/);
  assert.match(modal, /义乌仓管、广州仓管、泰国员工/);
  assert.match(slice(page, "const submitAddStaff", "\n  };"), /remark: staffForm\.remark\.trim\(\) \|\| undefined,/);
  assert.equal((page.match(/setStaffForm\(\{ id: "", name: "", phone: "", password: "", remark: "" \}\)/g) ?? []).length, 2, "开弹窗、建完两处都清空备注");
  assert.ok(!/setStaffForm\(\{ id: "", name: "", phone: "", password: "" \}\)/.test(page), "还有没带备注的清空");
});

check("R3c 员工那一行：显示「备注」（没写显示「未写」）+「改备注」；改备注 / 设置密码一次只开一个；展开框最多 50、可取消", () => {
  const row = slice(page, "{staffList.map((u) => (", "{settingPasswordFor === u.id ? (");
  assert.match(row, /<strong>备注<\/strong> \{u\.remark \? u\.remark : <span[^>]*>未写<\/span>\}/);
  assert.match(row, /onClick=\{\(\) => \{ setSettingPasswordFor\(null\); setRemarkError\(""\); setRemarkDraft\(u\.remark \?\? ""\); setEditingRemarkFor\(editingRemarkFor === u\.id \? null : u\.id\); \}\}/,
    "点「改备注」：收起设置密码、清掉上次的错、框里填现在的备注");
  assert.match(row, /\{editingRemarkFor === u\.id \? "取消改备注" : "改备注"\}/);
  assert.match(row, /onClick=\{\(\) => \{ setEditingRemarkFor\(null\); setShowSettingPassword\(false\);/, "点「设置密码」收起改备注");
  const editor = slice(row, "{editingRemarkFor === u.id ? (", ") : null}");
  assert.match(editor, /value=\{remarkDraft\}/);
  assert.match(editor, /maxLength=\{50\}/);
  assert.match(editor, /onClick=\{\(\) => void submitStaffRemark\(u\.id\)\}/);
  assert.match(editor, /disabled=\{loading\}/);
  assert.match(editor, />\s*保存备注\s*</);
  assert.match(editor, /\{remarkError \? \(\s*<div role="alert"[^>]*>\{remarkError\}<\/div>/, "没存上的原因画在这一行");
});

check("R4 存备注：先拦超长；走 runAccountWrite；超时 / 失败写在那一行；用后端回的值改那一行；存完刷新名单", () => {
  const fn = slice(page, "const submitStaffRemark = async (userId: string) => {", "\n  };");
  assert.match(fn, /if \(loading\) return;/);
  assert.match(fn, /const value = remarkDraft\.trim\(\);/);
  assert.match(fn, /value\.length > 50\) \{\s*setRemarkError\(/);
  assert.match(fn, /runAccountWrite\(\(signal\) => setAdminStaffRemark\(userId, value, signal\)\)/, "要走账号写入边界，旧名单不许盖回去");
  assert.match(fn, /AccountWriteTimeoutError"\) \{\s*setRemarkError\(error\.message\);\s*return;/);
  assert.match(fn, /setRemarkError\(`备注没存上：\$\{text\}`\);\s*return;/);
  assert.ok(!/setMessage\(/.test(fn), "错误不许写到页面最底下那行（看不见）");
  assert.match(fn, /setStaffList\(\(rows\) => rows\.map\(\(row\) => \(row\.id === result\.id \? \{ \.\.\.row, remark: result\.remark \} : row\)\)\)/, "用后端回的值");
  assert.match(fn, /await refreshAccountViews\(loadStaff, done\);/);
  assert.match(fn, /finally \{\s*setLoading\(false\);/);
  assert.ok(fn.indexOf("setStaffList(") < fn.indexOf("refreshAccountViews("), "先改那一行再刷新");
});

check("R5 员工备注只在超管页：员工 / 客户 / 代理那几页不调改备注、不显示员工备注", () => {
  for (const rel of ["apps/web/src/app/staff/page.tsx", "apps/web/src/app/client/page.tsx", "apps/web/src/app/agent/page.tsx"]) {
    if (!fs.existsSync(path.join(ROOT, rel))) continue;
    const src = code(rel);
    assert.ok(!/setAdminStaffRemark|staff-remark/.test(src), `${rel} 调了改备注`);
  }
  const callers = (dir: string): string[] => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = path.join(dir, d.name);
    if (d.isDirectory()) return callers(rel);
    return /\.(ts|tsx)$/.test(d.name) && /setAdminStaffRemark/.test(read(rel)) ? [rel] : [];
  });
  assert.deepEqual(callers("apps/web/src").sort(), ["apps/web/src/app/admin/page.tsx", "apps/web/src/services/business-api.ts"]);
});

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
