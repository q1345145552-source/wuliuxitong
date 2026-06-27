/**
 * 简易内存级速率限制器。
 * 生产环境建议替换为 Redis 实现（利用 REDIS_URL 环境变量）。
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// 每 60 秒清理一次过期条目
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.resetAt) store.delete(key);
  }
}, 60_000).unref();

/**
 * 检查是否超过速率限制。
 * @returns true 表示被限制，false 表示允许放行。
 */
export function checkRateLimit(
  key: string,
  maxRequests: number = 10,
  windowMs: number = 60_000,
): boolean {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return false; // 放行
  }

  entry.count++;
  if (entry.count > maxRequests) {
    return true; // 限流
  }

  return false;
}

/**
 * 根据 IP 和路径生成限流键。
 */
export function rateLimitKey(ip: string, path: string): string {
  return `${ip}::${path}`;
}

/**
 * 从请求头中提取客户端 IP。
 */
export function getClientIp(headers: NodeJS.Dict<string | string[]>): string {
  const forwarded = headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  if (Array.isArray(forwarded)) return forwarded[0]?.trim() || "unknown";
  const realIp = headers["x-real-ip"];
  if (typeof realIp === "string") return realIp.trim();
  return "unknown";
}
