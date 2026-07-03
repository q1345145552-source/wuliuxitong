import { getOptionalSession } from "../auth/auth-session";

/**
 * 统一去除 URL 末尾斜杠，避免拼接路径时出现双斜杠。
 */
function trimTrailingSlash(url: string): string {
  return url.replace(/\/$/, "");
}

/**
 * 判断 API 地址是否仍是本地回环地址（localhost/127.0.0.1）。
 */
function isLoopbackApiUrl(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(url);
}

/**
 * 在 Render 域名下从当前前端域名推断后端域名。
 * 例如：xtwlwz-web.onrender.com -> xtwlwz.onrender.com
 */
function inferRenderApiUrlFromWindow(): string | null {
  if (typeof window === "undefined") return null;
  const hostname = window.location.hostname;
  if (!hostname.endsWith(".onrender.com")) return null;
  if (!hostname.includes("-web.")) return null;
  return `https://${hostname.replace("-web.", ".")}`;
}

/**
 * 计算前端请求 API 的基础地址。
 * 优先使用 NEXT_PUBLIC_API_BASE_URL；若该值错误地指向本地地址且当前在 Render 上，
 * 则自动按域名推断线上 API 地址，避免线上请求 127.0.0.1。
 */
export function apiBaseUrl(): string {
  // 浏览器端用相对路径，走 Next.js rewrites 代理到 API
  if (typeof window !== "undefined") return "";
  const configured = (process.env.NEXT_PUBLIC_API_BASE_URL ?? process.env.VITE_API_BASE_URL ?? "http://localhost:3001").trim();
  const inferredRenderApiUrl = inferRenderApiUrlFromWindow();
  if (inferredRenderApiUrl && isLoopbackApiUrl(configured)) {
    return trimTrailingSlash(inferredRenderApiUrl);
  }
  return trimTrailingSlash(configured);
}

/**
 * 生成需要鉴权的请求头。
 */
export function authHeaders(): Record<string, string> {
  const session = getOptionalSession();
  if (!session || !session.token) {
    return {};
  }
  return {
    Authorization: `Bearer ${session.token}`,
  };
}

/**
 * 统一解析后端响应并在失败时抛出可读错误。
 * 401 自动跳转登录页。
 */
export async function parseApiResponse<T>(response: Response): Promise<T> {
  if (response.status === 401) {
    // token 过期或未登录，跳转登录页
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      window.location.href = "/login?expired=1";
    }
    throw new Error("登录已过期，请重新登录");
  }
  const text = await response.text();
  let payload: { code?: string; message?: string; data?: T } | null = null;
  try {
    payload = text ? (JSON.parse(text) as { code?: string; message?: string; data?: T }) : null;
  } catch {
    if (!response.ok) throw new Error(`请求失败 ${response.status}${text ? `: ${text.slice(0, 150)}` : ""}`);
    throw new Error("invalid response");
  }
  if (!response.ok || payload?.code !== "OK") {
    throw new Error(payload?.message ?? "request failed");
  }
  return payload.data as T;
}

/**
 * 统一 API 请求：fetch + 超时 + 429重试 + parseApiResponse + 错误兜底。
 * 所有 API 调用必须使用此包装，禁止裸调 fetch。
 */
export async function apiRequest<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000); // 30秒超时

  let lastError: Error | null = null;
  // 429 限流自动重试最多 2 次，间隔 2s / 4s
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          ...authHeaders(),
          ...(options.headers as Record<string, string> || {}),
        },
      });

      // 429 限流 → 等待后重试
      if (response.status === 429 && attempt < 2) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
        continue;
      }

      // 5xx 服务器错误 → 友好提示
      if (response.status >= 500) {
        throw new Error("服务器繁忙，请稍后重试");
      }

      clearTimeout(timeout);
      return parseApiResponse<T>(response);
    } catch (e: any) {
      lastError = e;
      // 超时
      if (e.name === "AbortError") {
        lastError = new Error("请求超时，请检查网络后重试");
        break;
      }
      // 网络断开
      if (e instanceof TypeError && (e.message.includes("fetch") || e.message.includes("network"))) {
        lastError = new Error("网络连接异常，请检查网络后重试");
        break;
      }
      // 429 重试中不抛
      if (attempt < 2) continue;
      break;
    }
  }

  clearTimeout(timeout);
  throw lastError || new Error("请求失败");
}
