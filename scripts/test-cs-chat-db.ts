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
    await check("C3 员工回复：客户看到的是「客服」，拿不到员工名字；超管看到「客服·名字」；别的员工只看到「客服」；自己看到「我」", async () => {
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
      assert.equal(s2.messages.find((x: Row) => x.id === staffMsgId).senderLabel, "客服");
      assert.ok(!JSON.stringify(s2).includes(STAFF.name), "员工之间也不许看到是谁回的（操作人身份只给超管）");
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
  } finally {
    await cleanup();
    await pm.$disconnect();
    fs.rmSync(imagesDir, { recursive: true, force: true });
  }
  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
