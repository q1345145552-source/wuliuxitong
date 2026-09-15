/* ==========================================================================
   代理品牌 · 纯逻辑（2026-09-16，B4）。不碰 React、不碰浏览器，服务端组件和自测脚本都能直接 import。
   需求：确认单 5.1-5.4、5.7。
   ========================================================================== */

/** 登录前公开接口 GET /auth/brand 回的东西：只有名字和 logo */
export interface PublicBrandInfo {
  name: string;
  logoUrl: string | null;
}

/** 登录后 GET /client/brand、/agent/brand 回的东西 */
export interface SessionBrandInfo extends PublicBrandInfo {
  /** 代理的前缀登录页（/<slug>），没设前缀为 null */
  loginPath: string | null;
}

/**
 * 工作台外壳要的品牌（RoleShell 读）。类型定义跟 useWorkbenchBrand.ts 导出的那个是同一个（那边 re-export）。
 */
export interface WorkbenchBrand {
  name: string;
  caption?: string;
  logoUrl?: string;
  hiddenMenuIds: string[];
  labelOverrides: Record<string, string>;
}

/**
 * 代理的客户：藏普通版「集货拼柜」（4.1 / 5.7），「主页与AI」改叫「主页」（AI 不给用，3.6 / 5.7）。
 * 「整柜询价」「集货拼柜(仓库版)」照常（5.6 / 5.8）。
 * ⚠️ id 必须跟 menu-config.ts 对得上，自测脚本会逐个核（改菜单 id 时这里跟着改）。
 */
export const AGENT_CLIENT_HIDDEN_MENU_IDS = ["client-func-consolidation"] as const;
export const AGENT_CLIENT_LABEL_OVERRIDES: Readonly<Record<string, string>> = { "client-func-main": "主页" };

/**
 * 代理登录页 / 开户说明页左半边：不带任何公司标志的纯色渐变。
 * 湘泰那张背景图（globals.css .auth-visual 的 login-bg.jpg）船身印着 XT 标和「CN-TH LOGISTICS」，代理页不能用（5.4）。
 */
export const AGENT_VISUAL_STYLE = { backgroundImage: "linear-gradient(160deg, #2b3a55 0%, #16202f 100%)" } as const;

/** 前缀规则跟后端 branding/routes.ts、代理管理开代理时的校验一致 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const LOGO_RE = /^\/images\/[A-Za-z0-9_.-]+$/;

export function normalizeBrandSlug(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const slug = raw.trim().toLowerCase();
  return SLUG_RE.test(slug) ? slug : null;
}

/** 同后端：去端口、转小写、去末尾点；IP / localhost / 不像域名 → null（湘泰用 IP 访问时不查品牌） */
export function normalizeBrandHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let host = raw.split(",")[0]!.trim().toLowerCase();
  if (!host || host.startsWith("[")) return null;
  host = host.replace(/:\d+$/, "").replace(/\.$/, "");
  if (host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  return HOST_RE.test(host) ? host : null;
}

/** 接口回来的东西不可信（类型是手写的，CLAUDE.md #22），逐个字段核一遍再用 */
export function parsePublicBrand(raw: unknown): PublicBrandInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) return null;
  const logoUrl = typeof r.logoUrl === "string" && LOGO_RE.test(r.logoUrl) ? r.logoUrl : null;
  return { name, logoUrl };
}

export function parseSessionBrand(raw: unknown): SessionBrandInfo | null {
  const base = parsePublicBrand(raw);
  if (!base) return null;
  const loginPath = (raw as Record<string, unknown>).loginPath;
  const slug = typeof loginPath === "string" && loginPath.startsWith("/") ? normalizeBrandSlug(loginPath.slice(1)) : null;
  return { ...base, loginPath: slug ? `/${slug}` : null };
}

/**
 * 登录接口 POST /auth/login 成功时顺带回的品牌 → 登录页要不要、要怎么写品牌缓存（2026-09-16 第 1 轮审查后加固）。
 * · { known: true, brand } ：服务端说了算，照写（brand 为 null = 湘泰的）
 * · { known: false }       ：不知道（没回这个字段 = 服务端查品牌出错；或回的东西不合格式）→ 不写缓存，照旧等 /client/brand
 * 规则：
 * · 管理员 / 员工：永远湘泰（null），不管接口回了什么
 * · 客户：null = 湘泰客户；对象 = 代理的客户
 * · 代理本人：只认对象；回 null 是脏数据（代理行没了），当不知道处理，外壳左上角先空着，别写成湘泰
 * ⚠️ 只看登录接口的回包，**不看是从哪个登录页登进来的**（5.3）：
 *    以前从代理登录页登录会先按登录页的品牌猜，湘泰客户在代理登录页登录首帧就闪代理名字。
 */
export type LoginBrandDecision = { known: false } | { known: true; brand: SessionBrandInfo | null };

export function readLoginBrand(result: unknown): LoginBrandDecision {
  if (!result || typeof result !== "object" || !Object.prototype.hasOwnProperty.call(result, "brand")) return { known: false };
  const r = result as { user?: { role?: unknown }; brand?: unknown };
  const role = r.user?.role;
  if (role !== "client" && role !== "agent") return { known: true, brand: null };
  if (r.brand === null) return role === "client" ? { known: true, brand: null } : { known: false };
  const brand = parseSessionBrand(r.brand);
  return brand ? { known: true, brand } : { known: false };
}

/**
 * 登录身份 + 接口回的品牌 → 外壳要的品牌。
 * 管理员 / 员工永远 null（湘泰自己的样子）；没品牌也是 null。
 */
export function toWorkbenchBrand(role: string | null | undefined, info: PublicBrandInfo | null | undefined): WorkbenchBrand | null {
  if (!info || (role !== "client" && role !== "agent")) return null;
  const base = { name: info.name, ...(info.logoUrl ? { logoUrl: info.logoUrl } : {}) };
  if (role === "agent") return { ...base, hiddenMenuIds: [], labelOverrides: {} };
  return { ...base, hiddenMenuIds: [...AGENT_CLIENT_HIDDEN_MENU_IDS], labelOverrides: { ...AGENT_CLIENT_LABEL_OVERRIDES } };
}

/**
 * 代理没传 logo 时的标签页图标：名字第一个字画在圆底上（SVG data 地址，CSP 的 img-src 放行 data:）。
 * ⚠️ 不能留着湘泰的图标 —— 5.2 标签页上要是代理的。
 */
export function letterIconDataUri(name: string): string {
  const first = Array.from(name.trim())[0] ?? "·";
  const escaped = first.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#1f2a44"/><text x="32" y="43" font-size="34" text-anchor="middle" fill="#ffffff" font-family="sans-serif">${escaped}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** 标签页图标：有 logo 用 logo，没有用首字图标 */
export function brandIconHref(info: PublicBrandInfo): string {
  return info.logoUrl ?? letterIconDataUri(info.name);
}

/**
 * 「最近一次在工作台里的是哪个代理的账号」记在这个 cookie 里（值 = 前缀）。
 * 用途只有一个：代理的客户退出登录 / 登录过期被送到 /login 时，服务端直接转去代理自己的登录页，
 * 不让他看到湘泰的登录页（5.1）。湘泰账号进工作台就清掉，所以湘泰自己的电脑上永远没有它。
 * ⚠️ 值只认前缀格式，拼跳转地址前必须过 normalizeBrandSlug（防 //evil.com 这类跳出站外）。
 */
export const BRAND_LOGIN_COOKIE = "xt_brand_login";

/** /login 服务端：cookie 里的前缀 → 要转去的地址；不合规返回 null（照常显示湘泰登录页） */
export function brandLoginRedirectPath(cookieValue: string | null | undefined, search: string): string | null {
  const slug = normalizeBrandSlug(cookieValue ?? "");
  if (!slug) return null;
  const query = search && search.startsWith("?") ? search : "";
  return `/${slug}${query}`;
}
