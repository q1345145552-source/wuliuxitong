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
    // 2026-10-02 菜单按业务线重新分组：客服入口挪到「客服 / 客服与 AI / 服务」，这几组默认展开（sidebar-expanded-groups.ts）
    assert.deepEqual([find("staff", "staff-func-chat")?.g, find("staff", "staff-func-chat")?.href], ["客服", "/staff/chat"]);
    assert.deepEqual([find("admin", "admin-func-chat")?.g, find("admin", "admin-func-chat")?.href], ["客服与 AI", "/staff/chat"]);
    assert.deepEqual([find("client", "client-func-chat")?.g, find("client", "client-func-chat")?.href], ["服务", "/client/chat"]);
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
    // 菜单未读：眼前 5 秒、后台 15 秒（2026-10-02 老板：「当时收的时候响，而不是之后响」；原来 30 秒）
    assert.match(hook, /VISIBLE_MS = 5_000/);
    assert.match(hook, /HIDDEN_MS = 15_000/);
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

  await check("S10 收件箱到顶要说出来（CLAUDE.md 第 21 条）；转成整柜的唛头不许改成别的客户", () => {
    const api = read("apps/api/src/modules/cs-chat/routes.ts");
    assert.match(api, /take: CONVERSATION_LIST_LIMIT \+ 1/);
    assert.match(api, /truncated: convs\.length > CONVERSATION_LIST_LIMIT/);
    const page = read("apps/web/src/app/staff/chat/page.tsx");
    assert.match(page, /\{truncated \? \(/, "到顶了页面上没写");
    const fcl = read("apps/api/src/modules/fcl-containers/routes.ts");
    assert.match(fcl, /if \(changed\.客户唛头\) \{\s*const linkedInquiries/, "编辑整柜没拦「从询价单转来的改唛头」");
  });

  await check("S11 Codex 复核那几处前端：翻上去看旧消息不标已读、标失败下一轮补标；询价详情关了又开旧响应不盖新；转整柜金额跟报价不一样要问一句", () => {
    const chat = read("apps/web/src/modules/cs-chat/ChatThread.tsx");
    const mark = chat.slice(chat.indexOf("const markSeen = useCallback"), chat.indexOf("}, []);", chat.indexOf("const markSeen = useCallback")));
    assert.match(mark, /if \(!stickToBottomRef\.current\) return;/, "翻上去看旧消息时也标了已读");
    assert.match(mark, /lastOther\.createdAt <= lastMarkedRef\.current\) return;/, "没按「上次标到哪」去重");
    assert.match(chat, /\/\/ 没有新消息也调一次[^\n]*\n\s*markSeen\(merged\);/, "轮询没新消息时不补标（标失败就一直不补）");
    assert.match(chat, /if \(stickToBottomRef\.current\) \{\s*setNewBelow\(false\);[\s\S]{0,80}markSeen\(messagesRef\.current\)/, "翻回到底没补标已读");
    const panel = read("apps/web/src/components/client/FclInquiryPanel.tsx");
    assert.match(panel, /const seq = \+\+detailSeqRef\.current;/);
    assert.equal((panel.match(/if \(detailSeqRef\.current !== seq\) return;/g) ?? []).length, 2, "详情成功 / 失败两个分支都要核序号");
    assert.match(panel, /onClose=\{closeDetail\}/, "关详情没让序号作废");
    const wb = read("apps/web/src/components/fcl/FclContainerWorkbench.tsx");
    assert.match(wb, /Number\(filledAmount\) !== fromInquiry\.quoteAmountCny[\s\S]{0,300}window\.confirm/, "转整柜金额跟报价不一样没问");
  });

  await check("S12 手机上能用（2026-09-28 手机宽度实测）：图片不伸出气泡；员工「客户消息」窄屏一次一栏、有「‹ 返回」", () => {
    const chat = read("apps/web/src/modules/cs-chat/ChatThread.tsx");
    // 220 的上限在按钮上、图片跟着气泡缩 —— 上限写回图片上，手机上横图就伸出聊天框（气泡只有 200 来宽）
    assert.match(chat, /aria-label="看大图"/);
    const imgBtn = chat.slice(chat.lastIndexOf("<button", chat.indexOf('aria-label="看大图"')), chat.indexOf("</button>", chat.indexOf('aria-label="看大图"')));
    assert.match(imgBtn, /^<button type="button" onClick=\{\(\) => setPreview\(m\.imageUrl\)\} style=\{\{ display: "block", maxWidth: 220,/, "图片按钮没有 220 的上限");
    assert.match(imgBtn, /<img src=\{m\.imageUrl\} alt="图片" onLoad=\{[^\n]*?\} style=\{\{ display: "block", maxWidth: "100%", maxHeight: 220,/, "图片没跟着气泡缩（maxWidth 要写 100%）");
    // 返回按钮：给了 onBack 才出，带 cs-inbox-back（宽屏靠样式藏掉）
    assert.match(chat, /\{onBack \? \(\s*<button type="button" className="cs-inbox-back" onClick=\{onBack\}/);
    const page = read("apps/web/src/app/staff/chat/page.tsx");
    assert.match(page, /className=\{selected \? "cs-inbox cs-inbox--open" : "cs-inbox"\}/, "页面没按「选没选客户」切一栏 / 两栏");
    assert.match(page, /<aside className="cs-inbox-list"/);
    assert.match(page, /<section className="cs-inbox-thread"/);
    assert.match(page, /onBack=\{\(\) => select\(""\)\}/, "返回没回到客户列表");
    const css = read("apps/web/src/app/globals.css");
    assert.match(css, /\.cs-inbox-back \{ display: none; \}/, "宽屏上返回按钮没藏");
    const m = /@media \(max-width: 640px\) \{([^@]*?\.cs-inbox[\s\S]*?)\n\}/.exec(css);
    assert.ok(m, "globals.css 没有客户消息的手机样式");
    for (const rule of [
      /\.cs-inbox \.cs-inbox-list \{ width: 100% !important; \}/,
      /\.cs-inbox\.cs-inbox--open \.cs-inbox-list \{ display: none !important; \}/,
      /\.cs-inbox:not\(\.cs-inbox--open\) \.cs-inbox-thread \{ display: none !important; \}/,
      /\.cs-inbox-back \{ display: inline-flex; \}/,
    ]) assert.match(m![1], rule, `手机样式少了一条：${rule}`);
  });

  await check("S13 真跑系统查出来的（2026-09-29）：发图看文件头、不只看声明的类型；发消息的事务时限放宽（排队等锁也算在里面）", () => {
    const b64 = (buf: Buffer | string) => Buffer.from(buf).toString("base64");
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    assert.ok(!("error" in api.parseSendBody({ image: { mime: "image/png", base64: png } })), "真 png 被拒了");
    const jpg = b64(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]));
    assert.ok(!("error" in api.parseSendBody({ image: { mime: "image/jpeg", base64: jpg } })), "真 jpg 被拒了");
    const gif = b64("GIF89a\x01\x00\x01\x00");
    assert.ok(!("error" in api.parseSendBody({ image: { mime: "image/gif", base64: gif } })), "真 gif 被拒了");
    const webp = b64(Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WEBPVP8 ")]));
    assert.ok(!("error" in api.parseSendBody({ image: { mime: "image/webp", base64: webp } })), "真 webp 被拒了");
    for (const [mime, base64, why] of [
      ["image/png", b64("this is plain text not a png"), "一段文字说自己是 png"],
      ["image/jpeg", png, "png 说自己是 jpg"],
      ["image/gif", jpg, "jpg 说自己是 gif"],
      ["image/webp", b64("RIFF1234AVI LIST"), "别的 RIFF 文件说自己是 webp"],
    ] as const) {
      assert.ok("error" in api.parseSendBody({ image: { mime, base64 } }), `${why}，照样收了`);
    }
    const routes = read("apps/api/src/modules/cs-chat/routes.ts");
    const i = routes.indexOf("async function sendMessage");
    const fn = routes.slice(i, routes.indexOf("\n}\n", i));
    assert.match(fn, /\}, \{ timeout: 30000, maxWait: 10000 \}\);/, "发消息的事务还是默认 5 秒（排队等锁的时间也算在里面，同时发一多后面的就 500）");
  });

  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
