import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpRequest } from "./server";
import { verifyAuthToken, type AuthTokenPayload } from "./modules/auth/token";
import { isSessionStillValid, type SessionCheckResult } from "./modules/auth/session-guard";
import { isTokenRevoked } from "./modules/core/token-blacklist";
import { logger } from "./modules/core/logger";
import { realtimeHub, type RealtimeHub, type RealtimeConnection } from "./modules/realtime/hub";
import type { RealtimeTopic } from "./modules/realtime/topics";

/**
 * 实时推送的那条长连接（2026-10-05）：`GET /auth/events`。
 *
 * 用的是 SSE（服务器一直往下写的普通 HTTP 响应），不是 WebSocket：
 * 线上是 nginx → Next 转发 → 接口，Next 的转发不管 WebSocket 升级，SSE 就是普通请求，照样能过。
 * 放在 /auth 下面是因为 Next 已经把 /auth/* 转给接口了，四种角色都能用，不用改转发规则。
 *
 * ⚠️ 登录状态必须走 Authorization 头（前端用 fetch 读流，不用浏览器自带的 EventSource ——
 *    那个带不了请求头，只能把令牌塞进网址，网址会进 nginx 访问日志）。
 *
 * ⚠️ 为什么放在 src/ 这一层、跟 server.ts 并排，不放 modules/：业务模块一律碰不到原始响应对象
 *    （测试 test:api-response 第 8 项守着，防有人绕开统一的响应格式）。这条长连接必须直接往下写，
 *    所以跟 server.ts 一样算「管线」这一层；它只写 SSE 的几种行（retry / data / event: bye / 心跳），
 *    不写 JSON 响应体 —— 认不出人时由 server.ts 走 fail() 回 401。
 */
export const REALTIME_STREAM_PATH = "/auth/events";

/** 多久写一次心跳。nginx 默认 60 秒没动静就断、Next 转发 30 秒，心跳要比两个都短 */
export const HEARTBEAT_MS = 20_000;
/**
 * 多久复查一次登录状态。这条连接可能一开就是一整天，
 * 封号、改密码、退出登录都要能把它断掉（同 CLAUDE.md 第 38 条：存下来反复用的通行证要回头核）。
 */
export const RECHECK_MS = 60_000;

export interface StreamOptions {
  hub?: RealtimeHub;
  heartbeatMs?: number;
  recheckMs?: number;
  /** 测试用：替掉查库的那一步 */
  checkSession?: (payload: AuthTokenPayload) => Promise<SessionCheckResult>;
}

function bearerToken(headers: IncomingMessage["headers"]): string | null {
  const header = typeof headers.authorization === "string" ? headers.authorization.trim() : "";
  return header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || null;
}

/**
 * 接住一条实时连接。调用前 server.ts 已经用 parseAuth 认过人（auth 不为空）。
 * 写给浏览器的只有两种东西：心跳注释行，和 `data: {"t":["shipping",...]}`。
 */
export function openEventStream(
  rawReq: IncomingMessage,
  rawRes: ServerResponse,
  auth: NonNullable<HttpRequest["auth"]>,
  options: StreamOptions = {},
): RealtimeConnection | null {
  const hub = options.hub ?? realtimeHub;
  const token = bearerToken(rawReq.headers);
  const payload = token ? verifyAuthToken(token) : null;
  if (!token || !payload) return null; // parseAuth 刚认过，到这儿不会发生；真发生了交给调用方回 401

  rawRes.statusCode = 200;
  rawRes.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  // no-transform：别让中间哪一层（Next 的压缩）把流攒起来压缩，攒着就不实时了
  rawRes.setHeader("Cache-Control", "no-cache, no-transform");
  rawRes.setHeader("Connection", "keep-alive");
  // nginx 认这个头：这条响应不缓冲，写一句转一句
  rawRes.setHeader("X-Accel-Buffering", "no");
  rawRes.socket?.setNoDelay(true);
  rawRes.socket?.setKeepAlive(true);
  // 断线后浏览器隔 3 秒重连（我们自己读流时也照这个值）；第一句注释行把响应头立刻推出去
  rawRes.write("retry: 3000\n: ok\n\n");

  let closed = false;
  const checkSession = options.checkSession ?? isSessionStillValid;

  const conn: RealtimeConnection = {
    id: hub.allocateId(),
    userId: auth.userId,
    companyId: auth.companyId,
    role: auth.role,
    agentId: auth.agentId,
    write(topics: RealtimeTopic[]) {
      if (closed || rawRes.writableEnded) return;
      rawRes.write(`data: ${JSON.stringify({ t: topics })}\n\n`);
    },
    close(reason: string) {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearInterval(recheck);
      hub.remove(conn.id);
      if (!rawRes.writableEnded) {
        // 告诉前端为什么断：登录失效的别再重连了
        rawRes.write(`event: bye\ndata: ${JSON.stringify({ reason })}\n\n`);
        rawRes.end();
      }
    },
  };

  const heartbeat = setInterval(() => {
    if (!closed && !rawRes.writableEnded) rawRes.write(": ping\n\n");
  }, options.heartbeatMs ?? HEARTBEAT_MS);

  const recheck = setInterval(() => {
    void (async () => {
      if (closed) return;
      if (isTokenRevoked(token)) return conn.close("auth:登录已退出");
      if (payload.exp * 1000 <= Date.now()) return conn.close("auth:登录已过期");
      let live: SessionCheckResult;
      try {
        live = await checkSession(payload);
      } catch (error) {
        // 数据库一时连不上：别把所有人都断了，下一分钟再查
        logger.warn("实时连接复查登录状态失败（先不断开）", { 用户: conn.userId, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      if (!live.ok) return conn.close(`auth:${live.reason}`);
      conn.agentId = live.agentId;
    })();
  }, options.recheckMs ?? RECHECK_MS);

  // 浏览器关页面 / 断网 / 切后台被系统掐掉：都从这儿收尾
  rawReq.on("close", () => conn.close("对方已断开"));
  rawRes.on("error", () => conn.close("写出错"));

  hub.add(conn);
  return conn;
}
