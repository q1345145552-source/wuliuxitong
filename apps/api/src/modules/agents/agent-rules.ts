/* ==========================================================================
   代理管理 + 返现单的纯规则（2026-09-16，B2）
   --------------------------------------------------------------------------
   需求编号见 docs/交接文档-附件-代理账号确认单/final.md（该目录不进 git）。
   这里全是纯函数，不碰数据库 —— 前缀校验、域名校验、北京时间月份边界、
   「这一轮该出哪几个月的返现单」都在这儿，scripts/test-agent-admin.ts 和
   scripts/test-agent-rebates.ts 直接 import 真代码测，不自己抄一份规则。
   ========================================================================== */

/* ────────────────────────── 后缀（5.1 / 5.5；老叫法「前缀」） ────────────────────────── */

/**
 * ⚠️ 2026-09-19 老板定：**给用户看的字一律写「后缀」**（原话「应该不叫前缀，叫后缀。改一下，不然很容易误导」）——
 *    这东西加在网址**末尾**（xianlianth.com/<后缀>），叫「前缀」会误导。
 *    代码里的标识符（slug、validateAgentSlug、RESERVED_AGENT_SLUGS）和内部注释照旧，不做大范围改名；
 *    但凡是要显示给人看的字符串（页面标签、保存失败的报错）必须写「后缀」。
 */

export const AGENT_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

/**
 * 前缀保留字：代理登录链接是「网址/<前缀>」，前缀不能跟现有页面、接口转发、静态文件撞车。
 *
 * ⚠️ 2026-09-16 按下面几处逐个核过，**以后加了新的顶层页面/转发前缀要回来补**：
 *   · apps/web/src/app 顶层：admin agent client staff login register forbidden
 *     （还有 page.tsx 根页、error/loading/not-found 这些 Next 约定文件）
 *   · 同目录的静态文件：favicon.ico icon.png apple-icon.png
 *   · apps/web/public：images templates
 *   · apps/web/next.config.ts rewrites：auth admin staff client agent images
 *   · Next 自己的：_next（正则本来就不许下划线开头，照样列上）、api
 *   · B4 退路：若 app/[agentSlug] 跟现有路由冲突就改用 /a/<slug>，所以 a 也保留
 * scripts/test-agent-admin.ts 会扫 app 目录顶层和 next.config.ts 的 rewrites，
 * 有没列进来的直接变红 —— 不靠人记。
 */
export const RESERVED_AGENT_SLUGS: ReadonlySet<string> = new Set([
  // 现有页面 / 转发前缀
  "admin", "staff", "client", "agent", "login", "register", "forbidden", "auth", "images", "templates",
  // Next / 静态文件
  "_next", "api", "static", "public", "assets", "favicon", "favicon.ico", "icon", "icon.png",
  "apple-icon", "apple-icon.png", "robots", "robots.txt", "sitemap", "sitemap.xml", "manifest",
  "error", "loading", "not-found", "404", "500",
  // B4 的 /a/<slug> 退路、以后可能加的公共入口
  "a", "brand", "health", "logout", "track", "home", "index", "www", "mail", "xiangtai",
  "agents", "rebates", "null", "undefined",
]);

/** 前缀规整：去空格、转小写。空串返回 null（= 不设前缀） */
export function normalizeAgentSlug(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  return s === "" ? null : s;
}

/** 校验前缀（已规整过的）。null = 不设前缀，合法。返回给人看的原因，没问题返回 null */
export function validateAgentSlug(slug: string | null): string | null {
  if (slug === null) return null;
  if (!AGENT_SLUG_RE.test(slug)) {
    return "后缀只能用小写字母、数字和横杠，2 到 31 位，开头不能是横杠";
  }
  if (RESERVED_AGENT_SLUGS.has(slug)) return `「${slug}」是系统保留的，换一个后缀`;
  return null;
}

/* ────────────────────────── 专属域名（5.5） ────────────────────────── */

const HOSTNAME_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * 域名规整：去空格、转小写，顺手去掉超管复制时常带的 http(s):// 和结尾的 /。
 * 空串返回 null（= 不配专属域名）。
 */
export function normalizeAgentDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return s === "" ? null : s;
}

export function validateAgentDomain(domain: string | null): string | null {
  if (domain === null) return null;
  if (!HOSTNAME_RE.test(domain)) return "专属域名格式不对，只填域名本身，例如 wuliu.example.com";
  return null;
}

/* ────────────────────────── logo ────────────────────────── */

/** logo 登录前就要显示，走公开的 /images。只收位图：svg 里能塞脚本，不收 */
export const AGENT_LOGO_MIMES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const AGENT_LOGO_MAX_BYTES = 2 * 1024 * 1024;

export function validateAgentLogo(logo: { mime?: unknown; base64?: unknown } | null | undefined): string | null {
  if (!logo) return null;
  if (typeof logo.mime !== "string" || !AGENT_LOGO_MIMES.has(logo.mime)) return "logo 只支持 PNG、JPG、WEBP、GIF 图片";
  if (typeof logo.base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(logo.base64)) return "logo 图片内容读不出来，请重新选择";
  // base64 每 4 个字符 3 个字节
  const bytes = Math.floor((logo.base64.length * 3) / 4);
  if (bytes > AGENT_LOGO_MAX_BYTES) return "logo 图片太大了（最大 2MB）";
  return null;
}

/* ────────────────────────── 登录账号 ────────────────────────── */

/** 代理登录号就是 users.id（登录框里填的那个）。不许空格，免得登录时对不上 */
export function validateAgentLoginId(loginId: string): string | null {
  if (!loginId) return "请填登录账号";
  if (!/^[A-Za-z0-9_.@-]{3,40}$/.test(loginId)) return "登录账号只能用字母、数字和 _ . @ -，3 到 40 位";
  return null;
}

/* ────────────────────────── 月份边界（4.13） ────────────────────────── */

/**
 * ⚠️ 返现单的「一个月」按**北京时间**切（UTC+8，中国不实行夏令时，偏移固定）。
 *
 * 口径跟系统里已有的保持一致（2026-09-16 核过）：
 *   · exchange-rate/rate-sync.ts 按「UTC+8 北京时间 0 点」排定时任务；
 *   · admin/routes.ts 看板的「今天」按 UTC+8 算（CHINA_OFFSET_MS）；
 *   · 页面上的时间一律 formatBeijingTime（timeZone: "Asia/Shanghai"）显示。
 * 所以员工在北京时间 10 月 1 日 00:30 点的「泰国签收」算 10 月，哪怕 UTC 还是 9 月 30 日。
 * 服务器容器跑在 UTC，**不许**用 getMonth()/setDate() 这种按进程时区算的写法。
 */
export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isValidMonth(month: string): boolean {
  return MONTH_RE.test(month);
}

/** 这个时刻在北京时间属于哪个月，'YYYY-MM' */
export function beijingMonthOf(date: Date): string {
  const d = new Date(date.getTime() + BEIJING_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** 北京时间这个月 1 号 00:00 对应的真实时刻 */
export function beijingMonthStart(month: string): Date {
  const m = MONTH_RE.exec(month);
  if (!m) throw new Error(`月份格式不对：${month}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1) - BEIJING_OFFSET_MS);
}

/** 北京时间下个月 1 号 00:00 对应的真实时刻（这个月的「结束」，左闭右开） */
export function beijingMonthEnd(month: string): Date {
  return beijingMonthStart(addMonths(month, 1));
}

export function addMonths(month: string, n: number): string {
  const m = MONTH_RE.exec(month);
  if (!m) throw new Error(`月份格式不对：${month}`);
  const idx = Number(m[1]) * 12 + (Number(m[2]) - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/** 已经过完的最后一个月：北京时间现在是 10 月 1 日 00:00 起，就是 9 月 */
export function lastCompletedMonth(now: Date): string {
  return addMonths(beijingMonthOf(now), -1);
}

/* ────────────────────────── 这一轮出哪几张单 ────────────────────────── */

export interface RebateCandidate {
  id: string;
  thailandReceivedAt: Date;
}

/**
 * 给一个代理排「这一轮要出哪几个月的单、每张单装哪几票」。纯函数。
 *
 * @param pool 这个代理**还没进过任何返现单**的已泰国签收、付款快照归这个代理的预报单
 * @param existingMonths 这个代理已经出过单的月份
 * @param now 现在
 *
 * 规则（4.11 / 4.13）：
 *  · 只出「已经过完」的月份（北京时间），当月的不出；
 *  · 从池子里最早那票的月份开始，逐月往后排到「已过完的最后一个月」；
 *  · 某月已经出过单 → 跳过（出了就不改）；
 *  · 某月没出过单 → 装入池子里所有「泰国签收时间早于这个月结束」的票；一票都没有就不出空单。
 *
 * ⚠️ 为什么是「早于这个月结束」而不是「落在这个月」：
 *   员工 9 月 30 日 23:59:59 点签收，那个事务要是恰好在 10 月 1 日 00:00 出单之后才提交，
 *   签收时间落在 9 月、9 月的单却已经出了。按「落在该月」这票就**永远进不了任何单**，
 *   代理少拿钱。按现在的写法它会进下一张还没出的单（通常就是 10 月），
 *   明细里泰国签收时间照实写 9 月 30 日，对账看得见 —— 跟 4.13「之后补的算进下个月」同一个意思。
 *   正常情况（员工 10 月才补点 9 月到的货）签收时间本来就是 10 月，自然进 10 月。
 */
export function planAgentStatements<T extends RebateCandidate>(
  pool: readonly T[],
  existingMonths: ReadonlySet<string>,
  now: Date,
): Array<{ month: string; items: T[] }> {
  if (pool.length === 0) return [];
  const last = lastCompletedMonth(now);
  const remaining = [...pool].sort(
    (a, b) => a.thailandReceivedAt.getTime() - b.thailandReceivedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const first = beijingMonthOf(remaining[0].thailandReceivedAt);
  const out: Array<{ month: string; items: T[] }> = [];
  for (let month = first; month <= last && remaining.length > 0; month = addMonths(month, 1)) {
    if (existingMonths.has(month)) continue;
    const end = beijingMonthEnd(month).getTime();
    const items: T[] = [];
    while (remaining.length > 0 && remaining[0].thailandReceivedAt.getTime() < end) {
      items.push(remaining.shift()!);
    }
    if (items.length > 0) out.push({ month, items });
  }
  return out;
}

/* ────────────────────────── 金额小工具 ────────────────────────── */

/** 元 → 分（整数），避免浮点累加差一分 */
export function toCents(value: unknown): number {
  const n = typeof value === "number" ? value : Number(String(value ?? 0));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** 方 → 千分之一方（整数），返现单方数是 3 位小数 */
export function toMilliM3(value: unknown): number {
  const n = typeof value === "number" ? value : Number(String(value ?? 0));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000);
}
