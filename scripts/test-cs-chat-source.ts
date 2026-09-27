/**
 * 客服对话 + 整柜询价报价（2026-09-28）—— 不连库的回归（纯函数真跑 + 读源码）。
 * 连库那部分（谁看到谁的名字、未读、代理两头挡、报价 / 接受 / 转整柜）在 scripts/test-cs-chat-db.ts。
 * 每条都是「把这处改回去 / 删掉就红」的钉子；改法变了跟着改，别为了绿把断言放宽。
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`✅ ${name}`); }
  catch (e: any) { failed++; console.log(`❌ ${name}\n   ${e?.message ?? e}`); }
}

async function main(): Promise<void> {
  const api = await import("../apps/api/src/modules/cs-chat/routes");
  const web = await import("../apps/web/src/services/cs-chat-api");
  const { roleFunctionGroups } = await import("../apps/web/src/modules/layout/menu-config");
  const brand = await import("../apps/web/src/modules/branding/brand-core");
  const scope = await import("../apps/api/src/modules/core/agent-scope");
  const inquiry = await import("../apps/api/src/modules/fcl-inquiries/routes");

  await check("S1 谁看到谁的名字（toWireMessage 真跑）：客户看员工 =「客服」；员工看员工 =「客服」；超管看员工 =「客服·名字」；看客户 = 唛头；自己 =「我」", () => {
    const staffMsg = { id: "m1", senderId: "u_staff", senderRole: "staff", senderName: "小李", content: "hi", imagePath: null, createdAt: new Date("2026-09-28T01:00:00Z") };
    const clientMsg = { id: "m2", senderId: "XHH6700", senderRole: "client", senderName: null, content: "hi", imagePath: null, createdAt: new Date("2026-09-28T01:00:01Z") };
    assert.equal(api.toWireMessage(staffMsg, { userId: "XHH6700", role: "client" }).senderLabel, "客服");
    assert.equal(api.toWireMessage(staffMsg, { userId: "u_other", role: "staff" }).senderLabel, "客服");
    assert.equal(api.toWireMessage(staffMsg, { userId: "u_admin", role: "admin" }).senderLabel, "客服·小李");
    assert.equal(api.toWireMessage(staffMsg, { userId: "u_staff", role: "staff" }).senderLabel, "我");
    assert.equal(api.toWireMessage(clientMsg, { userId: "u_staff", role: "staff" }).senderLabel, "XHH6700");
    const wire = api.toWireMessage(staffMsg, { userId: "XHH6700", role: "client" });
    assert.deepEqual(Object.keys(wire).sort(), ["content", "createdAt", "id", "imageUrl", "mine", "senderLabel", "side"], "下发字段多了（逐字段列，别把 senderId / senderName 带出去）");
  });

  await check("S2 发什么（parseSendBody 真跑）：文字去首尾空格；空、超 2000 字、非图片、乱码 base64 都拒；图片 + 文字可以一起", () => {
    assert.deepEqual(api.parseSendBody({ content: "  你好 \r\n 在吗  " }), { content: "你好 \n 在吗", image: null });
    for (const bad of [{}, { content: "   " }, { content: "x".repeat(2001) }, { image: { mime: "image/svg+xml", base64: "AAAA" } }, { image: { mime: "image/png", base64: "中文" } }, { content: 5 }]) {
      assert.ok("error" in api.parseSendBody(bad as any), `应该拒：${JSON.stringify(bad).slice(0, 60)}`);
    }
    const both = api.parseSendBody({ content: "看图", image: { mime: "IMAGE/PNG", base64: "iVBORw0KGgo=" } });
    assert.ok(!("error" in both) && both.image?.mime === "image/png" && both.content === "看图");
    assert.equal(api.previewOf(null, true), "[图片]");
    assert.equal(api.previewOf("a".repeat(80), false), `${"a".repeat(60)}…`);
  });

  await check("S3 轮询合并（mergeChatMessages 真跑）：按 id 去重、按时间排；没新东西返回原数组（不白白重画）", () => {
    const m = (id: string, t: string) => ({ id, side: "client" as const, mine: false, senderLabel: "x", content: id, imageUrl: null, createdAt: t });
    const cur = [m("a", "2026-09-28T01:00:00.000Z"), m("b", "2026-09-28T01:00:05.000Z")];
    assert.equal(web.mergeChatMessages(cur, [m("b", "2026-09-28T01:00:05.000Z")]), cur, "全是重复的也换了新数组");
    const merged = web.mergeChatMessages(cur, [m("c", "2026-09-28T01:00:03.000Z"), m("b", "2026-09-28T01:00:05.000Z")]);
    assert.deepEqual(merged.map((x) => x.id), ["a", "c", "b"]);
  });

  await check("S4 菜单：员工 / 超管「客户消息」、客户「在线客服」都放在默认展开的组里；超管借员工端那一页", () => {
    const find = (role: "staff" | "admin" | "client", id: string) => {
      for (const g of roleFunctionGroups[role]) { const it = g.items.find((i) => i.id === id); if (it) return { g: g.groupLabel, ...it }; }
      return null;
    };
    assert.deepEqual([find("staff", "staff-func-chat")?.g, find("staff", "staff-func-chat")?.href], ["运单管理", "/staff/chat"]);
    assert.deepEqual([find("admin", "admin-func-chat")?.g, find("admin", "admin-func-chat")?.href], ["运单管理", "/staff/chat"]);
    assert.deepEqual([find("client", "client-func-chat")?.g, find("client", "client-func-chat")?.href], ["我的运单", "/client/chat"]);
    const frame = read("apps/web/src/modules/layout/WorkbenchFrame.tsx");
    assert.match(frame, /"\/staff\/chat": "客户消息"/);
    assert.match(frame, /"\/client\/chat": "在线客服"/);
  });

  await check("S5 代理的不开：菜单按品牌藏、服务端统一闸挡 /client/chat；页面进门现查品牌（agent-branding 13b 会自动盯页面写法）", () => {
    assert.ok((brand.AGENT_CLIENT_HIDDEN_MENU_IDS as readonly string[]).includes("client-func-chat"));
    assert.ok((scope.AGENT_CLIENT_BLOCKED_PREFIXES as readonly string[]).includes("/client/chat"));
    const page = read("apps/web/src/app/client/chat/page.tsx");
    assert.match(page, /useVerifiedSessionBrand\(\)/);
    assert.match(page, /router\.replace\("\/client"\)/);
    const shell = read("apps/web/src/modules/layout/RoleShell.tsx");
    assert.match(shell, /useChatUnread\(\s*session,\s*CHAT_MENU_IDS\.some\(\(id\) => brand\?\.hiddenMenuIds\.includes\(id\)\)/, "红点没按品牌关掉（代理的客户会一直去问、一直 403）");
  });

  await check("S6 聊天窗口：3 秒轮询、只在前台轮询和标已读、中文输入法选字的回车不发送、能粘贴图片、发图先压缩", () => {
    const src = read("apps/web/src/modules/cs-chat/ChatThread.tsx");
    assert.match(src, /export const CHAT_POLL_MS = 3000;/);
    assert.match(src, /document\.visibilityState !== "visible"\) return;[\s\S]{0,200}lastOther/, "标已读前没看页面在不在前台");
    assert.match(src, /!composingRef\.current && !e\.nativeEvent\.isComposing/, "输入法选字的回车会被当成发送");
    assert.match(src, /onPaste=\{onPaste\}/);
    assert.match(src, /compressImageForUpload\(input\.file\)/, "图片没压缩就发（手机原图会被 10MB 转发上限挡掉）");
    assert.match(src, /whiteSpace: "pre-wrap"/, "换行显示不出来");
    assert.ok(!/dangerouslySetInnerHTML/.test(src), "消息内容不许当 HTML 插（会被客户塞脚本）");
    const hook = read("apps/web/src/modules/cs-chat/useChatUnread.ts");
    assert.match(hook, /POLL_MS = 30_000/);
    assert.match(hook, /CHAT_UNREAD_EVENT/);
  });

  await check("S7 询价报价：客户接受时带上看到的报价时间；「还价找客服」那句只给湘泰自己的客户；员工详情里有报价、转整柜、联系客户", () => {
    const src = read("apps/web/src/components/client/FclInquiryPanel.tsx");
    assert.match(src, /JSON\.stringify\(\{ id: item\.id, quotedAt: item\.quotedAt \}\)/);
    assert.match(src, /!props\.isStaff && brand === null && list\.some/);
    assert.match(src, /\/staff\/fcl-inquiries\/quote/);
    assert.match(src, /fromInquiry=\$\{encodeURIComponent\(id\)\}/);
    assert.match(src, /\/staff\/chat\?clientId=/);
    assert.equal(inquiry.effectiveInquiryStatus({ status: "converted", fclContainerId: null, acceptedAt: new Date(), quotedAt: new Date() }), "accepted", "整柜被删后要按「已接受」显示");
    assert.equal(inquiry.effectiveInquiryStatus({ status: "converted", fclContainerId: "c1", acceptedAt: null, quotedAt: null }), "converted");
  });

  await check("S8 转整柜：只有新建（不是编辑）才带询价单号；柜型按询价单对应；弹窗关了清掉关联", async () => {
    const src = read("apps/web/src/components/fcl/FclContainerWorkbench.tsx");
    assert.match(src, /const linkInquiry = !editingId && fromInquiry \? fromInquiry : null;/);
    assert.match(src, /createFclContainer\(linkInquiry \? \{ \.\.\.payload, inquiryId: linkInquiry\.id \} : payload\)/);
    assert.ok(!/updateFclContainer\([^)]*inquiryId/.test(src), "编辑整柜也带了询价单号");
    assert.match(src, /if \(showCreate \|\| !fromInquiry\) return;\s*setFromInquiry\(null\)/, "关掉弹窗没清询价单关联");
    const typeOf = (src.match(/export function fclTypeFromInquiry[\s\S]*?\n\}/) ?? [""])[0];
    assert.ok(typeOf, "没找到 fclTypeFromInquiry");
    // eslint-disable-next-line no-new-func
    const fn = new Function(`${typeOf.replace(/^export /, "").replace(/: string\): "20GP" \| "40HQ" \| null/, ")")}; return fclTypeFromInquiry;`)();
    assert.equal(fn("1*40HQ"), "40HQ");
    assert.equal(fn("1*20GP"), "20GP");
    assert.equal(fn("2*40HQ"), null, "两个柜的不能直接当成一个 40HQ");
    assert.equal(fn("其他"), null);
  });

  await check("S9 表结构：迁移只加不删、可重复执行；结构体检清单跟上了", () => {
    const mig = "apps/api/prisma/migrations/20260928_cs_chat_and_inquiry_quote/migration.sql";
    assert.ok(existsSync(join(ROOT, mig)));
    const sql = read(mig);
    assert.ok(!/\b(DROP|TRUNCATE|DELETE\s+FROM|ALTER\s+COLUMN)\b/i.test(sql.replace(/--.*$/gm, "")), "迁移里有删 / 改的语句");
    assert.equal((sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length, 2);
    assert.equal((sql.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length, 8);
    assert.match(sql, /ON DELETE SET NULL/, "询价单连整柜的外键要置空，不然删整柜会被询价单卡住");
    const drift = read("scripts/check-schema-drift.sql");
    for (const pair of ["('cs_conversations','staff_read_at')", "('cs_messages','image_path')", "('fcl_inquiries','fcl_container_id')", "('fcl_inquiries','quote_amount_cny')"]) {
      assert.ok(drift.includes(pair), `结构体检清单漏了 ${pair}`);
    }
  });

  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
