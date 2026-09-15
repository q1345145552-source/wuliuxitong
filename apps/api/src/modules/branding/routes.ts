import type { HttpRequest, MinimalHttpApp } from "../../server";
import { prisma } from "../../db/prisma";
import { fail, ok, requireRole } from "../core/http-utils";
import { requireAgent } from "../core/agent-scope";
import { checkRateLimit, getClientIp, rateLimitKey } from "../core/rate-limit";

/* ==========================================================================
   代理品牌接口（2026-09-16，B4）
   --------------------------------------------------------------------------
   需求：确认单 5.1-5.3（代理的客户看到代理的名字和 logo，湘泰自己的一切照旧）。
   · GET /auth/brand?slug=&host=  公开（登录前就要用）：只回 { name, logoUrl }
   · GET /client/brand            客户登录后：归代理的回代理名字 / logo / 前缀登录地址，湘泰客户回 null
   · GET /agent/brand             代理本人登录后：同上（代理令牌碰不了 /client/*，统一闸挡着）

   ⚠️ 给外面看的字段一律**明确列出**（CLAUDE.md #31），绝不 `...agent`：
      agents 表里还有三档代理价、专属域名、公司 id，登录前的公开接口一个都不许带出去。
   ⚠️ 查不到、格式不对、限流，公开接口一律回 { brand: null }（= 湘泰），
      不区分「没有这个前缀」和「前缀写错了」，也不报 404 —— 登录页照常能用。
   ========================================================================== */

/** 前缀规则跟代理管理（B2）开代理时的校验一致：小写字母数字开头，2-31 位，只含小写字母数字和 - */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
/** 域名：每段字母数字和 -，至少两段，总长 ≤ 253 */
const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** logo 只认本系统图片落盘的地址（saveImageToDisk 返回 /images/<文件名>），别的一律不给前端，免得变成任意外链 */
const LOGO_RE = /^\/images\/[A-Za-z0-9_.-]+$/;

/** 公开接口每个 IP 每分钟最多查几次。正常一次登录页打开只查 1 次（Next 服务端还缓存 60 秒） */
const PUBLIC_BRAND_RATE_LIMIT = 120;

export interface PublicBrand {
  name: string;
  logoUrl: string | null;
}

export interface SessionBrand extends PublicBrand {
  /** 前缀登录页地址（/<slug>）；代理没设前缀为 null。退出登录后送回代理自己的登录页用 */
  loginPath: string | null;
}

/** 前缀：去空格转小写，不合规则返回 null（不去查库） */
export function normalizeBrandSlug(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const slug = raw.trim().toLowerCase();
  return SLUG_RE.test(slug) ? slug : null;
}

/**
 * 域名：去空格、转小写、去端口、去末尾的点。
 * IP、localhost、不像域名的一律 null —— 湘泰自己用 IP 访问的时候不去查库。
 */
export function normalizeBrandHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // x-forwarded-host 可能是「a.com, b.com」，只认第一个
  let host = raw.split(",")[0]!.trim().toLowerCase();
  if (!host || host.startsWith("[")) return null; // IPv6
  host = host.replace(/:\d+$/, "").replace(/\.$/, "");
  if (host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  return HOST_RE.test(host) ? host : null;
}

export function toLogoUrl(logoPath: string | null | undefined): string | null {
  return typeof logoPath === "string" && LOGO_RE.test(logoPath) ? logoPath : null;
}

/** 公开品牌：只有名字和 logo */
function toPublicBrand(row: { name: string; logoPath: string | null }): PublicBrand {
  return { name: row.name, logoUrl: toLogoUrl(row.logoPath) };
}

/**
 * 按前缀或专属域名找代理。前缀优先（前缀登录页明确带着前缀）。
 * select 只拿要用的列，价格那几列压根不读出来。
 */
export async function findPublicBrand(query: { slug?: unknown; host?: unknown }): Promise<PublicBrand | null> {
  const slug = normalizeBrandSlug(query.slug);
  if (slug) {
    const row = await prisma.agent.findUnique({ where: { slug }, select: { name: true, logoPath: true } });
    return row ? toPublicBrand(row) : null;
  }
  const host = normalizeBrandHost(query.host);
  if (host) {
    const row = await prisma.agent.findUnique({ where: { customDomain: host }, select: { name: true, logoPath: true } });
    return row ? toPublicBrand(row) : null;
  }
  return null;
}

/**
 * 登录后的品牌：按 session-guard 从库里现读的 agentId 找（改归属当场生效）。
 * ⚠️ agentId 为空直接 null，不许拿 undefined 去查（CLAUDE.md #27）；同时卡公司。
 */
export async function findSessionBrand(auth: Pick<NonNullable<HttpRequest["auth"]>, "agentId" | "companyId">): Promise<SessionBrand | null> {
  if (!auth.agentId || !auth.companyId) return null;
  const row = await prisma.agent.findFirst({
    where: { id: auth.agentId, companyId: auth.companyId },
    select: { name: true, logoPath: true, slug: true },
  });
  if (!row) return null;
  return {
    name: row.name,
    logoUrl: toLogoUrl(row.logoPath),
    loginPath: row.slug && SLUG_RE.test(row.slug) ? `/${row.slug}` : null,
  };
}

export function registerBrandingRoutes(app: MinimalHttpApp): void {
  /**
   * 公开：登录页用。前端 Next 服务端渲染登录页时调（带上原请求的 X-Real-IP 方便限流）。
   * 只回 { brand: { name, logoUrl } | null }。
   */
  app.get("/auth/brand", async (req, res) => {
    const ip = getClientIp(req.headers);
    if (checkRateLimit(rateLimitKey(ip, "/auth/brand"), PUBLIC_BRAND_RATE_LIMIT, 60_000)) {
      // 限流也当「没有品牌」回：登录页照常显示，不给扫前缀的人任何区别
      ok(res, { brand: null });
      return;
    }
    const brand = await findPublicBrand({ slug: req.query.slug, host: req.query.host });
    ok(res, { brand: brand ? { name: brand.name, logoUrl: brand.logoUrl } : null });
  });

  /** 客户登录后：左上角、标签页标题图标、菜单要不要藏（前端 useWorkbenchBrand） */
  app.get("/client/brand", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const brand = await findSessionBrand(auth);
    ok(res, { brand: brand ? { name: brand.name, logoUrl: brand.logoUrl, loginPath: brand.loginPath } : null });
  });

  /** 代理本人登录后：左上角、标签页标题图标 */
  app.get("/agent/brand", async (req, res) => {
    const auth = requireAgent(req, res);
    if (!auth) return;
    const brand = await findSessionBrand(auth);
    if (!brand) {
      // 代理行查不到 = 脏数据（开代理是一个事务建 agents + users），跟 /agent/* 其它接口一样回 404
      fail(res, 404, "NOT_FOUND", "not found");
      return;
    }
    ok(res, { brand: { name: brand.name, logoUrl: brand.logoUrl, loginPath: brand.loginPath } });
  });
}
