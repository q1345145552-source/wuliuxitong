import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { describeTokenFailure, verifyAuthToken } from "./modules/auth/token";
import { isSessionStillValid } from "./modules/auth/session-guard";
import { isTokenRevoked } from "./modules/core/token-blacklist";
import { logger } from "./modules/core/logger";
import { isBusinessError } from "./modules/core/business-error";
import { fail } from "./modules/core/http-utils";
import { agentGateRejection } from "./modules/core/agent-scope";
import type { UserRole } from "../../../packages/shared-types/role";

export interface HttpRequest {
  method: string;
  path: string;
  query: Record<string, string | undefined>;
  body?: unknown;
  headers: IncomingMessage["headers"];
  auth?: {
    userId: string;
    companyId: string;
    role: UserRole;
    name: string;
    /**
     * 所属代理（2026-09-16）。每个请求由 session-guard 从库里现读，不看令牌：
     * role=agent → 这个代理的 id；role=client → 客户归哪个代理，湘泰自己的客户为 null；
     * 管理员 / 员工恒为 null。
     */
    agentId: string | null;
  };
}

export interface HttpResponse {
  status(code: number): HttpResponse;
  json(payload: unknown): void;
  /**
   * 这一次请求的编号（`req_xxx`），由请求管线在最外层塞进来。
   * `ok()` / `fail()` 会把它放进响应体 —— 契约（docs/api-contract.md 第 2、3 节）
   * 要求成功和失败都带 requestId，之前一直是空的。
   * 客户截图报错时，靠它就能在日志里定位到那一次请求。
   */
  requestId?: string;
}

type Handler = (req: HttpRequest, res: HttpResponse) => Promise<void> | void;

export interface MinimalHttpApp {
  get(path: string, handler: Handler): void;
  post(path: string, handler: Handler): void;
  delete(path: string, handler: Handler): void;
  listen(port: number, callback?: () => void): void;
}

type RouteTable = Record<string, Handler>;

/**
 * 从请求头里解出登录身份。
 * 2026-08-07：认证失败原来一声不吭，前端拿到 401 就把用户踢回登录页，
 * 排查时完全没有线索。这里补上日志（只记原因和路径，绝不记令牌内容）。
 */
async function parseAuth(headers: IncomingMessage["headers"], path?: string): Promise<HttpRequest["auth"]> {
  const authHeader = typeof headers.authorization === "string" ? headers.authorization.trim() : "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) {
    if (authHeader) {
      logger.warn("认证失败：Authorization 头格式不对", { path, 头长度: authHeader.length });
    }
    return undefined;
  }
  const payload = verifyAuthToken(match[1].trim());
  if (!payload) {
    logger.warn("认证失败：令牌没通过", { path, 原因: describeTokenFailure(match[1].trim()) });
    return undefined;
  }
  /**
   * 退出登录的令牌当场作废（2026-08-31，排查报告第 58 条收尾）。
   * requireAuth 里已有同样一道，但 ai/client-ai-routes.ts 那批接口是直接读
   * req.auth、不走 requireAuth 的 —— 只有加在这里才罩得住全部路由。
   * 顺带省一次 session-guard 的数据库查询：拉黑的令牌不用再查账号状态。
   */
  if (isTokenRevoked(match[1].trim())) {
    logger.warn("认证失败：令牌已退出作废", { path, 用户: payload.userId });
    return undefined;
  }
  /**
   * ⚠️ 签名对、没过期，**还不够**（2026-08-25 新增）。
   * 账号可能已经被封禁、或者密码已经改过 —— 那两种情况下这张令牌必须当场作废，
   * 不能让它继续用满 7 天。详见 session-guard.ts。
   */
  const live = await isSessionStillValid(payload);
  if (!live.ok) {
    logger.warn("认证失败：登录状态已失效", { path, 用户: payload.userId, 原因: live.reason });
    return undefined;
  }
  return {
    userId: payload.userId,
    companyId: payload.companyId,
    role: payload.role,
    name: payload.userName ?? "",
    agentId: live.agentId,
  };
}

/**
 * 每次请求一个编号。契约（docs/api-contract.md）要求成功和失败都带 `requestId`，
 * 之前一直没生成过。同时写进 `X-Request-Id` 响应头 ——
 * 客户截图报错时，从截图或浏览器控制台就能拿到它，直接去日志里定位那一次请求。
 */
function newRequestId(): string {
  return `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 造一个响应对象。**所有响应都从这里的 `json()` 出去**，盖章也做在那儿。
 * 导出是为了让自测脚本能拿真的实现跑一遍（scripts/test-api-response-shape.ts）——
 * 上一版测试是正则扫源码，复核实测能绕过（先把响应体存进变量再发就认不出来了）。
 */
export function createJsonResponse(rawRes: ServerResponse): HttpResponse {
  let statusCode = 200;
  const requestId = newRequestId();
  return {
    requestId,
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      rawRes.statusCode = statusCode;
      rawRes.setHeader("Content-Type", "application/json; charset=utf-8");
      rawRes.setHeader("X-Request-Id", requestId);
      rawRes.end(JSON.stringify(stampEnvelope(payload, requestId)));
    },
  };
}

/**
 * 在**唯一的出口**上给响应体盖章：补上 `requestId`（没有 timestamp 的也补上）。
 *
 * ⚠️ 为什么放在这里、而不是只改 `ok()` / `fail()`：
 * 2026-08-28 复核实测，AI 那一组接口有自己的 `jsonOk` / `jsonError`（52 处调用），
 * 拼出来的响应体没有 requestId；而我上一版的做法是「让大家都去调 ok()/fail()」，
 * 靠人记得 —— 记不住。所有响应最后都要经过这一个 `json()`，
 * 在这里盖章，**现在漏的和以后新写的都盖得到**，一个调用点都不用改。
 *
 * 只认「长得像契约响应体」的对象（有 code 字段），别的原样放行。
 */
function stampEnvelope(payload: unknown, requestId: string): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const body = payload as Record<string, unknown>;
  if (typeof body.code !== "string") return payload;
  return {
    ...body,
    requestId: typeof body.requestId === "string" && body.requestId ? body.requestId : requestId,
    timestamp: typeof body.timestamp === "string" && body.timestamp ? body.timestamp : new Date().toISOString(),
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const maxBytes = 20 * 1024 * 1024; // 20MB 限制
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) return undefined;
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function createApp(): MinimalHttpApp {
  const getRoutes: RouteTable = {};
  const postRoutes: RouteTable = {};
  const deleteRoutes: RouteTable = {};

  const app: MinimalHttpApp = {
    get(path, handler) {
      getRoutes[path] = handler;
    },
    post(path, handler) {
      postRoutes[path] = handler;
    },
    delete(path, handler) {
      deleteRoutes[path] = handler;
    },
    listen(port, callback) {
      // 【审查问题 1】原来整段逻辑直接写在 createServer 的回调里，
      // 而 try/catch 只包住了最后调 handler 的那一句。
      // 前面的 await readJsonBody() 一抛错（客户上传照片中途断网就会）
      // 就是一个没人接的 Promise rejection —— Node 会直接结束进程，整个 API 挂掉。
      // 现在把整段抽成函数，在外面统一兜一层。
      const handleRequest = async (rawReq: IncomingMessage, rawRes: ServerResponse): Promise<void> => {
        const allowedOrigin = process.env.CORS_ORIGIN?.trim() || (process.env.NODE_ENV === "production" ? "" : "*");
        if (allowedOrigin) {
          rawRes.setHeader("Access-Control-Allow-Origin", allowedOrigin);
        }
        rawRes.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
        rawRes.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type,x-role,x-user-id,x-company-id,Authorization",
        );
        rawRes.setHeader("Vary", "Origin");

        if ((rawReq.method ?? "").toUpperCase() === "OPTIONS") {
          rawRes.statusCode = 204;
          rawRes.end();
          return;
        }

        const method = rawReq.method?.toUpperCase() ?? "GET";
        const requestUrl = new URL(rawReq.url ?? "/", "http://localhost");
        const path = requestUrl.pathname;
        const query: Record<string, string | undefined> = {};
        requestUrl.searchParams.forEach((value, key) => {
          query[key] = value;
        });

        // 静态文件服务：/images/* → 直接从磁盘读取
        if (method === "GET" && path.startsWith("/images/")) {
          const fs = await import("node:fs");
          const pathModule = await import("node:path");
          const imagesDir = process.env.IMAGES_DIR || "./data/images";
          const filePath = pathModule.default.join(imagesDir, pathModule.default.basename(path));
          if (!fs.default.existsSync(filePath)) {
            rawRes.statusCode = 404;
            rawRes.end("Not Found");
            return;
          }
          const ext = pathModule.default.extname(filePath).toLowerCase();
          const mimeTypes: Record<string, string> = {
            ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
            ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
          };
          rawRes.setHeader("Content-Type", mimeTypes[ext] ?? "application/octet-stream");
          rawRes.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          const buf = fs.default.readFileSync(filePath);
          rawRes.end(buf);
          return;
        }

        const routeTable =
          method === "POST" ? postRoutes : method === "DELETE" ? deleteRoutes : getRoutes;
        const handler = routeTable[path];
        const res = createJsonResponse(rawRes);
        if (!handler) {
          // 这条以前也是自己拼的，同样少了 errors / requestId / timestamp
          fail(res, 404, "NOT_FOUND", `Route not found: ${method} ${path}`);
          return;
        }

        const req: HttpRequest = {
          method,
          path,
          query,
          headers: rawReq.headers,
          body: method === "POST" || method === "DELETE" ? await readJsonBody(rawReq) : undefined,
          auth: await parseAuth(rawReq.headers, path),
        };

        /**
         * ⚠️ 代理账号统一闸（2026-09-16）。放在所有路由之前，一处管全部：
         * · 代理的客户（client + agentId）碰 /client/consolidation、/client/ai → 403「该功能暂未开放」
         *   （确认单 4.1 / 5.7 / 3.6）。AI 那批接口直接读 req.auth、不走 requireRole，逐个加容易漏。
         * · 代理本人（agent）只许碰 /agent/*、/auth/*，别的一律 403（双保险，理由见 agent-scope.ts）。
         * agentId 是 session-guard 每次从库里现读的，改归属 / 停代理当场生效。
         */
        const agentGate = agentGateRejection(req.auth, path);
        if (agentGate) {
          logger.warn("代理账号统一闸拦截", { path, 用户: req.auth?.userId, 角色: req.auth?.role });
          fail(res, 403, "FORBIDDEN", agentGate);
          return;
        }

        try {
          await handler(req, res);
        } catch (error) {
          /**
           * ⚠️ 业务错误统一在这里转成 400，别让它变成 500（2026-08-27 新增）。
           *
           * 「整柜已取消不许收钱」那几道闸门是抛异常实现的。原来靠每个路由自己
           * try/catch，结果四个管理员接口全忘了接 —— 员工看到「服务器繁忙」，
           * 完全不知道是柜被取消了。放在最外层就忘不了，以后再加闸门也自动生效。
           */
          /**
           * ⚠️ 一律走 `fail()`，不要自己拼响应体（2026-08-28 改）。
           * 原来这两处直接 `res.json({ code, message })`，少了契约要求的
           * `errors` / `requestId` / `timestamp` —— 同一个系统里两种错误格式，
           * 前端要写两套解析，客户报错时也没有编号可查。
           */
          if (isBusinessError(error)) {
            logger.warn("业务规则拦截", { path, requestId: res.requestId, 原因: error.message });
            fail(res, error.httpStatus, error.code, error.message);
            return;
          }
          logger.error("unhandled error", {
            path,
            requestId: res.requestId,
            error: error instanceof Error ? error.message : String(error),
          });
          const isProduction = process.env.NODE_ENV === "production";
          const message = isProduction
            ? "Internal server error"
            : error instanceof Error ? error.message : "internal error";
          fail(res, 500, "INTERNAL_ERROR", message);
        }
      };

      const server = createServer((rawReq, rawRes) => {
        void handleRequest(rawReq, rawRes).catch((error: unknown) => {
          logger.error("request pipeline error", {
            method: rawReq.method,
            url: rawReq.url,
            error: error instanceof Error ? error.message : String(error),
          });
          // 静态图片那条分支可能已经开始往外写了，这时候不能再写响应头
          if (rawRes.headersSent) {
            if (!rawRes.writableEnded) rawRes.end();
            return;
          }
          /**
           * ⚠️ 这条路**绕开了 res.json**（那时候还没有 res 对象），
           * 所以盖章要自己来 —— 复核就是在这里逮到少字段的（2026-08-28 补齐）。
           * 格式必须跟 fail() 拼出来的一模一样，别让前端遇到第三种形状。
           */
          const pipelineRequestId = newRequestId();
          rawRes.statusCode = 500;
          rawRes.setHeader("Content-Type", "application/json; charset=utf-8");
          rawRes.setHeader("X-Request-Id", pipelineRequestId);
          rawRes.end(
            JSON.stringify({
              code: "INTERNAL_ERROR",
              message: "Internal server error",
              errors: [{ reason: "Internal server error" }],
              requestId: pipelineRequestId,
              timestamp: new Date().toISOString(),
            }),
          );
        });
      });

      const host = process.env.BIND_HOST?.trim() || "0.0.0.0";
      server.listen(port, host, callback);
    },
  };

  return app;
}
