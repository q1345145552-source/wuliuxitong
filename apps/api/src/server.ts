import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { verifyAuthToken } from "./modules/auth/token";
import { logger } from "./modules/core/logger";

export interface HttpRequest {
  method: string;
  path: string;
  query: Record<string, string | undefined>;
  body?: unknown;
  headers: IncomingMessage["headers"];
  auth?: {
    userId: string;
    companyId: string;
    role: "admin" | "staff" | "client";
    name: string;
  };
}

export interface HttpResponse {
  status(code: number): HttpResponse;
  json(payload: unknown): void;
}

type Handler = (req: HttpRequest, res: HttpResponse) => Promise<void> | void;

export interface MinimalHttpApp {
  get(path: string, handler: Handler): void;
  post(path: string, handler: Handler): void;
  delete(path: string, handler: Handler): void;
  listen(port: number, callback?: () => void): void;
}

type RouteTable = Record<string, Handler>;

function parseAuth(headers: IncomingMessage["headers"]): HttpRequest["auth"] {
  const authHeader = typeof headers.authorization === "string" ? headers.authorization.trim() : "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) return undefined;
  const payload = verifyAuthToken(match[1].trim());
  if (!payload) return undefined;
  return {
    userId: payload.userId,
    companyId: payload.companyId,
    role: payload.role,
    name: payload.userName ?? "",
  };
}

function createJsonResponse(rawRes: ServerResponse): HttpResponse {
  let statusCode = 200;
  return {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      rawRes.statusCode = statusCode;
      rawRes.setHeader("Content-Type", "application/json; charset=utf-8");
      rawRes.end(JSON.stringify(payload));
    },
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
      const server = createServer(async (rawReq, rawRes) => {
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
          const imagesDir = process.env.IMAGES_DIR || "/images";
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
          res.status(404).json({
            code: "NOT_FOUND",
            message: `Route not found: ${method} ${path}`,
          });
          return;
        }

        const req: HttpRequest = {
          method,
          path,
          query,
          headers: rawReq.headers,
          body: method === "POST" || method === "DELETE" ? await readJsonBody(rawReq) : undefined,
          auth: parseAuth(rawReq.headers),
        };

        try {
          await handler(req, res);
        } catch (error) {
          logger.error("unhandled error", { error: error instanceof Error ? error.message : String(error) });
          const isProduction = process.env.NODE_ENV === "production";
          const message = isProduction
            ? "Internal server error"
            : error instanceof Error ? error.message : "internal error";
          res.status(500).json({
            code: "INTERNAL_ERROR",
            message,
          });
        }
      });

      const host = process.env.BIND_HOST?.trim() || "0.0.0.0";
      server.listen(port, host, callback);
    },
  };

  return app;
}
