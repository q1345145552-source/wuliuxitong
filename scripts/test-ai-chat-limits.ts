/**
 * AI 聊天接口的四道闸自测（不连数据库、不连 DeepSeek）。
 *
 * 为什么要有这个：`/client/ai/chat` 是全系统唯一直接花钱的接口 ——
 * 每条消息固定调两次 DeepSeek。上线以来它一次限流都没有，消息长度也不校验。
 *
 * ⚠️ 这个脚本**一次都不能走到 service.chat**：那里会连数据库、并调两次 DeepSeek。
 * 做法是让每个请求都在某一道闸前面被拦下 —— 四道闸的先后顺序是
 * 【每分钟 → 每天 → 消息长度 → sessionId 长度 → service.chat】，
 * 所以「要验证某一道闸放行了」就故意让它撞下一道闸，用下一道闸的报错反证前一道放行了。
 * 初版没这么写，结果真跑去连了 Neon 测试库（还触发了 ai_session_memory 的过期清理）。
 *
 * ⚠️ 本进程把「每分钟」放宽到 10 万，否则第 11 条就被分钟闸拦住、测不到「每天 200 条」。
 * 分钟闸由 test-ai-chat-minute-limit.ts 另起一个进程按默认值验（见第 7 项）。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { HttpRequest, HttpResponse, MinimalHttpApp } from "../apps/api/src/server";

// 上限是模块加载那一刻从环境变量读的，所以必须先设好、再动态 import
process.env.AI_CHAT_MAX_PER_MINUTE = "100000";

type Handler = (req: HttpRequest, res: HttpResponse) => Promise<void> | void;

let chat: Handler;
let reachedService = false;

async function loadRoute(): Promise<void> {
  const routes = new Map<string, Handler>();
  const { registerClientAiRoutes } = await import("../apps/api/src/modules/ai/client-ai-routes");
  registerClientAiRoutes({
    get(p, h) {
      routes.set(`GET ${p}`, h);
    },
    post(p, h) {
      routes.set(`POST ${p}`, h);
    },
    delete(p, h) {
      routes.set(`DELETE ${p}`, h);
    },
    listen() {},
  } satisfies MinimalHttpApp);
  const handler = routes.get("POST /client/ai/chat");
  assert.ok(handler, "没注册 /client/ai/chat 路由");
  chat = handler;
}

async function call(userId: string, body: unknown) {
  let status = 0;
  let payload: { message?: string } = {};
  const res: HttpResponse = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: unknown) {
      payload = value as { message?: string };
    },
  };
  await chat(
    {
      method: "POST",
      path: "/client/ai/chat",
      query: {},
      headers: {},
      body,
      auth: { userId, companyId: "c_1", role: "client", name: "测试客户", agentId: null },
    },
    res,
  );
  // 四道闸只会回 400/429。出现别的（500 或 200）就说明请求穿过去了、
  // 真的去连库调模型了 —— 这正是初版脚本踩的坑，必须当场炸出来。
  if (status !== 400 && status !== 429) reachedService = true;
  return { status, message: payload.message ?? "" };
}

const failures: string[] = [];
async function check(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(name);
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${message.split("\n").join("\n     ")}`);
  }
}

async function main() {
  await loadRoute();
  console.log("AI 聊天接口限流与长度校验");

  // 用超长消息当"探针"：它一定会被长度闸拦成 400。
  // 于是收到 400 = 前面的限流放行了，收到 429 = 被限流了。全程走不到 service.chat。
  const tooLong = { message: "货".repeat(501) };

  await check("1) 每天前 200 条放行、第 201 条被拦（429）", async () => {
    const userId = "u_day_1";
    for (let i = 1; i <= 200; i += 1) {
      const result = await call(userId, tooLong);
      assert.equal(result.status, 400, `第 ${i} 条就被拦了，太早（拿到 ${result.status}）`);
    }
    const over = await call(userId, tooLong);
    assert.equal(over.status, 429, "第 201 条没有被拦");
    assert.ok(over.message.includes("每天最多 200 条"), `提示语不对：${over.message}`);
  });

  await check("2) 日上限按账号算，换个账号不受上一个账号连累", async () => {
    const other = await call("u_day_2", tooLong);
    assert.equal(other.status, 400, "另一个账号被上一个账号的计数连累了");
  });

  await check("3) 超过 500 字直接拒，不往下走（不花钱）", async () => {
    const result = await call("u_len_1", tooLong);
    assert.equal(result.status, 400);
    assert.ok(result.message.includes("500 个字"), `提示语不对：${result.message}`);
  });

  await check("4) 正好 500 字不算超长（边界不能误伤）", async () => {
    // 同样用"探针"手法：配一个超长 sessionId，让它被下一道闸拦下。
    // 拿到「会话标识」的报错 = 500 字这一关放行了；拿到「500 个字」= 边界写错了。
    const result = await call("u_len_2", {
      message: "货".repeat(500),
      sessionId: "s".repeat(101),
    });
    assert.equal(result.status, 400);
    assert.ok(result.message.includes("会话标识"), `500 字被长度闸误拦了：${result.message}`);
  });

  await check("5) 超长 sessionId 被拒（它会被当成 key 写进会话记忆表）", async () => {
    const result = await call("u_sess_1", { message: "你好", sessionId: "s".repeat(101) });
    assert.equal(result.status, 400);
    assert.ok(result.message.includes("会话标识"), `提示语不对：${result.message}`);
  });

  await check("6) 环境变量填了乱七八糟的值时退回默认值，不会把闸门敞开", async () => {
    const script = path.join(__dirname, "test-ai-chat-minute-limit.ts");
    const out = execFileSync(process.execPath, ["--import", "tsx", script], {
      encoding: "utf-8",
      // 负数是非法值，必须被忽略、退回默认的 10
      env: { ...process.env, AI_CHAT_MAX_PER_MINUTE: "-1" },
    });
    assert.ok(out.includes("MINUTE_LIMIT_OK"), `子进程没通过：\n${out}`);
  });

  await check("7) 每分钟 10 条那道闸（另起一个进程按默认值验）", async () => {
    const script = path.join(__dirname, "test-ai-chat-minute-limit.ts");
    const env = { ...process.env };
    delete env.AI_CHAT_MAX_PER_MINUTE;
    const out = execFileSync(process.execPath, ["--import", "tsx", script], {
      encoding: "utf-8",
      env,
    });
    assert.ok(out.includes("MINUTE_LIMIT_OK"), `子进程没通过：\n${out}`);
  });

  await check("8) 日上限按北京日历日换桶：北京 23:59 用满，过了 0 点要放行", async () => {
    /**
     * ⚠️ 之前一项都没测「换桶」—— 桶的 key 是 `ai-chat-day-${beijingDayKey()}`，
     * 而 `beijingDayKey()` 要是写成按**服务器时区**取日期（生产容器是 UTC），
     * 换桶就会发生在北京早上 8 点，而不是 0 点：
     * 北京 0 点到 8 点之间的客户还在用昨天那个已经用满的桶，问一句就被拒。
     *
     * 时间是从 `Date.now()` 读的，所以这里把时钟**冻在一个固定时刻**再跨过 0 点，
     * 不依赖「今天几号」，什么时候跑都是同一个结果。
     */
    const realNow = Date.now;
    try {
      // 北京 2026-01-01 23:59:00 ＝ UTC 2026-01-01 15:59:00
      const beijing2359 = Date.UTC(2026, 0, 1, 15, 59, 0);
      Date.now = () => beijing2359;
      const userId = "u_day_rollover";
      for (let i = 1; i <= 200; i += 1) {
        const result = await call(userId, tooLong);
        assert.equal(result.status, 400, `北京 23:59 的第 ${i} 条就被日闸拦了`);
      }
      const over = await call(userId, tooLong);
      assert.equal(over.status, 429, "北京 23:59 的第 201 条没被日闸拦住");
      assert.ok(over.message.includes("每天最多 200 条"), `提示语不对：${over.message}`);

      // 往前拨 2 分钟，跨过北京 0 点 —— 新的一天，同一个账号必须重新放行
      Date.now = () => beijing2359 + 2 * 60_000;
      const nextDay = await call(userId, tooLong);
      assert.equal(
        nextDay.status,
        400,
        "过了北京 0 点还在拦 —— 日桶没换，客户后半夜到早上 8 点都问不了",
      );

      // 再回到 23:59 那一刻：昨天那个桶该还是满的（别把「换桶」写成「清零」）
      Date.now = () => beijing2359;
      const yesterdayStillFull = await call(userId, tooLong);
      assert.equal(yesterdayStillFull.status, 429, "换桶被写成了清零，昨天的计数丢了");
    } finally {
      Date.now = realNow;
    }
  });

  await check("9) 全程没有走到 service.chat（没连库、没调 DeepSeek）", async () => {
    assert.equal(
      reachedService,
      false,
      "有请求穿过了所有闸门走进业务逻辑 —— 这个脚本不该连数据库",
    );
  });

  if (failures.length > 0) {
    throw new Error(`${failures.length}/9 项不通过：${failures.join("；")}`);
  }
  console.log("AI 聊天接口限流：9 项全部通过");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
