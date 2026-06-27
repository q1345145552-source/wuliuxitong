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
    throw new Error("请先登录");
  }
  return {
    Authorization: `Bearer ${session.token}`,
  };
}

/**
 * 统一解析后端响应并在失败时抛出可读错误。
 */
export async function parseApiResponse<T>(response: Response): Promise<T> {
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
