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
import ts from "typescript";

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
  assert.match(ep, /where: \{ id: user\.id, companyId: auth\.companyId, role: "staff", \.\.\.\(expected \? \{ remark: expected\.value \} : \{\}\) \}/,
    "写的时候 where 再带公司、role=staff、点开时那份备注");
  assert.match(ep, /const expected = body\.expectedRemark === undefined \? undefined : readStaffRemark\(body\.expectedRemark\);/);
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
  assert.match(fn, /JSON\.stringify\(\{ id, remark, expectedRemark \}\)/);
});

check("R3b 建员工弹窗多一格「备注」（选填、最多 50、提示例子），发请求带去空格的备注；开弹窗 / 建完都清空", () => {
  const modal = slice(page, "创建员工账号</h3>", "{showClientModal && (");
  assert.match(modal, />备注（选填）</);
  const remarkInput = modal.match(/<input value=\{staffForm\.remark\}[\s\S]*?\/>/)?.[0] ?? "";
  assert.match(remarkInput, /onChange=\{\(e\) => setStaffForm\(\(f\) => \(\{ \.\.\.f, remark: e\.target\.value \}\)\)\}/);
  assert.match(remarkInput, /义乌仓管、广州仓管、泰国员工（最多 50 个字）/);
  assert.ok(!/maxLength/.test(remarkInput), "不用 maxLength：粘贴超长会被悄悄截掉，要在提交时明确拦（审查第 1 轮）");
  assert.match(slice(page, "const submitAddStaff", "\n  };"), /if \(staffForm\.remark\.trim\(\)\.length > 50\) \{\s*setMessage\("备注太长了（最多 50 个字）。"\);\s*return;/);
  assert.match(slice(page, "const submitAddStaff", "\n  };"), /remark: staffForm\.remark\.trim\(\) \|\| undefined,/);
  assert.equal((page.match(/setStaffForm\(\{ id: "", name: "", phone: "", password: "", remark: "" \}\)/g) ?? []).length, 2, "开弹窗、建完两处都清空备注");
  assert.ok(!/setStaffForm\(\{ id: "", name: "", phone: "", password: "" \}\)/.test(page), "还有没带备注的清空");
});

check("R3c 员工那一行：显示「备注」（没写显示「未写」）+「改备注」；改备注 / 设置密码一次只开一个；展开框最多 50、可取消", () => {
  const row = slice(page, "{staffList.map((u) => (", "{settingPasswordFor === u.id ? (");
  assert.match(row, /<strong>备注<\/strong> \{u\.remark \? u\.remark : <span[^>]*>未写<\/span>\}/);
  assert.match(row, /onClick=\{\(\) => \{ setSettingPasswordFor\(null\); setRemarkError\(""\); setRemarkDraft\(u\.remark \?\? ""\); setRemarkBase\(u\.remark \?\? null\); setEditingRemarkFor\(editingRemarkFor === u\.id \? null : u\.id\); \}\}/,
    "点「改备注」：收起设置密码、清掉上次的错、框里填现在的备注、记下点开时那份");
  assert.match(row, /\{editingRemarkFor === u\.id \? "取消改备注" : "改备注"\}/);
  assert.match(row, /onClick=\{\(\) => \{ setEditingRemarkFor\(null\); setShowSettingPassword\(false\);/, "点「设置密码」收起改备注");
  const editor = slice(row, "{editingRemarkFor === u.id ? (", ") : null}");
  const input = editor.match(/<input[\s\S]*?\/>/)?.[0] ?? "";
  assert.match(input, /value=\{remarkDraft\}/);
  assert.match(input, /onChange=\{\(e\) => setRemarkDraft\(e\.target\.value\)\}/, "能打字（dsh 第 1 轮：删掉 onChange 框就成只读了）");
  assert.match(editor, /onClick=\{\(\) => \{ setEditingRemarkFor\(null\); setRemarkDraft\(""\); setRemarkError\(""\); \}\}\s*disabled=\{loading\}[^>]*>\s*取消\s*</, "「取消」收起、清掉草稿和错");
  assert.match(input, /disabled=\{loading\}/, "存的时候锁住（不然存完把后来打的字清掉）");
  assert.ok(!/maxLength/.test(input), "不用 maxLength（粘贴超长会被悄悄截掉）");
  assert.equal((editor.match(/disabled=\{loading\}/g) ?? []).length, 3, "输入框、保存、取消三样存的时候都锁");
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
  assert.match(fn, /runAccountWrite\(\(signal\) => setAdminStaffRemark\(userId, value, remarkBase, signal\)\)/, "要走账号写入边界、带点开时那份");
  assert.match(fn, /AccountWriteTimeoutError"\) \{\s*setRemarkError\(error\.message\);\s*return;/);
  assert.match(fn, /setRemarkError\(`备注没存上：\$\{text\}`\);\s*void loadStaff\(\)\.catch\(\(\) => \{\}\);\s*return;/, "没存上就刷新名单（不改点开时那份）");
  assert.ok(!/setRemarkBase\(/.test(fn), "存的时候不许自动改「点开时那份」（不然再点保存就盖掉别人的）");
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

check("R6 员工备注不会顺着别的接口漏出去：后端读账号一律写明要哪几项（dsh 第 1、2 轮：以后有人加一个不写 select 的查询就漏）", () => {
  // 账号表（User）在别的表里的关联名（schema.prisma 里 `xxx User @relation` / `xxx User[] @relation` / `xxx User? @relation`）
  const schema = read("apps/api/prisma/schema.prisma");
  const relNames = new Set([...schema.matchAll(/^\s+(\w+)\s+User(?:\[\])?\??\s+@relation/gm)].map((m) => m[1]));
  for (const must of ["client", "actor", "users"]) assert.ok(relNames.has(must), `关联名没读出来 ${must}：${[...relNames].join(",")}`);
  const files = (dir: string): string[] => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = path.join(dir, d.name);
    return d.isDirectory() ? files(rel) : /\.ts$/.test(d.name) ? [rel] : [];
  });
  /** 属性名（不管写成 remark 还是 "remark"） */
  const keyOf = (p: ts.ObjectLiteralElementLike): string | undefined =>
    p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
  const objProp = (o: ts.ObjectLiteralExpression, name: string) =>
    o.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && keyOf(p) === name);
  const bad: string[] = [];
  const remarkAt: Array<{ rel: string; pos: number; line: number }> = [];
  const USER_READS = /^(find(Many|First|Unique)(OrThrow)?)$/;
  const USER_WRITES = /^(create|update|upsert|delete)$/; // 不带 select 会把整行带回来；createMany / updateMany / deleteMany 只回条数
  for (const rel of files("apps/api/src")) {
    const sf = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true);
    const at = (n: ts.Node) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
    /** select 写成同文件的常量也认（追一层）；认不出来返回 undefined */
    const resolve = (e: ts.Expression): ts.ObjectLiteralExpression | undefined => {
      if (ts.isObjectLiteralExpression(e)) return e;
      if (ts.isIdentifier(e)) {
        let found: ts.ObjectLiteralExpression | undefined;
        const find = (n: ts.Node): void => {
          if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === e.text && n.initializer) {
            const init = ts.isAsExpression(n.initializer) || ts.isSatisfiesExpression(n.initializer) ? n.initializer.expression : n.initializer;
            if (ts.isObjectLiteralExpression(init)) found = init;
          }
          if (!found) ts.forEachChild(n, find);
        };
        find(sf);
        return found;
      }
      return undefined;
    };
    /** 账号的 select：记下要没要 remark；里面再带出的关联账号也照样查 */
    const userSelect = (sel: ts.ObjectLiteralExpression) => {
      if (objProp(sel, "remark")) remarkAt.push({ rel, pos: sel.getStart(), line: sf.getLineAndCharacterOfPosition(sel.getStart()).line + 1 });
      if (sel.properties.some((p) => ts.isSpreadAssignment(p))) bad.push(`${at(sel)} 账号 select 里有展开（...），看不出要了哪几项`);
    };
    const isUserModel = (e: ts.Expression) => ts.isPropertyAccessExpression(e) && e.name.text === "user";
    const visit = (n: ts.Node): void => {
      // ① prisma.user / tx.user 不许赋给变量（不然下面按 .user.findMany 认不出来）
      if (ts.isVariableDeclaration(n) && n.initializer && isUserModel(n.initializer)
        && /^(prisma|tx|db)$/.test((n.initializer as ts.PropertyAccessExpression).expression.getText())) bad.push(`${at(n)} 把账号表赋给了变量`);
      // ② xxx.user.findMany / findFirst / findUnique：必须写 select；create / update / upsert / delete：结果要用就必须写 select
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && isUserModel(n.expression.expression)) {
        const method = n.expression.name.text;
        const arg = n.arguments[0];
        const selProp = arg && ts.isObjectLiteralExpression(arg) ? objProp(arg, "select") : undefined;
        const sel = selProp ? resolve(selProp.initializer) : undefined;
        if (selProp && !sel) bad.push(`${at(n)} 账号 select 认不出来（不是对象，也不是同文件常量）`);
        if (sel) userSelect(sel);
        if (USER_READS.test(method) && !selProp) bad.push(`${at(n)} 查账号没写 select`);
        if (USER_WRITES.test(method) && !selProp) {
          const up = ts.isAwaitExpression(n.parent) ? n.parent.parent : n.parent;
          if (!ts.isExpressionStatement(up)) bad.push(`${at(n)} 写账号没写 select，结果却拿去用了（会带回整行）`);
        }
      }
      // ③ include / select 里带出关联账号：不许 `client: true`，展开的也要有 select
      if (ts.isPropertyAssignment(n) && (keyOf(n) === "include" || keyOf(n) === "select") && ts.isObjectLiteralExpression(n.initializer)) {
        for (const p of n.initializer.properties) {
          if (ts.isSpreadAssignment(p) && keyOf(n) === "include") { bad.push(`${at(p)} include 里有展开（...），看不出带出了什么`); continue; }
          const key = keyOf(p);
          if (!ts.isPropertyAssignment(p) || !key || !relNames.has(key)) continue;
          const v = p.initializer;
          if (v.kind === ts.SyntaxKind.TrueKeyword) { bad.push(`${at(p)} ${keyOf(n)} 带出整行账号（${key}: true）`); continue; }
          if (!ts.isObjectLiteralExpression(v)) continue; // false / 变量：false 不带；变量的情况少见，交给审查
          const inner = objProp(v, "select");
          const innerSel = inner ? resolve(inner.initializer) : undefined;
          if (!inner) bad.push(`${at(p)} ${keyOf(n)} 带出整行账号（${key} 没写 select）`);
          else if (!innerSel) bad.push(`${at(p)} 关联账号的 select 认不出来`);
          else userSelect(innerSel);
        }
      }
      // ④ 手写 SQL：读 users 的不许 SELECT * / 别名.*，也不许点名 remark
      const sqlText = (t: ts.Node | undefined): string | undefined =>
        !t ? undefined : ts.isNoSubstitutionTemplateLiteral(t) || ts.isStringLiteral(t) ? t.text
          : ts.isTemplateExpression(t) ? [t.head.text, ...t.templateSpans.map((s) => s.literal.text)].join(" ? ") : undefined;
      let sql: string | undefined;
      if (ts.isTaggedTemplateExpression(n) && /\$(queryRaw|executeRaw)$/.test(n.tag.getText())) sql = sqlText(n.template);
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && /^\$(queryRaw|executeRaw)(Unsafe)?$/.test(n.expression.name.text)) sql = sqlText(n.arguments[0]);
      if (sql && /\b(public\.)?"?users"?\b/i.test(sql) && (/\bremark\b/i.test(sql) || /\bselect\s+(\w+\.)?\*/i.test(sql) || /\b\w+\.\*/.test(sql))) bad.push(`${at(n)} 手写 SQL 整行读账号或点名 remark`);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  assert.deepEqual(bad, []);
  // ⑤ 账号 select 里要了 remark 的，只能在「员工名单」GET /admin/users 这一个接口里（只给超管）
  const adminRel = path.join("apps/api/src/modules/admin/routes.ts");
  const adminSf = ts.createSourceFile(adminRel, read(adminRel), ts.ScriptTarget.Latest, true);
  let listNode: ts.Node | undefined;
  const findList = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && n.expression.getText(adminSf) === "app.get" && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === "/admin/users") listNode = n;
    if (!listNode) ts.forEachChild(n, findList);
  };
  findList(adminSf);
  assert.ok(listNode, "找不到 GET /admin/users");
  assert.ok(remarkAt.length > 0, "员工名单接口里没有要 remark");
  for (const r of remarkAt) {
    assert.ok(r.rel === adminRel && r.pos > listNode!.getStart(adminSf) && r.pos < listNode!.getEnd(), `${r.rel}:${r.line} 的账号 select 要了 remark，但不在员工名单接口里`);
  }
});

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
