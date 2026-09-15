// ⚠️ 只许服务端组件 import（next/headers 在浏览器里用不了）。没用 "server-only" 包：本仓库没装它，不加依赖。
import { cookies, headers } from "next/headers";
import { normalizeBrandHost, normalizeBrandSlug, parsePublicBrand, type PublicBrandInfo } from "./brand-core";

/* ==========================================================================
   登录页（服务端组件）查代理品牌（2026-09-16，B4）。只在 Next 服务端跑。
   --------------------------------------------------------------------------
   · 前缀登录页 /<slug>：按前缀查
   · 专属域名：按请求的 Host 查（nginx 必须 proxy_set_header Host $host，见 scripts/nginx-agent-domain.sh）
   转发目标跟 next.config.ts 的 rewrites 同一个变量：线上 http://api:3001，本机 .env.local 里设。

   ⚠️ 接口挂了 / 超时 / 限流 → 当成没有品牌（显示湘泰登录页），登录本身照常能用，
      宁可代理的客户看到一次湘泰的登录页，也不能让所有人登录页打不开。
   ⚠️ 结果在进程里缓存 60 秒：登录页每次打开都查一次库没必要；改了代理名字最多 1 分钟后生效。
   ========================================================================== */

const API_PROXY_TARGET = (process.env.API_PROXY_TARGET?.trim() || "http://api:3001").replace(/\/$/, "");
const TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 500;

const cache = new Map<string, { at: number; brand: PublicBrandInfo | null }>();

async function fetchBrand(param: "slug" | "host", value: string, realIp: string | null): Promise<PublicBrandInfo | null> {
  const key = `${param}:${value}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.brand;
  let brand: PublicBrandInfo | null = null;
  let cacheable = false;
  try {
    const res = await fetch(`${API_PROXY_TARGET}/auth/brand?${param}=${encodeURIComponent(value)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // 限流按真实访客 IP 算（不带的话所有人都是 web 容器那一个 IP）
      headers: realIp ? { "X-Real-IP": realIp } : {},
    });
    if (res.ok) {
      const body = (await res.json()) as { data?: { brand?: unknown } };
      brand = parsePublicBrand(body?.data?.brand);
      cacheable = true;
    }
  } catch {
    // 接口挂了 / 超时：不缓存，下次再试
  }
  if (cacheable) {
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, { at: Date.now(), brand });
  }
  return brand;
}

async function requestRealIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-real-ip")?.trim() || null;
}

/** 前缀登录页用。前缀不合规直接 null，不去打接口 */
export async function getBrandBySlug(rawSlug: string): Promise<PublicBrandInfo | null> {
  const slug = normalizeBrandSlug(rawSlug);
  if (!slug) return null;
  return fetchBrand("slug", slug, await requestRealIp());
}

/** 专属域名：/login、/register 用。IP / localhost 直接 null（湘泰自己访问不查） */
export async function getBrandByRequestHost(): Promise<PublicBrandInfo | null> {
  const h = await headers();
  const host = normalizeBrandHost(h.get("x-forwarded-host") ?? h.get("host"));
  if (!host) return null;
  return fetchBrand("host", host, h.get("x-real-ip")?.trim() || null);
}

/** 读「上次在工作台里的是哪个代理的账号」cookie（见 brand-core.ts BRAND_LOGIN_COOKIE） */
export async function readBrandLoginCookie(name: string): Promise<string | null> {
  const jar = await cookies();
  return jar.get(name)?.value ?? null;
}
