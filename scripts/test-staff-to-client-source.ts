/**
 * 员工号改成客户号（2026-11-14 老板「a」）—— 不连库那一半。连库的在 test-staff-to-client-db.ts；页面真跑在 test-admin-overview.ts（convert 那几条）。
 *
 *   T1 「记账号的列」清单跟 schema.prisma 对得上：从 schema 推出所有记账号的列（关联到 User 的 + 名字像 xxxBy / operatorId / clientId 的），
 *      清单 + 故意不算的 = 推出来的，一条不多一条不少；以后新加记账号的列不加进清单就红
 *   T2 后端：只给超管；锁住这一行（FOR UPDATE）在事务里核「还是员工号」「没留下东西」再改；只改 role 和员工备注；推送落「账号」那一类
 *   T3 前端：只在「员工管理」每一行有「改成客户号」；先确认；走账号写入边界；改成了从员工名单拿掉、员工 / 客户两份名单都刷新；没改成画在那一行；
 *      请求路径跟后端一字不差；只有超管页用
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; console.log(`❌ ${name}\n   ${(e instanceof Error ? e.stack ?? e.message : String(e)).split("\n").slice(0, 6).join("\n   ")}`); }
}
function slice(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  assert.ok(i >= 0, `找不到：${start}`);
  const j = src.indexOf(end, i + start.length);
  assert.ok(j > i, `找不到结尾：${end}`);
  return src.slice(i, j);
}

async function main(): Promise<void> {
  const refs = await import("../apps/api/src/modules/admin/user-references");

  await check("T1 「记账号的列」三份清单跟 schema.prisma 对得上：新加记账号的列 / 大段文字列不归类就红；故意不算的每条有理由、名单钉死", () => {
    const schema = read("apps/api/prisma/schema.prisma");
    const derived = new Set<string>();
    for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
      const [, model, body] = m;
      if (model === "User") continue;
      const table = body.match(/@@map\("([^"]+)"\)/)?.[1] ?? model;
      const colOf = (field: string) => {
        const line = body.split("\n").find((l) => new RegExp(`^\\s+${field}\\s`).test(l)) ?? "";
        return line.match(/@map\("([^"]+)"\)/)?.[1] ?? field;
      };
      for (const line of body.split("\n")) {
        // 关联到 User 的：fields: [xxx] 那一列
        const rel = line.match(/^\s+\w+\s+User\??\s+@relation\([^)]*fields:\s*\[(\w+)\]/);
        if (rel) derived.add(`${table}.${colOf(rel[1])}`);
        // 名字像记账号的字符串列（没建关联的也算：operatorId、createdBy 这些大多没建）
        const str = line.match(/^\s+(\w+)\s+String\??(\s|$)/);
        if (str && /(operator|actor|user|staff|client|customer|reviewer|sender|uploader|creator|login|signer|owner|assignee|approver|handler|requester|evaluator|account|member|employee|driver|courier|admin)|By$|ById$/i.test(str[1])
          && !/(Name|Phone|Note|Text|Type|Status|Role|Label|Url|Mark)$/i.test(str[1])) derived.add(`${table}.${colOf(str[1])}`);
        // 大段文字 / JSON 列：里面可能塞着账号（审计记录就塞着被删的轨迹），每一列都得归类（dsh / Codex 第 1 轮）
        const big = line.match(/^\s+(\w+)\s+(Json|String)(\[\])?\??(?:\s+(.*))?$/);
        if (big && (big[2] === "Json" || /@db\.Text/.test(big[4] ?? ""))) derived.add(`${table}.${colOf(big[1])}`);
      }
    }
    const listed = [...refs.USER_REFERENCE_COLUMNS, ...refs.USER_REFERENCE_TEXT_COLUMNS, ...refs.USER_REFERENCE_EXCLUDED].map(([t, c]) => `${t}.${c}`);
    assert.equal(new Set(listed).size, listed.length, "三份清单里有重复的");
    const listedSet = new Set(listed);
    assert.deepEqual([...derived].filter((k) => !listedSet.has(k)).sort(), [], "schema 里记账号的列 / 大段文字列没归类（要么查、要么写进 USER_REFERENCE_EXCLUDED 并写明理由）");
    assert.deepEqual(listed.filter((k) => !derived.has(k)).sort(), [], "清单里有 schema 推不出来的列（拼错了或表 / 列已经没了）");
    for (const [t, c, why] of refs.USER_REFERENCE_EXCLUDED) assert.ok(why.trim().length >= 2, `${t}.${c} 没写不算的理由`);
    assert.deepEqual(refs.USER_REFERENCE_TEXT_COLUMNS.map(([t, c]) => `${t}.${c}`), ["audit_logs.before_json", "audit_logs.after_json"], "审计记录里存着被删的轨迹，要查");
    // 「故意不算」的名单钉死：把真记账号的列（比如 orders.client_id）挪进来混过去，这里会红；真要加，改这里并在清单里写理由
    // 钉死的名单：新加大段文字列归进「故意不算」时，这里也加一行（故意的：把真记账号的列挪进去混过去会红）
    assert.deepEqual(refs.USER_REFERENCE_EXCLUDED.map(([t, c]) => `${t}.${c}`).sort(), [
      "admin_lastmile_orders.sign_product_image_base64", "agent_applications.login_id", "agent_rebate_lines.product_names",
      "ai_audit_logs.answer_summary", "ai_audit_logs.question", "ai_knowledge_gaps.answer_summary",
      "ai_knowledge_gaps.question", "ai_knowledge_items.content", "arrival_notice_snapshots.data",
      "audit_logs.user_agent", "chaipai_callback_events.payload", "chaipai_shipment_states.released_routes",
      "client_documents.content_base64", "consolidation_prealert_products.product_image_base64", "consolidation_prealerts.received_proof_base64",
      "consolidation_tasks.destination_th", "consolidation_tasks.payment_proof_base64", "consolidation_tasks.payment_reject_reason",
      "credit_histories.evaluator", "credit_histories.metrics", "credit_histories.reason",
      "cs_messages.content", "cs_push_subscriptions.user_id", "fcl_inquiries.address",
      "fcl_inquiries.cert_file_base64", "fcl_inquiries.product_images", "fcl_inquiries.product_name",
      "fcl_inquiries.quote_note", "finance_link_authorizations.warehouse_ref", "finance_link_requests.warehouse_ref",
      "order_product_images.content_base64", "orders.payment_proof_base64", "orders.payment_proofs",
      "staff_inbound_photos.content_base64", "wallet_recharges.proof_image", "whr_consolidation_plan_customers.delivery_address",
      "whr_consolidation_plans.destination_th", "whr_consolidation_prealert_items.product_image_base64", "whr_consolidation_prealerts.cancel_reason",
      "whr_consolidation_prealerts.customer_id", "whr_consolidation_prealerts.payment_proofs", "whr_consolidation_prealerts.payment_reject_reason",
      "whr_consolidation_prealerts.thailand_receipt_proofs", "whr_consolidation_prealerts.warehouse_receipt_proofs",
    ]);
    assert.ok(refs.USER_REFERENCE_COLUMNS.length >= 50, `清单才 ${refs.USER_REFERENCE_COLUMNS.length} 条，像是被删了`);
    for (const k of ["orders.client_id", "status_logs.operator_id", "cs_messages.sender_id", "audit_logs.actor_id"]) assert.ok(refs.USER_REFERENCE_COLUMNS.some(([t, c]) => `${t}.${c}` === k), `${k} 必须查`);
  });

  const api = code("apps/api/src/modules/admin/routes.ts");
  await check("T2 后端：只给超管；锁住这一行 → 核本公司 / 员工号 / 有密码 → 改 → 拿着锁再查没留下东西，有就整个撤销；只改 role 和员工备注；锁等不到 409；推送落「账号」", async () => {
    const ep = slice(api, `app.post("/admin/users/staff-to-client"`, "\n  });");
    assert.match(ep, /requireRole\(req, res, \["admin"\]\)/);
    const tx = slice(ep, "prisma.$transaction(async (tx) => {", "\n      }, { timeout");
    const at = (needle: string) => { const n = tx.indexOf(needle); assert.ok(n >= 0, `事务里没有：${needle}`); return n; };
    assert.match(tx, /coalesce\(password_hash, ''\) <> '' AS has_password/, "空串密码也算没设");
    const order = [at("SET LOCAL lock_timeout"), at("FOR UPDATE"), at("u.company_id !== auth.companyId"), at(`u.role !== "staff"`), at("!u.has_password"),
      at("tx.user.update("), at("findUserReferences(tx, id)"), at("throw new UsedAfterAll(used)")];
    assert.deepEqual([...order].sort((a, b) => a - b), order, "顺序要是：设等锁上限 → 锁住这一行 → 核公司 → 核员工号 → 核密码 → 改 → 再查 → 有就抛出去撤销");
    assert.match(tx, /tx\.user\.update\(\{ where: \{ id \}, data: \{ role: "client", remark: null \} \}\)/, "只改角色、清员工备注，别的不动");
    assert.match(ep, /e instanceof UsedAfterAll\) \{[\s\S]*?fail\(res, 409/);
    assert.match(ep, /pg\.code === "P2010" && \/55P03\|lock timeout\/i[\s\S]*?fail\(res, 409, "VALIDATION_ERROR", "这个号正被别人改着，过几秒再点"\)/, "只有等行锁超时才说「别人正改着」");
    assert.match(ep, /pg\.code === "P2028" \|\| pg\.code === "P2024"\)\) \{\s*fail\(res, 409, "VALIDATION_ERROR", "系统忙，这次没改成，过几秒再点"\)/, "事务 / 连接池超时说系统忙");
    assert.match(ep, /\}, \{ timeout: 15000, maxWait: 5000 \}\);/, "事务时限要宽过等锁 3 秒 + 再查");
    assert.match(ep, /result\.kind === "noPassword"\) \{\s*fail\(res, 409/);
    const { topicForWrite } = await import("../apps/api/src/modules/realtime/topics");
    assert.equal(topicForWrite("/admin/users/staff-to-client"), "accounts", "改完别的超管开着的员工 / 客户管理要跟着刷新");
  });

  const page = code("apps/web/src/app/admin/page.tsx");
  const svc = code("apps/web/src/services/business-api.ts");
  await check("T3 前端：员工那一行「改成客户号」；先确认；走写入边界；改成了拿掉这一行、两份名单都刷新；没改成画在那一行；路径一字不差；只有超管页用", () => {
    const fn = slice(svc, "export async function convertStaffToClient(", "\n}");
    const sent = fn.match(/\$\{apiBaseUrl\(\)\}(\/[^`]+)`/)?.[1];
    assert.equal(sent, "/admin/users/staff-to-client");
    assert.ok(api.includes(`app.post("${sent}", async`), "后端没有这条");
    assert.match(fn, /method: "POST"/);
    assert.match(fn, /signal,/);
    assert.match(fn, /JSON\.stringify\(\{ id \}\)/);

    const staffRows = slice(page, "{staffList.map((u) => (", "{editingRemarkFor === u.id ? (");
    assert.match(staffRows, /onClick=\{\(\) => void confirmConvertStaffToClient\(u\)\}\s*disabled=\{loading\}[^>]*>\s*改成客户号\s*</);
    assert.equal((page.match(/confirmConvertStaffToClient\(u\)/g) ?? []).length, 1, "只在员工那一行有");
    const clientSection = slice(page, `<section id="clients"`, "</section>");
    assert.ok(!clientSection.includes("改成客户号"), "客户管理里不该有");

    const h = slice(page, "const confirmConvertStaffToClient = async (u: AdminUserItem) => {", "\n  };");
    assert.match(h, /if \(loading\) return;/);
    assert.match(h, /if \(!window\.confirm\(tip\)\) return;/, "要先确认");
    assert.match(h, /tip = `把员工号「\$\{u\.id\}」改成客户号吗？/);
    assert.ok(!/u\.name/.test(h), "确认框只写账号不带名字（改完是客户号，显示客户只显示唛头）");
    assert.ok(h.indexOf("window.confirm") < h.indexOf("setLoading(true)"), "确认在前");
    assert.match(h, /runAccountWrite\(\(signal\) => convertStaffToClient\(u\.id, signal\)\)/, "走账号写入边界（旧名单晚到不许把它又放回员工名单）");
    assert.match(h, /setConvertError\(\{ id: u\.id, text: `没改成：\$\{text\}` \}\);\s*return;/);
    assert.match(h, /AccountWriteTimeoutError"\) \{\s*setConvertError\(\{ id: u\.id, text: error\.message \}\);\s*return;/);
    assert.ok(!/setMessage\(`/.test(h), "没改成的原因画在那一行，不写页面最底下");
    assert.match(h, /setStaffList\(\(rows\) => rows\.filter\(\(row\) => row\.id !== result\.id\)\)/);
    assert.match(h, /refreshAccountViews\(\(\) => Promise\.all\(\[loadStaff\(\), loadClients\(\)\]\), done\)/, "员工 / 客户两份名单都刷新");
    assert.match(h, /result\.status === "active"[\s\S]*?还在封禁中/, "封着的提醒去客户管理解封");
    assert.match(page, /\{convertError\?\.id === u\.id \? \(\s*<div role="alert"[^>]*>\{convertError\.text\}<\/div>/);

    for (const rel of ["apps/web/src/app/staff/page.tsx", "apps/web/src/app/client/page.tsx", "apps/web/src/app/agent/page.tsx"]) {
      if (fs.existsSync(path.join(ROOT, rel))) assert.ok(!/convertStaffToClient|staff-to-client/.test(code(rel)), `${rel} 用了改号`);
    }
  });

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
