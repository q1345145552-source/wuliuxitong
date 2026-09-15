/**
 * 「每分钟 10 条」那道闸的自测，由 test-ai-chat-limits.ts 起子进程调用。
 *
 * 为什么要单独一个进程：主脚本为了测「每天 200 条」，
 * 把 AI_CHAT_MAX_PER_MINUTE 放宽到了 10 万，同一个进程里改不回来
 * （上限是模块加载那一刻读的环境变量）。
 * 主脚本会用两种环境跑它：不设这个变量（走默认 10）、
 * 以及设成 "-1" 这种非法值（应该被忽略、同样退回 10）。
 *
 * 跟主脚本一样用超长消息当探针，走不到 service.chat，不连库不花钱。
 */
import assert from "node:assert/strict";
import type { HttpRequest, HttpResponse, MinimalHttpApp } from "../apps/api/src/server";
import { registerClientAiRoutes } from "../apps/api/src/modules/ai/client-ai-routes";

type Handler = (req: HttpRequest, res: HttpResponse) => Promise<void> | void;
const routes = new Map<string, Handler>();
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

const chat = routes.get("POST /client/ai/chat");
assert.ok(chat, "没注册 /client/ai/chat 路由");

async function call(userId: string) {
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
  await chat!(
    {
      method: "POST",
      path: "/client/ai/chat",
      query: {},
      headers: {},
      body: { message: "货".repeat(501) },
      auth: { userId, companyId: "c_1", role: "client", name: "测试客户", agentId: null },
    },
    res,
  );
  assert.ok(status === 400 || status === 429, `不该走到业务逻辑（拿到 ${status}）`);
  return { status, message: payload.message ?? "" };
}

async function main() {
  for (let i = 1; i <= 10; i += 1) {
    const result = await call("u_minute_1");
    assert.equal(result.status, 400, `第 ${i} 条就被限流了，太早`);
  }
  const eleventh = await call("u_minute_1");
  assert.equal(eleventh.status, 429, "第 11 条没有被限流");
  assert.ok(eleventh.message.includes("每分钟最多 10 条"), `提示语不对：${eleventh.message}`);

  const other = await call("u_minute_2");
  assert.equal(other.status, 400, "另一个账号被上一个账号的计数连累了");

  console.log("MINUTE_LIMIT_OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
