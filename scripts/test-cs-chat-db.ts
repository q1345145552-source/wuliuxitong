/**
 * 客服对话 + 整柜询价报价 / 转整柜（2026-09-28）—— 连库回归（真 handler + 真 PostgreSQL）。
 *
 * 老板拍板（原话见记忆 chat-and-inquiry-quote-plan）：像微信的对话、文字 + 图片、全部客服都能回、
 * 代理的不开这个功能；报价进系统付款线下、还价在对话里谈、柜子装完才能转整柜。
 *
 * 盯：
 *   对话 C1~C12：谁看到谁的名字（客户只看到「客服」、员工名只给超管）、未读 / 已读、图片、翻页、轮询不漏、
 *               代理名下客户两头都挡、客户之间 / 公司之间看不到、第一条同时发不会建出两条对话
 *   报价 Q1~Q9：金额校验、报价人只给超管、客户按旧价接受被拒、改价要重新接受、
 *               转整柜唛头对不上整单不写、转过不能再转 / 不能再改价、整柜被删后能重新转
 *   2026-10-02 D1~D5（老板：「这几个都可以做」+「可以选择是哪个运单…整柜的也可以」+ 选了浏览器系统通知、撤回 2 分钟）：
 *               待回复、员工之间看得到同事名字、撤回、限频、关联运单 / 整柜（只能选自己的、不带柜号、状态现查）、系统通知
 *
 * 只连测试库：DATABASE_URL 不带 neon.tech 的不跑（一次性 docker 库设 AGENT_PORTAL_TEST_ALLOW_DB=1）；
 * 没有 DATABASE_URL 打印「跳过」。测试数据全在假公司 zz_cschat_co / zz_cschat_co2 下，开跑前、跑完后都清干净。
 * 图片写进临时目录（IMAGES_DIR），跑完删掉。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Row = Record<string, any>;
type Auth = { userId: string; companyId: string; role: string; name: string; agentId: string | null };
const CO = "zz_cschat_co";
const CO2 = "zz_cschat_co2";
const ADMIN: Auth = { userId: "zz_cschat_admin", companyId: CO, role: "admin", name: "超管老王", agentId: null };
const STAFF: Auth = { userId: "zz_cschat_staff", companyId: CO, role: "staff", name: "员工小李", agentId: null };
const STAFF2: Auth = { userId: "zz_cschat_staff2", companyId: CO, role: "staff", name: "员工小张", agentId: null };
const CLIENT: Auth = { userId: "ZZCSA01", companyId: CO, role: "client", name: "客户甲的真名", agentId: null };
const CLIENT_B: Auth = { userId: "ZZCSB02", companyId: CO, role: "client", name: "客户乙", agentId: null };
const AGENT_ID = "zz_cschat_agent";
const AGENT_CLIENT: Auth = { userId: "ZZCSAG3", companyId: CO, role: "client", name: "代理的客户", agentId: AGENT_ID };
const OTHER_STAFF: Auth = { userId: "zz_cschat_o_staff", companyId: CO2, role: "staff", name: "别家员工", agentId: null };
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  if (!url.includes("neon.tech") && process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：DATABASE_URL 不是 Neon 测试库，怕连到生产库不跑（确认是测试库可设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测");
    return;
  }
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  const imagesDir = fs.mkdtempSync(path.join(os.tmpdir(), "zz-cschat-img-"));
  process.env.IMAGES_DIR = imagesDir;

  const { prisma } = await import("../apps/api/src/db/prisma");
  const { BusinessError } = await import("../apps/api/src/modules/core/business-error");
  const { agentGateRejection } = await import("../apps/api/src/modules/core/agent-scope");
  const pm: any = prisma;

  const routes = new Map<string, Function>();
  const app: any = {};
  for (const m of ["get", "post", "put", "patch", "delete"]) app[m] = (p: string, h: Function) => routes.set(`${m.toUpperCase()} ${p}`, h);
  (await import("../apps/api/src/modules/cs-chat/routes")).registerCsChatRoutes(app);
  const push = await import("../apps/api/src/modules/cs-chat/push");
  (await import("../apps/api/src/modules/fcl-inquiries/routes")).registerFclInquiryRoutes(app);
  (await import("../apps/api/src/modules/fcl-containers/routes")).registerFclContainerRoutes(app);

  async function call(key: string, auth: Auth, body: Row = {}, query: Record<string, string> = {}): Promise<{ status: number; data: any; message: string; raw: any }> {
    const handler = routes.get(key);
    if (!handler) return { status: 404, data: undefined, message: `没有这个接口：${key}`, raw: undefined };
    let status = 200; let raw: any;
    const res: any = { status(s: number) { status = s; return res; }, json(p: any) { raw = p; }, setHeader() {} };
    try { await handler({ body, query, headers: {}, auth, path: key.split(" ")[1] }, res); }
    catch (e) { if (e instanceof BusinessError) { status = e.httpStatus; raw = { code: e.code, message: e.message }; } else throw e; }
    return { status, data: raw?.data, message: raw?.message ?? "", raw };
  }
  async function must(key: string, auth: Auth, body: Row = {}, query: Record<string, string> = {}): Promise<any> {
    const r = await call(key, auth, body, query);
    assert.equal(r.status, 200, `${key} 应该成功，实际 ${r.status}：${r.message}`);
    return r.data;
  }

  async function cleanup(): Promise<void> {
    for (const co of [CO, CO2]) {
      await pm.csPushSubscription.deleteMany({ where: { companyId: co } });
      await pm.csMessage.deleteMany({ where: { companyId: co } });
      await pm.csConversation.deleteMany({ where: { companyId: co } });
      await pm.fclInquiry.deleteMany({ where: { companyId: co } });
      const cs = await pm.container.findMany({ where: { companyId: co }, select: { id: true } });
      const ids = cs.map((c: Row) => c.id);
      await pm.shipmentContainerItem.deleteMany({ where: { containerId: { in: ids } } });
      await pm.containerPushEntry.deleteMany({ where: { companyId: co } });
      await pm.containerPushBatch.deleteMany({ where: { companyId: co } });
      await pm.container.deleteMany({ where: { companyId: co } });
      await pm.statusLog.deleteMany({ where: { companyId: co } });
      await pm.orderProduct.deleteMany({ where: { companyId: co } });
      await pm.shipment.deleteMany({ where: { companyId: co } });
      await pm.order.deleteMany({ where: { companyId: co } });
      await pm.auditLog.deleteMany({ where: { companyId: co } });
      await pm.user.deleteMany({ where: { companyId: co } });
    }
    await pm.agent.deleteMany({ where: { id: AGENT_ID } });
  }

  let passed = 0, failed = 0;
  async function check(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`✅ ${name}`); }
    catch (e: any) { failed++; console.log(`❌ ${name}\n   ${e?.message ?? e}`); }
  }

  await cleanup();
  try {
    for (const u of [ADMIN, STAFF, STAFF2, CLIENT, CLIENT_B, OTHER_STAFF]) {
      await pm.user.create({ data: { id: u.userId, companyId: u.companyId, role: u.role, name: u.name, passwordHash: "x", phone: `0${u.userId}`, status: "active" } });
    }
    await pm.agent.create({ data: { id: AGENT_ID, companyId: CO, name: "测试代理", priceNormal: 100, priceInspection: 120, priceSensitive: 150 } });
    await pm.user.create({ data: { id: AGENT_CLIENT.userId, companyId: CO, role: "client", name: AGENT_CLIENT.name, passwordHash: "x", phone: "0agc", status: "active", agentId: AGENT_ID } });

    // ======================================================================
    // 对话
    // ======================================================================
    let firstClientMsgAt = "";
    await check("C1 客户发一句：员工收件箱出现这条对话、未读 1，显示唛头；员工总未读 1", async () => {
      const r = await must("POST /client/chat/send", CLIENT, { content: "  你好，我想问一下整柜价格  " });
      assert.equal(r.message.content, "你好，我想问一下整柜价格", "首尾空格要去掉");
      assert.equal(r.message.mine, true);
      firstClientMsgAt = r.message.createdAt;
      const list = await must("GET /staff/chat/conversations", STAFF);
      const conv = list.items.find((x: Row) => x.clientId === CLIENT.userId);
      assert.ok(conv, "收件箱里没有这条对话");
      assert.equal(conv.unreadCount, 1);
      assert.equal(conv.lastFromClient, true);
      assert.match(conv.lastMessagePreview, /整柜价格/);
      assert.ok(!JSON.stringify(list).includes(CLIENT.name), "员工那边不许出现客户名字，只显示唛头");
      const u = await must("GET /staff/chat/unread", STAFF2);
      assert.equal(u.count, 1, "另一个员工也要看到同一个未读（共用收件箱）");
    });

    await check("C2 员工打开对话：客户那条标唛头；标已读后所有员工的未读都清零", async () => {
      const r = await must("GET /staff/chat/messages", STAFF, {}, { clientId: CLIENT.userId });
      assert.equal(r.messages.length, 1);
      assert.equal(r.messages[0].senderLabel, CLIENT.userId);
      assert.equal(r.messages[0].side, "client");
      await must("POST /staff/chat/read", STAFF, { clientId: CLIENT.userId, upTo: r.messages[0].createdAt });
      assert.equal((await must("GET /staff/chat/unread", STAFF2)).count, 0, "共用收件箱：一个员工看过就算看过");
    });

    let staffMsgId = "";
    await check("C3 员工回复：客户看到的是「客服」，拿不到员工名字；超管、别的员工都看到「客服·名字」（2026-10-02 放开给内部）；自己看到「我」", async () => {
      const sent = await must("POST /staff/chat/send", STAFF, { clientId: CLIENT.userId, content: "您好，40HQ 到曼谷报价 18000" });
      staffMsgId = sent.message.id;
      assert.equal(sent.message.senderLabel, "我");
      const c = await must("GET /client/chat/messages", CLIENT);
      const m = c.messages.find((x: Row) => x.id === staffMsgId);
      assert.equal(m.senderLabel, "客服");
      assert.equal(m.side, "cs");
      assert.ok(!JSON.stringify(c).includes(STAFF.name), "客户的响应里出现了员工名字");
      assert.ok(!JSON.stringify(c).includes(STAFF.userId), "客户的响应里出现了员工账号");
      const a = await must("GET /staff/chat/messages", ADMIN, {}, { clientId: CLIENT.userId });
      assert.equal(a.messages.find((x: Row) => x.id === staffMsgId).senderLabel, `客服·${STAFF.name}`);
      const s2 = await must("GET /staff/chat/messages", STAFF2, {}, { clientId: CLIENT.userId });
      // 2026-10-02 老板拍板：员工之间要看得出是哪个同事回的（原来只给超管，容易重复回 / 都以为别人回了）
      assert.equal(s2.messages.find((x: Row) => x.id === staffMsgId).senderLabel, `客服·${STAFF.name}`, "别的员工看不出是哪个同事回的");
    });

    await check("C4 客户未读 1 → 客户标已读后 0；已读只往前推（拿旧时间再标一次不会退回去）", async () => {
      assert.equal((await must("GET /client/chat/unread", CLIENT)).count, 1);
      await must("POST /client/chat/read", CLIENT, {});
      assert.equal((await must("GET /client/chat/unread", CLIENT)).count, 0);
      await must("POST /client/chat/read", CLIENT, { upTo: firstClientMsgAt });
      assert.equal((await must("GET /client/chat/unread", CLIENT)).count, 0, "拿更早的时间标已读，把已读退回去了");
    });

    await check("C4b 已读（2026-10-02 老板要 LINE 那样）：取消息带回「对方看到哪」，对方一看就变；菜单未读带回最新一条没看的时间", async () => {
      // C2 员工标过已读到客户第一条：客户取消息时拿到的「客服看到哪」就是那一刻
      const c = await must("GET /client/chat/messages", CLIENT);
      assert.equal(c.peerReadAt, firstClientMsgAt, `客户那边拿不到「客服看到哪」：${c.peerReadAt}`);
      // C4 客户标过已读（读到现在）：员工那条回复对客户来说是已读
      const s = await must("GET /staff/chat/messages", STAFF2, {}, { clientId: CLIENT.userId });
      const reply = s.messages.find((x: Row) => x.id === staffMsgId);
      assert.ok(s.peerReadAt && s.peerReadAt >= reply.createdAt, `员工那边看不到客户已读：peerReadAt=${s.peerReadAt}，回复=${reply.createdAt}`);
      // 客户再发两句：员工还没看 → 客户这边不能显示已读；员工菜单的「最新未读」= 最后那句
      await must("POST /client/chat/send", CLIENT, { content: "第二句" });
      const last = (await must("POST /client/chat/send", CLIENT, { content: "第三句" })).message;
      const u = await must("GET /staff/chat/unread", STAFF);
      assert.equal(u.count, 2);
      assert.equal(u.latestAt, last.createdAt, `员工菜单拿到的「最新未读」不是最后那句：${u.latestAt}`);
      // 按客户分开报（提示音按客户分开判断，dsh 第二轮复查）：只有这个客户，时间是他最后那句
      // 按 JSON 比：这里直接调接口函数、没走网络，拿到的是无原型对象（真走网络会变成 JSON）
      assert.deepEqual(JSON.parse(JSON.stringify(u.latestByClient)), { [CLIENT.userId]: last.createdAt }, `员工菜单按客户报的最新未读不对：${JSON.stringify(u.latestByClient)}`);
      const c2 = await must("GET /client/chat/messages", CLIENT);
      assert.ok(c2.peerReadAt < last.createdAt, "员工还没看，客户那边已经算已读了");
      // 员工看了（共用收件箱，哪个员工看都算）：客户那边变已读，员工菜单没有未读了
      await must("POST /staff/chat/read", STAFF2, { clientId: CLIENT.userId, upTo: last.createdAt });
      assert.equal((await must("GET /client/chat/messages", CLIENT)).peerReadAt, last.createdAt, "员工看过了，客户那边没变已读");
      assert.equal((await must("GET /staff/chat/unread", STAFF)).latestAt, null);
      // 客服回一句：客户菜单的「最新未读」= 这句；客户看了就没了
      const r2 = (await must("POST /staff/chat/send", STAFF2, { clientId: CLIENT.userId, content: "收到" })).message;
      const cu = await must("GET /client/chat/unread", CLIENT);
      assert.equal(cu.count, 1);
      // 两个未读接口都带服务器时间（前端拿它划「打开网页时的线」，Codex 第二轮）
      assert.ok(!Number.isNaN(Date.parse(cu.serverTime)), `客户未读没带服务器时间：${cu.serverTime}`);
      assert.ok(!Number.isNaN(Date.parse((await must("GET /staff/chat/unread", STAFF)).serverTime)), "员工未读没带服务器时间");
      assert.equal(cu.latestAt, r2.createdAt);
      await must("POST /client/chat/read", CLIENT, {});
      assert.equal((await must("GET /client/chat/unread", CLIENT)).latestAt, null);
      // 还没聊过的客户：两边都是 null（不是缺字段）
      const fresh = await must("GET /staff/chat/messages", STAFF, {}, { clientId: CLIENT_B.userId });
      assert.equal(fresh.peerReadAt, null);
      assert.equal((await must("GET /client/chat/messages", CLIENT_B)).peerReadAt, null);
    });

    await check("C5 发图片：存成 /images/ 下的文件；只收 jpg/png/gif/webp；空消息、超长文字都拒绝", async () => {
      const r = await must("POST /client/chat/send", CLIENT, { image: { fileName: "a.png", mime: "image/png", base64: PNG_1x1 } });
      assert.match(r.message.imageUrl, /^\/images\/cs_ZZCSA01_[0-9a-f]+\.png$/);
      assert.ok(fs.existsSync(path.join(imagesDir, path.basename(r.message.imageUrl))), "图片文件没写到盘上");
      const list = await must("GET /staff/chat/conversations", STAFF);
      assert.equal(list.items.find((x: Row) => x.clientId === CLIENT.userId).lastMessagePreview, "[图片]");
      for (const [body, why] of [
        [{ image: { mime: "application/pdf", base64: PNG_1x1 } }, "pdf 当图片"],
        [{ content: "   " }, "只有空格"],
        [{}, "什么都没有"],
        [{ content: "字".repeat(2001) }, "2001 个字"],
        [{ image: { mime: "image/png", base64: "不是base64!!" } }, "乱码图片"],
        [{ content: 123 }, "内容不是文字"],
      ] as const) {
        const bad = await call("POST /client/chat/send", CLIENT, body as Row);
        assert.equal(bad.status, 400, `${why} 应该 400，实际 ${bad.status}`);
      }
      assert.equal((await must("POST /client/chat/send", CLIENT, { content: "字".repeat(2000) })).message.content.length, 2000, "正好 2000 个字要能发");
    });

    await check("C6 轮询 since：往前多取 5 秒、最新那条一定在；乱写时间 400", async () => {
      const all = await must("GET /client/chat/messages", CLIENT);
      const last = all.messages[all.messages.length - 1];
      const r = await must("GET /client/chat/messages", CLIENT, {}, { since: last.createdAt });
      assert.ok(r.messages.some((x: Row) => x.id === last.id), "拿最新那条的时间去轮询，结果里没有它自己（重叠窗口没生效）");
      /* 真钉住「往前多取 5 秒」（2026-09-28 分支审查：上面那句只靠 >=，把 5 秒改成 0 照样绿）：
         放一条比 since 早 2 秒的，必须带回来 */
      const convA = await pm.csConversation.findFirst({ where: { companyId: CO, clientId: CLIENT.userId } });
      const early = await pm.csMessage.create({ data: {
        companyId: CO, conversationId: convA.id, senderId: STAFF.userId, senderRole: "staff", senderName: STAFF.name,
        content: "比 since 早 2 秒", createdAt: new Date(new Date(last.createdAt).getTime() - 2000),
      } });
      const r2 = await must("GET /client/chat/messages", CLIENT, {}, { since: last.createdAt });
      assert.ok(r2.messages.some((x: Row) => x.id === early.id), "比 since 早 2 秒的那条没带回来（往前多取 5 秒没生效）");
      await pm.csMessage.delete({ where: { id: early.id } });
      const bad = await call("GET /client/chat/messages", CLIENT, {}, { since: "昨天" });
      assert.equal(bad.status, 400);
    });

    await check("C7 翻页：打开给最近 50 条 + hasMore；before 往上翻拿到更早的，前后接得上、不重不漏", async () => {
      const base = Date.now() - 3600_000;
      const conv = await pm.csConversation.findFirst({ where: { companyId: CO, clientId: CLIENT_B.userId } })
        ?? await pm.csConversation.create({ data: { companyId: CO, clientId: CLIENT_B.userId } });
      await pm.csMessage.createMany({ data: Array.from({ length: 55 }, (_, i) => ({
        companyId: CO, conversationId: conv.id, senderId: CLIENT_B.userId, senderRole: "client",
        content: `第${i + 1}条`, createdAt: new Date(base + i * 1000),
      })) });
      const p1 = await must("GET /client/chat/messages", CLIENT_B);
      assert.equal(p1.messages.length, 50);
      assert.equal(p1.hasMore, true);
      assert.equal(p1.messages[0].content, "第6条");
      assert.equal(p1.messages[49].content, "第55条", "要按时间从早到晚排");
      const p2 = await must("GET /client/chat/messages", CLIENT_B, {}, { before: p1.messages[0].createdAt });
      assert.deepEqual(p2.messages.map((m: Row) => m.content), ["第1条", "第2条", "第3条", "第4条", "第5条"]);
      assert.equal(p2.hasMore, false);
    });

    await check("C8 客户之间看不到：客户乙只看得到自己的；别家公司的员工收件箱里没有我们的客户", async () => {
      const b = await must("GET /client/chat/messages", CLIENT_B);
      assert.ok(b.messages.every((m: Row) => /^第\d+条$/.test(m.content)), "客户乙看到了别人的消息");
      const other = await must("GET /staff/chat/conversations", OTHER_STAFF);
      assert.equal(other.items.length, 0, "别家公司的员工看到了我们的对话");
      const peek = await call("GET /staff/chat/messages", OTHER_STAFF, {}, { clientId: CLIENT.userId });
      assert.notEqual(peek.status, 200, "别家公司员工按唛头直接取到了我们客户的对话");
      const send = await call("POST /staff/chat/send", OTHER_STAFF, { clientId: CLIENT.userId, content: "hi" });
      assert.equal(send.status, 404);
      // 菜单红点也不能把我们客户的未读算进别家公司（2026-09-28 分支审查：原来没测，去掉公司过滤照样绿）
      const ours = await must("GET /staff/chat/unread", STAFF);
      assert.ok(ours.count > 0, "前提不成立：我们公司这时应该有未读（客户乙那 55 条）");
      const theirs = await must("GET /staff/chat/unread", OTHER_STAFF);
      assert.equal(theirs.count, 0, `别家公司员工的红点算进了我们客户的未读：${theirs.count}`);
      assert.equal(theirs.latestAt, null, "别家公司员工拿到了我们客户最新未读的时间");
      assert.deepEqual(JSON.parse(JSON.stringify(theirs.latestByClient)), {}, "别家公司员工拿到了我们客户的唛头和未读时间");
      assert.ok(ours.latestByClient[CLIENT_B.userId], "我们公司客户乙有未读，按客户报的里面却没有他");
      assert.ok(ours.latestAt, "我们公司有未读，「最新未读」却是空的");
    });

    await check("C8c 员工菜单按客户报的最新未读：只给最近 50 个（刚来的那条一定在里面）；唛头叫 __proto__ 也照样报出来（dsh 第三轮）", async () => {
      // 先把已有的未读都标掉，免得前面几项的数据混进来
      for (const cid of [CLIENT.userId, CLIENT_B.userId]) await must("POST /staff/chat/read", STAFF, { clientId: cid });
      const base = Date.now() - 600_000;
      for (let i = 0; i < 55; i++) {
        const id = `ZZCAP${String(i).padStart(2, "0")}`;
        await pm.user.create({ data: { id, companyId: CO, role: "client", name: `容量${i}`, passwordHash: "x", phone: `0cap${i}`, status: "active" } });
        const conv = await pm.csConversation.create({ data: { companyId: CO, clientId: id, lastMessageAt: new Date(base + i * 1000) } });
        await pm.csMessage.create({ data: { companyId: CO, conversationId: conv.id, senderId: id, senderRole: "client", content: `第${i}个`, createdAt: new Date(base + i * 1000) } });
      }
      // 唛头叫 __proto__ 的客户（管理员建号不校验格式）发来最新的一条
      await pm.user.create({ data: { id: "__proto__", companyId: CO, role: "client", name: "怪唛头", passwordHash: "x", phone: "0proto", status: "active" } });
      const proto = (await must("POST /staff/chat/send", STAFF, { clientId: "__proto__", content: "先打个招呼" })).message;
      void proto;
      const last = (await call("POST /client/chat/send", { userId: "__proto__", companyId: CO, role: "client", name: "怪唛头", agentId: null } as Auth, { content: "在吗" }));
      assert.equal(last.status, 200, `唛头 __proto__ 的客户发不出消息：${last.status} ${last.message}`);
      const u = await must("GET /staff/chat/unread", STAFF);
      // 按走网络后的样子看（JSON 一转）：__proto__ 这个键在 JSON 里要在
      const json = JSON.stringify(u.latestByClient);
      assert.match(json, /"__proto__":"/, `转成 JSON 以后唛头 __proto__ 那个客户没了：${json.slice(0, 120)}`);
      u.latestByClient = JSON.parse(json);
      const keys = Object.keys(u.latestByClient);
      assert.equal(u.count >= 56, true, `前提不成立：未读应该至少 56 条，实际 ${u.count}`);
      assert.equal(keys.length, 50, `按客户报的应该只给最近 50 个，实际 ${keys.length} 个`);
      assert.ok(Object.prototype.hasOwnProperty.call(u.latestByClient, "__proto__"), `唛头 __proto__ 的客户最新那条被吞掉了：${JSON.stringify(keys.slice(0, 5))}`);
      assert.equal(u.latestByClient["__proto__"], last.data.message.createdAt);
      assert.ok(!keys.includes("ZZCAP00"), "最早那个客户也报出来了（没按最近 50 个截）");
      assert.ok(keys.includes("ZZCAP54"), "最近的客户没报出来");
    });

    await check("C8b 表情正好落在第 60 个字（列表摘要截断的位置）：照样发得出去、摘要不劈半个表情（原来整条 500）", async () => {
      const content = "字".repeat(59) + "👍" + "谢谢";
      const r = await call("POST /client/chat/send", CLIENT_B, { content });
      assert.equal(r.status, 200, `发不出去：${r.status} ${r.message}`);
      const conv = await pm.csConversation.findFirst({ where: { companyId: CO, clientId: CLIENT_B.userId } });
      assert.equal(conv.lastMessagePreview, "字".repeat(59) + "👍…", `摘要不对：${conv.lastMessagePreview}`);
      const img = await call("POST /staff/chat/send", STAFF, { clientId: CLIENT_B.userId, content: "😀".repeat(70) });
      assert.equal(img.status, 200, `员工发 70 个表情发不出去：${img.status}`);
    });

    await check("C9 代理的不开：服务端统一闸挡 /client/chat/*；接口自己也挡；员工也不能给代理名下的客户发", async () => {
      for (const p of ["/client/chat/messages", "/client/chat/send", "/client/chat/read", "/client/chat/unread"]) {
        assert.ok(agentGateRejection({ role: "client", agentId: AGENT_ID }, p), `${p} 没被统一闸挡住`);
        assert.equal(agentGateRejection({ role: "client", agentId: null }, p), null, `${p} 把湘泰自己的客户也挡了`);
      }
      assert.equal((await call("POST /client/chat/send", AGENT_CLIENT, { content: "hi" })).status, 403);
      assert.equal((await call("GET /client/chat/unread", AGENT_CLIENT)).status, 403);
      const s = await call("POST /staff/chat/send", STAFF, { clientId: AGENT_CLIENT.userId, content: "hi" });
      assert.equal(s.status, 400);
      assert.match(s.message, /代理/);
      assert.equal((await call("GET /staff/chat/messages", STAFF, {}, { clientId: AGENT_CLIENT.userId })).status, 400);
      assert.equal(await pm.csConversation.count({ where: { clientId: AGENT_CLIENT.userId } }), 0, "给代理名下的客户建出了对话");
    });

    await check("C9b 进门时还是直属客户、写进去之前被划给了代理（进门查的归属过时了）→ 锁里再核一次，403 不写", async () => {
      await pm.user.update({ where: { id: CLIENT_B.userId }, data: { agentId: AGENT_ID } });
      try {
        const before = await pm.csMessage.count({ where: { companyId: CO } });
        // CLIENT_B 这个 auth 里 agentId 还是 null（模拟进门那一刻查到的）
        const r = await call("POST /client/chat/send", CLIENT_B, { content: "划走之后还想发" });
        assert.equal(r.status, 403, `${r.status} ${r.message}`);
        const s = await call("POST /staff/chat/send", STAFF, { clientId: CLIENT_B.userId, content: "员工这边也不许发" });
        assert.notEqual(s.status, 200);
        assert.equal(await pm.csMessage.count({ where: { companyId: CO } }), before, "划给代理以后还写进了消息");
      } finally {
        await pm.user.update({ where: { id: CLIENT_B.userId }, data: { agentId: null } });
      }
    });

    await check("C10 员工能先开口（客户还没聊过）；唛头不存在 404、不是客户 404", async () => {
      await pm.csMessage.deleteMany({ where: { conversation: { clientId: CLIENT_B.userId } } });
      await pm.csConversation.deleteMany({ where: { clientId: CLIENT_B.userId } });
      const empty = await must("GET /staff/chat/messages", STAFF, {}, { clientId: CLIENT_B.userId });
      assert.equal(empty.messages.length, 0);
      await must("POST /staff/chat/send", STAFF, { clientId: CLIENT_B.userId, content: "您的货到了" });
      assert.equal((await must("GET /client/chat/unread", CLIENT_B)).count, 1);
      assert.equal((await call("POST /staff/chat/send", STAFF, { clientId: "ZZ_NOBODY", content: "x" })).status, 404);
      assert.equal((await call("POST /staff/chat/send", STAFF, { clientId: STAFF2.userId, content: "x" })).status, 404, "给员工账号发成了");
    });

    await check("C11 第一条同时发（客户和员工同一瞬间）：只建出一条对话、两条消息都在", async () => {
      await pm.csMessage.deleteMany({ where: { conversation: { clientId: CLIENT_B.userId } } });
      await pm.csConversation.deleteMany({ where: { clientId: CLIENT_B.userId } });
      const [a, b] = await Promise.all([
        call("POST /client/chat/send", CLIENT_B, { content: "我先说" }),
        call("POST /staff/chat/send", STAFF, { clientId: CLIENT_B.userId, content: "我也先说" }),
      ]);
      assert.equal(a.status, 200, a.message);
      assert.equal(b.status, 200, b.message);
      assert.equal(await pm.csConversation.count({ where: { companyId: CO, clientId: CLIENT_B.userId } }), 1);
      assert.equal(await pm.csMessage.count({ where: { conversation: { clientId: CLIENT_B.userId } } }), 2);
    });

    await check("C12 客户的消息接口里一个员工名字都没有（超管回的也一样）", async () => {
      await must("POST /staff/chat/send", ADMIN, { clientId: CLIENT.userId, content: "我是超管" });
      const c = await must("GET /client/chat/messages", CLIENT);
      const text = JSON.stringify(c);
      for (const secret of [ADMIN.name, STAFF.name, ADMIN.userId, STAFF.userId, "senderName", "senderId"]) {
        assert.ok(!text.includes(secret), `客户响应里出现了「${secret}」`);
      }
    });

    // ======================================================================
    // 报价 / 接受 / 转整柜
    // ======================================================================
    const inq = await pm.fclInquiry.create({ data: {
      companyId: CO, clientId: CLIENT.userId, createdBy: CLIENT.userId, createdByRole: "client",
      productName: "鞋子", cargoValue: "5万", cargoWeight: "20吨", address: "曼谷", containerType: "1*40HQ", serviceType: "清提派", status: "pending",
    } });

    await check("Q1 报价金额校验：0、负数、不是数字、3 位小数、超长说明都拒绝，询价单一个字不改", async () => {
      for (const [amountCny, note] of [[0, ""], [-5, ""], ["abc", ""], [1.234, ""], [100, "字".repeat(501)]] as const) {
        const r = await call("POST /staff/fcl-inquiries/quote", STAFF, { id: inq.id, amountCny, note });
        assert.equal(r.status, 400, `报价 ${amountCny} 应该 400，实际 ${r.status}`);
      }
      const db = await pm.fclInquiry.findUnique({ where: { id: inq.id } });
      assert.equal(db.status, "pending");
      assert.equal(db.quoteAmountCny, null);
      assert.equal((await call("POST /client/fcl-inquiries/accept", CLIENT, { id: inq.id, quotedAt: "x" })).status, 409, "还没报价就能接受");
    });

    let quotedAt1 = "";
    await check("Q2 员工报价：状态「已报价」；客户列表看得到金额和说明、看不到是谁报的；超管看得到", async () => {
      const r = await must("POST /staff/fcl-inquiries/quote", STAFF, { id: inq.id, amountCny: "18000.5", note: "含清关" });
      assert.equal(r.status, "quoted");
      quotedAt1 = r.quotedAt;
      const c = (await must("GET /client/fcl-inquiries", CLIENT)).items.find((x: Row) => x.id === inq.id);
      assert.equal(c.status, "quoted");
      assert.equal(c.quoteAmountCny, 18000.5);
      assert.equal(c.quoteNote, "含清关");
      assert.equal(c.quotedBy, undefined, "客户拿到了报价人");
      assert.equal(c.fclContainerId, undefined);
      const s = (await must("GET /client/fcl-inquiries", STAFF)).items.find((x: Row) => x.id === inq.id);
      assert.equal(s.quotedBy, undefined, "员工拿到了报价人（操作人身份只给超管）");
      const a = (await must("GET /client/fcl-inquiries", ADMIN)).items.find((x: Row) => x.id === inq.id);
      assert.equal(a.quotedBy, STAFF.userId);
      const d = await must("GET /client/fcl-inquiries/detail", CLIENT, {}, { id: inq.id });
      assert.equal(d.quoteAmountCny, 18000.5);
      assert.equal(d.quotedBy, undefined);
    });

    await check("Q3 改报价后客户拿旧价的时间去接受 → 409 不写；拿新时间接受 → 已接受", async () => {
      const r2 = await must("POST /staff/fcl-inquiries/quote", STAFF, { id: inq.id, amountCny: 17500, note: "还价后" });
      assert.notEqual(r2.quotedAt, quotedAt1);
      const stale = await call("POST /client/fcl-inquiries/accept", CLIENT, { id: inq.id, quotedAt: quotedAt1 });
      assert.equal(stale.status, 409);
      assert.match(stale.message, /改过报价/);
      assert.equal((await pm.fclInquiry.findUnique({ where: { id: inq.id } })).status, "quoted");
      const okr = await must("POST /client/fcl-inquiries/accept", CLIENT, { id: inq.id, quotedAt: r2.quotedAt });
      assert.equal(okr.status, "accepted");
      assert.ok(okr.acceptedAt);
      assert.equal((await call("POST /client/fcl-inquiries/accept", CLIENT, { id: inq.id, quotedAt: r2.quotedAt })).status, 409, "接受两次");
    });

    await check("Q4 别的客户动不了这张询价单（404）", async () => {
      const r = await call("POST /client/fcl-inquiries/accept", CLIENT_B, { id: inq.id, quotedAt: new Date().toISOString() });
      assert.equal(r.status, 404);
      assert.equal((await call("POST /staff/fcl-inquiries/quote", OTHER_STAFF, { id: inq.id, amountCny: 1 })).status, 404, "别家公司的员工改了我们的报价");
    });

    await check("Q4b 同一个价、同一句说明重复报（上次其实存上了、网断了又点一次）：什么都不动，客户的「已接受」不被清掉", async () => {
      const cur = await pm.fclInquiry.findUnique({ where: { id: inq.id } });
      assert.equal(cur.status, "accepted");
      const r = await must("POST /staff/fcl-inquiries/quote", STAFF, { id: inq.id, amountCny: Number(cur.quoteAmountCny), note: cur.quoteNote ?? "" });
      assert.equal(r.status, "accepted", "同价重报把客户的接受清掉了");
      const after = await pm.fclInquiry.findUnique({ where: { id: inq.id } });
      assert.equal(after.quotedAt.toISOString(), cur.quotedAt.toISOString(), "同价重报刷新了报价时间");
    });

    await check("Q5 已接受后员工再改价：回到「已报价」、客户要重新接受", async () => {
      const r = await must("POST /staff/fcl-inquiries/quote", STAFF, { id: inq.id, amountCny: 17000 });
      assert.equal(r.status, "quoted");
      assert.equal(r.acceptedAt, null);
      const again = await must("POST /client/fcl-inquiries/accept", CLIENT, { id: inq.id, quotedAt: r.quotedAt });
      assert.equal(again.status, "accepted");
    });

    await check("Q5b 真并发：员工改价的事务还没提交时客户点接受 → 等改价提交后按新价判断、拒绝旧价（锁在 lockInquiry 里）", async () => {
      const t1 = new Date(Date.now() - 60_000);
      const race = await pm.fclInquiry.create({ data: {
        companyId: CO, clientId: CLIENT.userId, createdBy: CLIENT.userId, createdByRole: "client",
        productName: "并发测试", cargoValue: "", cargoWeight: "", address: "曼谷", status: "quoted", quoteAmountCny: 100, quotedAt: t1,
      } });
      let release!: () => void;
      const hold = new Promise<void>((r) => { release = r; });
      let locked!: () => void;
      const lockedP = new Promise<void>((r) => { locked = r; });
      // 模拟员工改价：锁住这张单、改了价但先不提交
      const holder = pm.$transaction(async (tx: any) => {
        await tx.$queryRaw`SELECT id FROM fcl_inquiries WHERE id = ${race.id} FOR UPDATE`;
        await tx.fclInquiry.update({ where: { id: race.id }, data: { quoteAmountCny: 999, quotedAt: new Date(t1.getTime() + 30_000) } });
        locked();
        await hold;
      }, { timeout: 20_000 });
      await lockedP;
      const acceptP = call("POST /client/fcl-inquiries/accept", CLIENT, { id: race.id, quotedAt: t1.toISOString() });
      await new Promise((r) => setTimeout(r, 400));
      release();
      await holder;
      const r = await acceptP;
      assert.equal(r.status, 409, `客户按旧价接受成功了（锁没等到改价提交）：${r.status} ${r.message}`);
      const db = await pm.fclInquiry.findUnique({ where: { id: race.id } });
      assert.equal(db.status, "quoted");
      assert.equal(Number(db.quoteAmountCny), 999);
    });

    const fclBody = (over: Row = {}) => ({
      clientId: CLIENT.userId, trackingNo: `ZZCSBL${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      containerNo: `ZZCSCN${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      containerType: "40HQ", transportMode: "sea", warehouseId: "wh_yiwu_01", loadingDate: "2026-09-20", amountCny: "17000",
      products: [{ itemName: "鞋子", packageCount: 10, quantityPerBox: 20, lengthCm: 60, widthCm: 40, heightCm: 30, unitWeightKg: 2.5, cargoType: "normal" }],
      inquiryId: inq.id, ...over,
    });

    await check("Q6 转整柜时唛头填成别的客户 → 400，柜子一个都没建、询价单不动", async () => {
      const before = await pm.container.count({ where: { companyId: CO } });
      const r = await call("POST /staff/fcl-containers/create", STAFF, fclBody({ clientId: CLIENT_B.userId }));
      assert.equal(r.status, 400, r.message);
      assert.match(r.message, /对不上/);
      assert.equal(await pm.container.count({ where: { companyId: CO } }), before);
      assert.equal((await pm.fclInquiry.findUnique({ where: { id: inq.id } })).status, "accepted");
    });

    let containerId = "";
    await check("Q7 转整柜：建柜成功、询价单变「已转整柜」并记上柜子；客户看得到「已转整柜」、拿不到柜子 id", async () => {
      const r = await must("POST /staff/fcl-containers/create", STAFF, fclBody());
      containerId = r.containerId;
      const db = await pm.fclInquiry.findUnique({ where: { id: inq.id } });
      assert.equal(db.status, "converted");
      assert.equal(db.fclContainerId, containerId);
      assert.equal(db.convertedBy, STAFF.userId);
      const c = (await must("GET /client/fcl-inquiries", CLIENT)).items.find((x: Row) => x.id === inq.id);
      assert.equal(c.status, "converted");
      assert.equal(c.fclContainerId, undefined);
      assert.equal(c.convertedBy, undefined);
      const s = (await must("GET /client/fcl-inquiries", STAFF)).items.find((x: Row) => x.id === inq.id);
      assert.equal(s.fclContainerId, containerId);
      assert.equal(s.fclDeleted, false);
    });

    await check("Q7b 从询价单转来的整柜：编辑时唛头改成别的客户 → 400 不写；同一个客户改别的（金额）照常能改", async () => {
      const body = fclBody();
      const c = await pm.container.findUnique({ where: { id: containerId }, include: { items: { include: { shipment: true } } } });
      const base = {
        containerId, trackingNo: c.items[0].shipment.trackingNo, containerNo: c.containerNo, containerType: "40HQ",
        transportMode: "sea", warehouseId: "wh_yiwu_01", loadingDate: body.loadingDate, products: body.products,
      };
      const bad = await call("POST /staff/fcl-containers/update", STAFF, { ...base, clientId: CLIENT_B.userId, amountCny: "17000" });
      assert.equal(bad.status, 400, bad.message);
      assert.match(bad.message, /询价转来的/);
      const order = await pm.order.findUnique({ where: { id: c.items[0].shipment.orderId } });
      assert.equal(order.clientId, CLIENT.userId, "唛头被改了");
      const good = await call("POST /staff/fcl-containers/update", STAFF, { ...base, clientId: CLIENT.userId, amountCny: "17500" });
      assert.equal(good.status, 200, good.message);
    });

    await check("Q8 转过了：再转一次 409 且不多建柜子；再改报价 409；客户再接受 409", async () => {
      const before = await pm.container.count({ where: { companyId: CO } });
      const r = await call("POST /staff/fcl-containers/create", STAFF, fclBody());
      assert.equal(r.status, 409, r.message);
      assert.equal(await pm.container.count({ where: { companyId: CO } }), before, "转第二次多建了一个柜子");
      assert.equal((await call("POST /staff/fcl-inquiries/quote", STAFF, { id: inq.id, amountCny: 1 })).status, 409);
      assert.equal((await call("POST /client/fcl-inquiries/accept", CLIENT, { id: inq.id, quotedAt: new Date().toISOString() })).status, 409);
    });

    await check("Q9 超管删掉这个整柜：询价单按「已接受」显示、员工那边提示整柜已删，可以重新转", async () => {
      const cn = (await pm.container.findUnique({ where: { id: containerId } })).containerNo;
      await must("POST /admin/fcl-containers/delete", ADMIN, { containerId, confirmContainerNo: cn });
      const db = await pm.fclInquiry.findUnique({ where: { id: inq.id } });
      assert.equal(db.fclContainerId, null, "外键没置空");
      const s = (await must("GET /client/fcl-inquiries", STAFF)).items.find((x: Row) => x.id === inq.id);
      assert.equal(s.status, "accepted");
      assert.equal(s.fclDeleted, true);
      const c = (await must("GET /client/fcl-inquiries", CLIENT)).items.find((x: Row) => x.id === inq.id);
      assert.equal(c.status, "accepted");
      const again = await must("POST /staff/fcl-containers/create", STAFF, fclBody());
      assert.equal((await pm.fclInquiry.findUnique({ where: { id: inq.id } })).fclContainerId, again.containerId);
    });

    await check("Q9b 没接受就转了整柜、后来整柜被删：页面显示「已报价」，客户点接受能成功（不能按库里的 converted 拒绝）", async () => {
      const inq3 = await pm.fclInquiry.create({ data: {
        companyId: CO, clientId: CLIENT.userId, createdBy: CLIENT.userId, createdByRole: "client",
        productName: "没接受就转", cargoValue: "", cargoWeight: "", address: "曼谷", status: "pending",
      } });
      const q = await must("POST /staff/fcl-inquiries/quote", STAFF, { id: inq3.id, amountCny: 5000 });
      const made = await must("POST /staff/fcl-containers/create", STAFF, fclBody({ inquiryId: inq3.id, amountCny: "5000" }));
      const cn = (await pm.container.findUnique({ where: { id: made.containerId } })).containerNo;
      await must("POST /admin/fcl-containers/delete", ADMIN, { containerId: made.containerId, confirmContainerNo: cn });
      const c = (await must("GET /client/fcl-inquiries", CLIENT)).items.find((x: Row) => x.id === inq3.id);
      assert.equal(c.status, "quoted");
      const acc = await call("POST /client/fcl-inquiries/accept", CLIENT, { id: inq3.id, quotedAt: q.quotedAt });
      assert.equal(acc.status, 200, `页面上有「接受」按钮，点了却被拒：${acc.message}`);
      const db = await pm.fclInquiry.findUnique({ where: { id: inq3.id } });
      assert.equal(db.status, "accepted");
      assert.equal(db.convertedAt, null);
    });

    await check("Q10 不带询价单号建整柜：跟以前一模一样（不碰任何询价单）", async () => {
      const r = await must("POST /staff/fcl-containers/create", STAFF, fclBody({ inquiryId: undefined }));
      assert.ok(r.containerId);
      assert.equal(await pm.fclInquiry.count({ where: { fclContainerId: r.containerId } }), 0);
    });

    // ======================================================================
    // 2026-10-02：待回复 / 同事名字 / 撤回 / 限频 / 关联运单整柜 / 系统通知
    // ======================================================================
    /** 再造几个干净的客户（不跟上面那些混，未读、限频都各算各的） */
    const mkClient = async (id: string, agentId: string | null = null): Promise<Auth> => {
      await pm.user.create({ data: { id, companyId: CO, role: "client", name: `${id}的真名`, passwordHash: "x", phone: `0${id}`, status: "active", agentId } });
      return { userId: id, companyId: CO, role: "client", name: `${id}的真名`, agentId };
    };
    const D1C = await mkClient("ZZD1PEND");
    const D2C = await mkClient("ZZD2RECA");
    const D3C = await mkClient("ZZD3REFA");
    const D3B = await mkClient("ZZD3REFB");
    const D5C = await mkClient("ZZD5PUSH");
    const convOf = (cid: string) => pm.csConversation.findFirst({ where: { companyId: CO, clientId: cid } });

    await check("D1 待回复：客户说了话 → 待回复、记下从哪条开始等；员工只看了没回照样待回复；回了就不是；只看待回复的筛得出来；代理名下的不算", async () => {
      const first = (await must("POST /client/chat/send", D1C, { content: "在吗" })).message;
      await must("POST /client/chat/send", D1C, { content: "我的货到哪了" });
      let list = await must("GET /staff/chat/conversations", STAFF);
      let row = list.items.find((x: Row) => x.clientId === D1C.userId);
      assert.equal(row.pendingReply, true, "客户说了话，列表没标待回复");
      assert.equal(row.pendingSince, first.createdAt, `等待起点不是客户第一句：${row.pendingSince}`);
      assert.equal(row.lastFromUs, false);
      assert.ok(list.pendingCount >= 1);
      const before = list.pendingCount;
      // 员工看了（已读）但没回：还是待回复（这正是老板说的「已读不回容易漏」）
      await must("POST /staff/chat/read", STAFF, { clientId: D1C.userId });
      row = (await must("GET /staff/chat/conversations", STAFF2)).items.find((x: Row) => x.clientId === D1C.userId);
      assert.equal(row.unreadCount, 0);
      assert.equal(row.pendingReply, true, "看过就不算待回复了 —— 已读不回又会漏");
      // 只看待回复：有它；别的已经回过的客户（CLIENT 最后一句是超管说的）不在里面
      const pend = await must("GET /staff/chat/conversations", STAFF, {}, { filter: "pending" });
      assert.ok(pend.items.some((x: Row) => x.clientId === D1C.userId));
      assert.ok(pend.items.every((x: Row) => x.pendingReply === true), "「待回复」页签里混进了不用回的");
      assert.ok(!pend.items.some((x: Row) => x.clientId === CLIENT.userId), "已经回过的客户出现在待回复里");
      // 回了：不再待回复，列表摘要标「我方」
      await must("POST /staff/chat/send", STAFF2, { clientId: D1C.userId, content: "在的，我查一下" });
      list = await must("GET /staff/chat/conversations", STAFF);
      row = list.items.find((x: Row) => x.clientId === D1C.userId);
      assert.equal(row.pendingReply, false);
      assert.equal(row.pendingSince, null);
      assert.equal(row.lastFromUs, true);
      assert.equal(list.pendingCount, before - 1, "回完以后待回复的总数没少");
      // 客户再追问一句：又待回复，等待起点是这句（不是最早那句）
      const again = (await must("POST /client/chat/send", D1C, { content: "好的谢谢，大概几天？" })).message;
      row = (await must("GET /staff/chat/conversations", STAFF)).items.find((x: Row) => x.clientId === D1C.userId);
      assert.equal(row.pendingSince, again.createdAt);
      // 划给代理以后：列表里还在（只能看），但不算待回复、不进总数
      const cnt = (await must("GET /staff/chat/conversations", STAFF)).pendingCount;
      await pm.user.update({ where: { id: D1C.userId }, data: { agentId: AGENT_ID } });
      try {
        const l2 = await must("GET /staff/chat/conversations", STAFF);
        const r2 = l2.items.find((x: Row) => x.clientId === D1C.userId);
        assert.equal(r2.closed, true);
        assert.equal(r2.pendingReply, false, "划给代理的客户（回不了）还标着待回复");
        assert.equal(l2.pendingCount, cnt - 1);
        const p2 = await must("GET /staff/chat/conversations", STAFF, {}, { filter: "pending" });
        assert.ok(!p2.items.some((x: Row) => x.clientId === D1C.userId));
      } finally {
        await pm.user.update({ where: { id: D1C.userId }, data: { agentId: null } });
      }
    });

    await check("D2 撤回：自己发的 2 分钟内能撤；两边都看到「撤回了」、拿不到原文 / 图片；别人的撤不了；超时撤不了；点两下第二次原样返回；图片文件删掉", async () => {
      const m1 = (await must("POST /client/chat/send", D2C, { content: "发错了的那句" })).message;
      const img = (await must("POST /client/chat/send", D2C, { image: { fileName: "a.png", mime: "image/png", base64: PNG_1x1 } })).message;
      const imgFile = path.join(imagesDir, path.basename(img.imageUrl));
      assert.ok(fs.existsSync(imgFile));
      // 员工撤不了客户的（哪怕知道 id）
      const steal = await call("POST /staff/chat/recall", STAFF, { clientId: D2C.userId, messageId: m1.id });
      assert.equal(steal.status, 403, `员工撤回了客户的消息：${steal.status}`);
      // 别的客户拿这个 id 撤：当作没有这条
      assert.equal((await call("POST /client/chat/recall", CLIENT, { messageId: m1.id })).status, 404);
      const r = await must("POST /client/chat/recall", D2C, { messageId: m1.id });
      assert.equal(r.message.recalled, true);
      assert.equal(r.message.content, null);
      const again = await must("POST /client/chat/recall", D2C, { messageId: m1.id });
      assert.equal(again.message.recalled, true, "点两下第二次报错了");
      await must("POST /client/chat/recall", D2C, { messageId: img.id });
      assert.ok(!fs.existsSync(imgFile), "撤回了图片，文件还留在盘上");
      const s = await must("GET /staff/chat/messages", STAFF, {}, { clientId: D2C.userId });
      const seen = s.messages.find((x: Row) => x.id === m1.id);
      assert.equal(seen.recalled, true);
      assert.equal(seen.content, null);
      assert.ok(!JSON.stringify(s).includes("发错了的那句"), "员工那边还拿得到撤回的原文");
      assert.equal(s.messages.find((x: Row) => x.id === img.id).imageUrl, null);
      const db = await pm.csMessage.findUnique({ where: { id: m1.id } });
      assert.equal(db.content, null, "库里还留着撤回的原文");
      // 撤回的不算未读（员工这边没看过，两条都撤了 → 0）
      const u = await must("GET /staff/chat/unread", STAFF);
      assert.ok(!(D2C.userId in JSON.parse(JSON.stringify(u.latestByClient))), "撤回的消息还在算未读 / 还会响提示音");
      // 超时：放一条 3 分钟前的
      const old = (await must("POST /client/chat/send", D2C, { content: "三分钟前的" })).message;
      await pm.csMessage.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - 3 * 60_000) } });
      const late = await call("POST /client/chat/recall", D2C, { messageId: old.id });
      assert.equal(late.status, 400, `超过 2 分钟还撤回成了：${late.status}`);
      assert.match(late.message, /2 分钟/);
      assert.equal((await pm.csMessage.findUnique({ where: { id: old.id } })).content, "三分钟前的");
      // 员工撤自己的
      const mine = (await must("POST /staff/chat/send", STAFF2, { clientId: D2C.userId, content: "报错价了" })).message;
      assert.equal((await must("POST /staff/chat/recall", STAFF2, { clientId: D2C.userId, messageId: mine.id })).message.recalled, true);
      const c = await must("GET /client/chat/messages", D2C);
      const cm = c.messages.find((x: Row) => x.id === mine.id);
      assert.equal(cm.recalled, true);
      assert.equal(cm.senderLabel, "客服", "客户看撤回的那条也不许带员工名字");
      assert.ok(!JSON.stringify(c).includes("报错价了"));
      // 别的员工也撤不了这位员工的
      const m2 = (await must("POST /staff/chat/send", STAFF2, { clientId: D2C.userId, content: "这句留着" })).message;
      assert.equal((await call("POST /staff/chat/recall", STAFF, { clientId: D2C.userId, messageId: m2.id })).status, 403);
    });

    await check("D2b 撤回在轮询里 3 秒内传到对方：拿撤回之前的时间轮询，那条带着「已撤回」回来（哪怕它是早就发的）", async () => {
      const m = (await must("POST /client/chat/send", D2C, { content: "要撤的" })).message;
      // 让它看起来是 1 分钟前发的（在撤回时限里，但早于轮询起点往前 5 秒）
      await pm.csMessage.update({ where: { id: m.id }, data: { createdAt: new Date(Date.now() - 60_000) } });
      const since = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 20));
      await must("POST /client/chat/recall", D2C, { messageId: m.id });
      const poll = await must("GET /staff/chat/messages", STAFF, {}, { clientId: D2C.userId, since });
      const got = poll.messages.find((x: Row) => x.id === m.id);
      assert.ok(got, "撤回的那条没在轮询里带回来（对方屏幕上一直显示原文）");
      assert.equal(got.recalled, true);
    });

    await check("D2c 撤回最新那条：列表摘要和「待回复」按前面那条还在的算；一条都不剩写「撤回了一条消息」、不算待回复", async () => {
      const cid = "ZZD2CSUM";
      const C = await mkClient(cid);
      const a = (await must("POST /client/chat/send", C, { content: "就一句" })).message;
      assert.equal((await must("GET /staff/chat/conversations", STAFF, {}, { q: cid })).items[0].pendingReply, true);
      await must("POST /client/chat/recall", C, { messageId: a.id });
      let row = (await must("GET /staff/chat/conversations", STAFF, {}, { q: cid })).items[0];
      assert.equal(row.lastMessagePreview, "[撤回了一条消息]");
      assert.equal(row.pendingReply, false, "客户唯一一句撤回了，还挂着待回复");
      assert.equal(row.lastFromUs, false, "一条都不剩，摘要前面却写「我方」");
      await must("POST /staff/chat/send", STAFF, { clientId: cid, content: "您好有什么可以帮您" });
      const b = (await must("POST /client/chat/send", C, { content: "说错了" })).message;
      assert.equal((await must("GET /staff/chat/conversations", STAFF, {}, { q: cid })).items[0].pendingReply, true);
      await must("POST /client/chat/recall", C, { messageId: b.id });
      row = (await must("GET /staff/chat/conversations", STAFF, {}, { q: cid })).items[0];
      assert.equal(row.lastMessagePreview, "您好有什么可以帮您", "撤回最新那条以后摘要没退回前一条");
      assert.equal(row.lastFromUs, true);
      assert.equal(row.pendingReply, false, "客户撤回了追问，还挂着待回复");
      // 员工撤回了自己的回复：客户之前那句又变成没人回
      const q1 = (await must("POST /client/chat/send", C, { content: "运费多少" })).message;
      const reply = (await must("POST /staff/chat/send", STAFF, { clientId: cid, content: "回错了" })).message;
      assert.equal((await must("GET /staff/chat/conversations", STAFF, {}, { q: cid })).items[0].pendingReply, false);
      await must("POST /staff/chat/recall", STAFF, { clientId: cid, messageId: reply.id });
      row = (await must("GET /staff/chat/conversations", STAFF, {}, { q: cid })).items[0];
      assert.equal(row.pendingReply, true, "员工撤回了唯一的回复，客户那句却不算待回复了");
      assert.equal(row.pendingSince, q1.createdAt);
    });

    // 关联运单 / 整柜要用的单子：D3C 两张普通运单（一张父单一张它的子单）、D3B 一张；D3C 一个整柜
    const mkShipment = async (cid: string, no: string, item: string, over: Row = {}) => {
      const oid = `zz_cs_o_${no}`;
      await pm.order.create({ data: {
        id: oid, companyId: CO, clientId: cid, warehouseId: "wh_yiwu_01", itemName: item, productQuantity: 1, packageCount: 3,
        packageUnit: "箱", transportMode: "sea", receiverNameTh: "收件人", receiverPhoneTh: "0811111111", receiverAddressTh: "曼谷",
      } });
      await pm.shipment.create({ data: { id: `zz_cs_s_${no}`, companyId: CO, orderId: oid, trackingNo: no, currentStatus: "inWarehouseCN", warehouseId: "wh_yiwu_01", packageCount: 3, packageUnit: "箱", ...over } });
      return `zz_cs_s_${no}`;
    };
    const shipA = await mkShipment(D3C.userId, "ZZCSREF001", "蓝牙耳机");
    await pm.shipment.create({ data: { id: "zz_cs_s_ZZCSREF001-1", companyId: CO, orderId: "zz_cs_o_ZZCSREF001", trackingNo: "ZZCSREF001-1", parentTrackingNo: "ZZCSREF001", currentStatus: "loaded", warehouseId: "wh_yiwu_01" } });
    const shipA2 = await mkShipment(D3C.userId, "ZZCSREF002", "手机壳");
    const shipB = await mkShipment(D3B.userId, "ZZCSREF900", "别人的货");
    const fclMade = await must("POST /staff/fcl-containers/create", STAFF, fclBody({ clientId: D3C.userId, inquiryId: undefined, trackingNo: "ZZCSFCLBL01", containerNo: "ZZCSCNTR777" }));
    const fclId = fclMade.containerId as string;

    await check("D3 选单子：只列这个客户自己的父单和整柜（子单、别人的不列）；整柜只给提单号、一个柜号字都没有；搜索在后端筛", async () => {
      const c = await must("GET /client/chat/refs", D3C);
      assert.deepEqual(c.shipments.map((x: Row) => x.no).sort(), ["ZZCSREF001", "ZZCSREF002"], `运单列错了：${c.shipments.map((x: Row) => x.no)}`);
      assert.deepEqual(c.fcl.map((x: Row) => x.no), ["ZZCSFCLBL01"]);
      assert.equal(c.fcl[0].id, fclId);
      assert.ok(!JSON.stringify(c).includes("ZZCSCNTR777"), "客户选单子的列表里出现了柜号");
      assert.ok(!c.shipments.some((x: Row) => x.no === "ZZCSFCLBL01"), "整柜的单混进了普通运单");
      assert.equal(c.shipmentsTruncated, false);
      const s = await must("GET /staff/chat/refs", STAFF, {}, { clientId: D3C.userId, q: "耳机" });
      assert.deepEqual(s.shipments.map((x: Row) => x.no), ["ZZCSREF001"], "按品名搜没在后端筛");
      assert.equal(s.fcl.length, 0);
      const byNo = await must("GET /staff/chat/refs", STAFF, {}, { clientId: D3C.userId, q: "fclbl" });
      assert.deepEqual(byNo.fcl.map((x: Row) => x.no), ["ZZCSFCLBL01"], "按提单号（小写）搜不到整柜");
      const byCntr = await must("GET /staff/chat/refs", STAFF, {}, { clientId: D3C.userId, q: "ZZCSCNTR777" });
      assert.equal(byCntr.fcl.length, 0, "能按柜号搜到整柜（柜号不进对话）");
      assert.equal((await call("GET /staff/chat/refs", STAFF, {}, { clientId: AGENT_CLIENT.userId })).status, 400, "代理名下的客户也能列单子");
      assert.equal((await call("GET /client/chat/refs", AGENT_CLIENT)).status, 403);
      assert.equal((await call("GET /staff/chat/refs", OTHER_STAFF, {}, { clientId: D3B.userId })).status, 404, "别家公司员工列出了我们客户的单子");
    });

    await check("D3b 带单子发：两边气泡里有单号、品名、现在的状态；只发单子不写字也行；摘要写 [运单 xxx]；别人的单 / 子单 / 乱写类型都拒、什么都不写", async () => {
      const r = await must("POST /client/chat/send", D3C, { content: "这票什么时候到", ref: { type: "shipment", id: shipA } });
      assert.deepEqual(r.message.ref, { type: "shipment", id: shipA, no: "ZZCSREF001", title: "蓝牙耳机", status: "inWarehouseCN", gone: false });
      const conv = await convOf(D3C.userId);
      assert.equal(conv.lastMessagePreview, "[运单 ZZCSREF001] 这票什么时候到");
      const onlyRef = await must("POST /staff/chat/send", STAFF, { clientId: D3C.userId, ref: { type: "fcl", id: fclId } });
      assert.equal(onlyRef.message.content, null);
      assert.equal(onlyRef.message.ref.no, "ZZCSFCLBL01");
      assert.equal(onlyRef.message.ref.type, "fcl");
      const c = await must("GET /client/chat/messages", D3C);
      assert.ok(!JSON.stringify(c).includes("ZZCSCNTR777"), "客户的消息里出现了柜号");
      const fclMsg = c.messages.find((x: Row) => x.id === onlyRef.message.id);
      assert.equal(fclMsg.ref.title, "鞋子");
      assert.ok(fclMsg.ref.status, "整柜现在的状态没带出来");
      const before = await pm.csMessage.count({ where: { companyId: CO } });
      for (const [who, body, why] of [
        [D3C, { content: "x", ref: { type: "shipment", id: shipB } }, "别的客户的运单"],
        [D3C, { content: "x", ref: { type: "shipment", id: "zz_cs_s_ZZCSREF001-1" } }, "子单"],
        [D3C, { content: "x", ref: { type: "shipment", id: "nope" } }, "不存在的运单"],
      ] as const) {
        const bad = await call("POST /client/chat/send", who as Auth, body as Row);
        assert.equal(bad.status, 404, `${why} 应该 404，实际 ${bad.status} ${bad.message}`);
      }
      const staffBad = await call("POST /staff/chat/send", STAFF, { clientId: D3B.userId, ref: { type: "fcl", id: fclId } });
      assert.equal(staffBad.status, 404, "员工给客户乙发了客户甲的整柜");
      for (const ref of [{ type: "container", id: fclId }, { type: "shipment", id: "" }, { type: "shipment", id: 123 }]) {
        assert.equal((await call("POST /client/chat/send", D3C, { ref } as Row)).status, 400, `乱写的单子收了：${JSON.stringify(ref)}`);
      }
      assert.equal(await pm.csMessage.count({ where: { companyId: CO } }), before, "被拒的消息写进去了");
    });

    await check("D3c 状态现查：单子推了状态，气泡跟着变；单子改归别的客户，这边只剩单号（gone），不带别人的状态", async () => {
      const r = await must("POST /client/chat/send", D3C, { content: "这票呢", ref: { type: "shipment", id: shipA2 } });
      await pm.shipment.update({ where: { id: shipA2 }, data: { currentStatus: "departed" } });
      let c = await must("GET /client/chat/messages", D3C);
      assert.equal(c.messages.find((x: Row) => x.id === r.message.id).ref.status, "departed", "状态没跟着变");
      await pm.order.update({ where: { id: "zz_cs_o_ZZCSREF002" }, data: { clientId: D3B.userId } });
      try {
        c = await must("GET /client/chat/messages", D3C);
        const ref = c.messages.find((x: Row) => x.id === r.message.id).ref;
        assert.equal(ref.gone, true, "单子已经不是他的了，还标着在");
        assert.equal(ref.status, null, "单子已经不是他的了，还把现在的状态带给他");
        assert.equal(ref.no, "ZZCSREF002", "发送时记下的单号没留住");
      } finally {
        await pm.order.update({ where: { id: "zz_cs_o_ZZCSREF002" }, data: { clientId: D3C.userId } });
      }
    });

    await check("D3d 撤回带单子的消息：单子一起清掉", async () => {
      const r = await must("POST /client/chat/send", D3C, { ref: { type: "shipment", id: shipA } });
      const back = await must("POST /client/chat/recall", D3C, { messageId: r.message.id });
      assert.equal(back.message.ref, null);
      const db = await pm.csMessage.findUnique({ where: { id: r.message.id } });
      assert.deepEqual([db.refType, db.refId, db.refNo, db.refTitle], [null, null, null, null]);
    });

    await check("D4 限频：一个账号一分钟最多 30 条，第 31 条 429、什么都不写；图片一分钟最多 10 张", async () => {
      const C = await mkClient("ZZD4RATE");
      for (let i = 0; i < 30; i++) await must("POST /client/chat/send", C, { content: `第${i}条` });
      const n = await pm.csMessage.count({ where: { senderId: C.userId } });
      const r = await call("POST /client/chat/send", C, { content: "第31条" });
      assert.equal(r.status, 429, `第 31 条没被拦：${r.status}`);
      assert.match(r.message, /太快/);
      assert.equal(await pm.csMessage.count({ where: { senderId: C.userId } }), n);
      const I = await mkClient("ZZD4IMGS");
      for (let i = 0; i < 10; i++) await must("POST /client/chat/send", I, { image: { fileName: "a.png", mime: "image/png", base64: PNG_1x1 } });
      const ri = await call("POST /client/chat/send", I, { image: { fileName: "a.png", mime: "image/png", base64: PNG_1x1 } });
      assert.equal(ri.status, 429, `第 11 张图没被拦：${ri.status}`);
      assert.equal((await call("POST /client/chat/send", I, { content: "图发不了，打字总行吧" })).status, 200, "图片超了，文字也被拦了");
      // 别人不受影响
      assert.equal((await call("POST /client/chat/send", D2C, { content: "我照样能发" })).status, 200);
    });

    await check("D5 系统通知：开通知只收各家推送服务的地址；客户发 → 本公司员工 / 超管；客服发 → 那个客户；通知里没有员工名字；地址作废（410）就删；没配密钥不开", async () => {
      const sent: Array<{ endpoint: string; payload: any; topic: string }> = [];
      const failing = new Set<string>();
      const cfg = { publicKey: "BPubKeyForTest", privateKey: "priv", subject: "mailto:test@example.com" };
      push.setPushSenderForTest(async (t, payload, o) => {
        if (failing.has(t.endpoint)) { const e: any = new Error("gone"); e.statusCode = 410; throw e; }
        sent.push({ endpoint: t.endpoint, payload: JSON.parse(payload), topic: o.topic });
        return { statusCode: 201 };
      }, cfg);
      try {
        const keys = { p256dh: "B".repeat(87), auth: "a".repeat(22) };
        const ep = (n: string) => `https://fcm.googleapis.com/fcm/send/${n}`;
        assert.deepEqual(await must("GET /client/chat/push/key", D5C), { enabled: true, publicKey: cfg.publicKey });
        for (const bad of ["http://fcm.googleapis.com/x", "https://127.0.0.1/x", "https://evil.example.com/fcm.googleapis.com", "https://fcm.googleapis.com.evil.com/x", "https://fcm.googleapis.com:8443/x"]) {
          const r = await call("POST /client/chat/push/subscribe", D5C, { endpoint: bad, keys });
          assert.equal(r.status, 400, `不认识的通知地址收了：${bad}`);
        }
        await must("POST /client/chat/push/subscribe", D5C, { endpoint: ep("client1"), keys });
        await must("POST /staff/chat/push/subscribe", STAFF, { endpoint: ep("staff1"), keys });
        await must("POST /staff/chat/push/subscribe", ADMIN, { endpoint: ep("admin1"), keys });
        await must("POST /staff/chat/push/subscribe", OTHER_STAFF, { endpoint: ep("other1"), keys });
        assert.equal(await pm.csPushSubscription.count({ where: { endpoint: { in: [ep("client1"), ep("staff1"), ep("admin1")] } } }), 3);

        await must("POST /client/chat/send", D5C, { content: "货到了吗" });
        await push.waitForPushesForTest();
        assert.deepEqual(sent.map((x) => x.endpoint).sort(), [ep("admin1"), ep("staff1")], `客户发的推错了人：${sent.map((x) => x.endpoint)}`);
        assert.equal(sent[0].payload.title, `客户 ${D5C.userId}`);
        assert.equal(sent[0].payload.body, "货到了吗");
        assert.equal(sent[0].payload.url, `/staff/chat?clientId=${D5C.userId}`);
        assert.ok(sent[0].topic.length <= 32 && /^[A-Za-z0-9_-]+$/.test(sent[0].topic), `topic 不合规：${sent[0].topic}`);

        sent.length = 0;
        // shipA 是 D3C 的，不是 D5C 的 → 404，什么都不推
        assert.equal((await call("POST /staff/chat/send", STAFF, { clientId: D5C.userId, content: "到曼谷仓了", ref: { type: "shipment", id: shipA } })).status, 404);
        await push.waitForPushesForTest();
        assert.equal(sent.length, 0, "发送失败了还推了通知");
        await must("POST /staff/chat/send", STAFF, { clientId: D5C.userId, content: "到曼谷仓了" });
        await push.waitForPushesForTest();
        assert.deepEqual(sent.map((x) => x.endpoint), [ep("client1")], "客服发的没只推给这个客户");
        assert.equal(sent[0].payload.title, "客服给你发来消息");
        assert.equal(sent[0].payload.url, "/client/chat");
        assert.ok(!JSON.stringify(sent).includes(STAFF.name), "推给客户的通知里有员工名字");

        // 同一个浏览器换人登录（客户甲的电脑上员工登了）：订阅改归员工，客户甲不再收到
        await must("POST /staff/chat/push/subscribe", STAFF2, { endpoint: ep("client1"), keys });
        sent.length = 0;
        await must("POST /staff/chat/send", STAFF, { clientId: D5C.userId, content: "再说一句" });
        await push.waitForPushesForTest();
        assert.equal(sent.length, 0, "浏览器已经换人登录了，还在给原来的客户推");

        // 地址作废：删掉那一行
        failing.add(ep("staff1"));
        await must("POST /client/chat/send", D5C, { content: "在吗" });
        await push.waitForPushesForTest();
        assert.equal(await pm.csPushSubscription.count({ where: { endpoint: ep("staff1") } }), 0, "推送服务说地址作废了，没删");
        // 关通知只删自己的
        await must("POST /staff/chat/push/unsubscribe", STAFF, { endpoint: ep("admin1") });
        assert.equal(await pm.csPushSubscription.count({ where: { endpoint: ep("admin1") } }), 1, "员工把超管的订阅删了");
        await must("POST /staff/chat/push/unsubscribe", ADMIN, { endpoint: ep("admin1") });
        assert.equal(await pm.csPushSubscription.count({ where: { endpoint: ep("admin1") } }), 0);
        // 一个账号最多留 10 个浏览器
        for (let i = 0; i < 12; i++) await must("POST /client/chat/push/subscribe", D5C, { endpoint: ep(`many${i}`), keys });
        assert.equal(await pm.csPushSubscription.count({ where: { userId: D5C.userId } }), 10);
        // 代理名下的客户：统一闸挡 /client/chat/push/*，接口自己也挡
        assert.ok(agentGateRejection({ role: "client", agentId: AGENT_ID }, "/client/chat/push/subscribe"));
        assert.equal((await call("POST /client/chat/push/subscribe", AGENT_CLIENT, { endpoint: ep("ag"), keys })).status, 403);
      } finally {
        push.setPushSenderForTest(null);
      }
      // 没配密钥：页面拿到 enabled=false，订阅 400
      push.setPushSenderForTest(async () => ({ statusCode: 201 }), null);
      try {
        assert.deepEqual(await must("GET /staff/chat/push/key", STAFF), { enabled: false, publicKey: null });
        assert.equal((await call("POST /staff/chat/push/subscribe", STAFF, { endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } })).status, 400);
      } finally {
        push.setPushSenderForTest(null);
      }
    });
  } finally {
    await cleanup();
    await pm.$disconnect();
    fs.rmSync(imagesDir, { recursive: true, force: true });
  }
  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
