"use client";

import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { WORKBENCH_BRAND_CACHE_KEY, getOptionalSession, type AuthSession } from "../../auth/auth-session";
import { apiBaseUrl, apiRequest } from "../../services/core-api";
import {
  BRAND_LOGIN_COOKIE,
  buildBrandCacheRecord,
  normalizeBrandSlug,
  parseSessionBrand,
  readLoginBrand,
  toWorkbenchBrand,
  type SessionBrandInfo,
  type WorkbenchBrand,
} from "./brand-core";
import { applyDocumentBrand } from "./document-brand";

export type { WorkbenchBrand } from "./brand-core";

/* ==========================================================================
   登录后的代理品牌（2026-09-16，B4）
   --------------------------------------------------------------------------
   · 代理的客户 → 左上角代理名字 / logo、藏普通版「集货拼柜」、「主页与AI」改叫「主页」、标签页标题图标换成代理的
   · 代理本人 → 左上角代理名字、标签页标题图标
   · 湘泰账号（管理员、员工、湘泰自己的客户）→ null，一切照旧
   不管从哪个网址登进来都一样（5.3）：看的是账号归属，不是登录页。

   数据：客户调 GET /client/brand，代理调 GET /agent/brand（代理令牌碰不了 /client/*）。
   同一个页面里外壳和业务页都要用，所以在模块里存一份、一个账号只查一次。

   为什么要在浏览器里记一份（localStorage，按账号记）：
   整页刷新时接口回来之前那一小会儿不知道是谁的品牌。湘泰客户按「湘泰」画（跟以前一模一样）；
   代理的客户如果每次刷新都先闪一下「湘泰物流」，等于每次都告诉他背后是湘泰。
   所以查到一次就记下，下次首帧直接用；**登录那一刻**按登录接口回的品牌先记上（不管从哪张登录页登进来）。
   记的只有名字、logo 地址、前缀，都是登录页上本来就公开的东西。
   缓存只认同一个账号（userId 对不上一律当没有）；退出登录时 clearAuthSession 一并清掉。
   ========================================================================== */

const CACHE_KEY = WORKBENCH_BRAND_CACHE_KEY;

/** 一个账号的品牌：SessionBrandInfo = 代理的，null = 湘泰的，undefined = 还不知道 */
type BrandState = SessionBrandInfo | null | undefined;

const known = new Map<string, SessionBrandInfo | null>();
const cacheChecked = new Set<string>();
const loaded = new Set<string>();
/** 正在查的那一次：外壳和受限页同一时刻都要查时共用一个请求 */
const inflight = new Map<string, Promise<SessionBrandInfo | null>>();
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function readCache(userId: string): SessionBrandInfo | null | undefined {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { userId?: unknown; brand?: unknown };
    if (parsed?.userId !== userId) return undefined;
    return parsed.brand === null ? null : parseSessionBrand(parsed.brand) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeCache(userId: string, brand: SessionBrandInfo | null): void {
  try {
    // 连同算好的标签页图标地址一起存：整页打开时 <head> 里的内联脚本直接用（early-tab-brand.ts）
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(buildBrandCacheRecord(userId, brand)));
  } catch {
    /* 隐私模式记不住就算了：最多刷新时闪一下 */
  }
}

/** 退出 / 过期被送到 /login 时，服务端靠这个 cookie 转去代理自己的登录页（见 brand-core.ts） */
function syncLoginCookie(brand: SessionBrandInfo | null): void {
  try {
    const slug = brand?.loginPath ? normalizeBrandSlug(brand.loginPath.slice(1)) : null;
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    if (slug) {
      document.cookie = `${BRAND_LOGIN_COOKIE}=${slug}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
    } else if (document.cookie.split("; ").some((c) => c.startsWith(`${BRAND_LOGIN_COOKIE}=`))) {
      document.cookie = `${BRAND_LOGIN_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
    }
  } catch {
    /* cookie 写不进就算了：退出后看到的是湘泰登录页，登录照常 */
  }
}

function peek(userId: string | null, role: string | null): BrandState {
  if (!userId || !role) return null;
  if (role !== "client" && role !== "agent") return null;
  if (known.has(userId)) return known.get(userId);
  if (!cacheChecked.has(userId)) {
    cacheChecked.add(userId);
    const cached = readCache(userId);
    if (cached !== undefined) known.set(userId, cached);
    return cached;
  }
  return undefined;
}

/**
 * 向服务端现查一次这个账号的品牌，**不认缓存**；同一时刻已经有一次在查就跟它共用。
 * 查到了顺手记进模块、写缓存、同步登录页 cookie、通知外壳（左上角和菜单跟着变）；查不到原样抛给调用方。
 */
export function fetchSessionBrand(userId: string, role: string): Promise<SessionBrandInfo | null> {
  const pending = inflight.get(userId);
  if (pending) return pending;
  const run = (async () => {
    const path = role === "agent" ? "/agent/brand" : "/client/brand";
    const data = await apiRequest<{ brand?: unknown }>(`${apiBaseUrl()}${path}`, { method: "GET" });
    const brand = parseSessionBrand(data?.brand);
    // 换账号会整页重载；这里再核一次，别把上一个账号的结果记到新账号头上
    if (getOptionalSession()?.userId !== userId) throw new Error("登录的账号已经换了，请刷新页面");
    known.set(userId, brand);
    writeCache(userId, brand);
    syncLoginCookie(brand);
    notify();
    return brand;
  })();
  inflight.set(userId, run);
  const settle = () => {
    if (inflight.get(userId) === run) inflight.delete(userId);
  };
  run.then(settle, settle);
  return run;
}

/** 外壳用：一个账号在这个标签页里查一次 */
function load(userId: string, role: string): void {
  if (loaded.has(userId)) return;
  loaded.add(userId);
  fetchSessionBrand(userId, role).catch(() => {
    // 查不到就维持现状（首帧用的缓存 / 湘泰的样子），下次整页打开再查
    loaded.delete(userId);
  });
}

/**
 * 登录成功那一刻、写会话和跳转之前调（LoginView）：按登录接口回的品牌写好缓存，进工作台第一帧就是对的。
 * 2026-09-16 第 1 轮审查后改：以前只在代理登录页按「登录页的品牌」猜，
 * ① 代理的客户从湘泰 /login 登录 → 没缓存，首帧闪「湘泰物流」、普通版集货、AI 问答；
 * ② 湘泰客户从代理登录页登录 → 先按代理画，首帧闪代理名字。
 * 现在只认服务端算的（readLoginBrand），两个方向都不猜。
 * ⚠️ 服务端没回品牌（查品牌出错）→ 不写缓存；userId 不同的旧缓存 readCache 本来就不认，不会串到新账号头上。
 */
export function primeBrandAfterLogin(result: { user: { id: string; role: string }; brand?: unknown }): void {
  const decision = readLoginBrand(result);
  if (!decision.known) return;
  const role = result.user.role;
  if (role === "client" || role === "agent") {
    known.set(result.user.id, decision.brand);
    cacheChecked.add(result.user.id);
    writeCache(result.user.id, decision.brand);
  }
  // 湘泰账号：清掉「代理登录页」记忆；代理的：记上他自己的前缀（没前缀也清）
  syncLoginCookie(decision.brand);
}

/** 这个登录身份的品牌：对象 = 代理的，null = 湘泰的，undefined = 还在查且没有缓存 */
export function useSessionBrand(session: Pick<AuthSession, "userId" | "role"> | null): BrandState {
  const userId = session?.userId ?? null;
  const role = session?.role ?? null;
  const value = useSyncExternalStore(subscribe, () => peek(userId, role), () => null);
  useEffect(() => {
    if (!userId || !role) return;
    if (role === "client" || role === "agent") {
      void load(userId, role);
    } else {
      // 湘泰员工 / 管理员进了工作台：清掉「代理登录页」记忆，这台电脑上的 /login 恢复湘泰的
      syncLoginCookie(null);
    }
  }, [userId, role]);
  return value;
}

/** 业务页（客户首页、查国内快递）用：自己读登录信息。这些页面只在外壳核实会话之后才挂载，首帧就在浏览器里 */
export function useCurrentSessionBrand(): BrandState {
  const [session] = useState(() => getOptionalSession());
  return useSessionBrand(session);
}

/** 受限页进门时现查的结果：checking = 还在查；done = 查到了（brand 是对象 = 代理的客户，null = 湘泰的）；error = 没查到 */
export type VerifiedBrandState =
  | { status: "checking" }
  | { status: "done"; brand: SessionBrandInfo | null }
  | { status: "error"; message: string };

/**
 * 受限页（代理的客户不许用的页面，比如普通版集货）进门用：**每次打开这一页都向服务端现查一次，不认缓存**。
 * 2026-09-15 Codex 第二轮 P2-1 / P2-2，原来用 useCurrentSessionBrand：
 *  ① 查品牌那一下失败（服务器出错 / 断网 / 超时）页面就一直「加载中…」，没提示、没重试；
 *  ② 按账号记下的品牌一直用到整页刷新：客户在线被改归代理后，同一标签页前进后退还能进这一页；被解绑后又一直被送回主页。
 * 缓存只管首帧标题图标和左上角，不能拿来判断「能不能进这一页」。
 * 查不到就是 error（页面写明原因、给「重试」），**绝不当成湘泰客户放行**。
 */
export function useVerifiedSessionBrand(): { state: VerifiedBrandState; retry: () => void } {
  const [session] = useState(() => getOptionalSession());
  const userId = session?.userId ?? null;
  const role = session?.role ?? null;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<VerifiedBrandState>({ status: "checking" });
  useEffect(() => {
    if (!userId || !role || (role !== "client" && role !== "agent")) {
      // 湘泰员工 / 管理员没有代理品牌（跟 peek 同一口径）；没登录的由外壳送去登录页
      setState({ status: "done", brand: null });
      return;
    }
    let alive = true;
    setState((prev) => (prev.status === "checking" ? prev : { status: "checking" }));
    fetchSessionBrand(userId, role).then(
      (brand) => {
        if (alive) setState({ status: "done", brand });
      },
      (error: unknown) => {
        if (alive) setState({ status: "error", message: error instanceof Error && error.message ? error.message : "请求失败" });
      },
    );
    return () => {
      alive = false;
    };
  }, [userId, role, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}

/** 服务端渲染时 useLayoutEffect 不跑也会报警告；外壳首屏在服务端只画骨架，用普通 effect 顶上即可 */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** 代理的名字首帧还不知道时（代理本人、没缓存），左上角先空着，不显示「湘泰物流」 */
const AGENT_PENDING_BRAND: WorkbenchBrand = { name: "", hiddenMenuIds: [], labelOverrides: {} };

/**
 * 工作台外壳（RoleShell）左上角的品牌 + 菜单微调。
 * - name / caption：左上角大字和小字（湘泰自己是「湘泰物流 / XIANGTAI」）
 * - logoUrl：左上角 logo，可空
 * - hiddenMenuIds：要藏掉的菜单项 id（menu-config.ts 里的 id）
 * - labelOverrides：菜单项 id → 改成的名字
 * 湘泰账号一律 null。
 */
export function useWorkbenchBrand(session: AuthSession | null): WorkbenchBrand | null {
  const state = useSessionBrand(session);
  const role = session?.role ?? null;
  const userId = session?.userId ?? null;

  // 标签页标题图标在浏览器画出这一帧之前就换（layout effect），不先露一帧「湘泰物流网站」再改
  // ⚠️ 会话还没读到（水合那一帧 session 为 null）时不调：那时的 null 不是「这个账号是湘泰的」，
  //    调了会把 <head> 内联脚本按缓存换好的代理标题图标当场还原成湘泰的（early-tab-brand.ts）
  useIsomorphicLayoutEffect(() => {
    if (state === undefined || !userId) return;
    applyDocumentBrand(state ? { name: state.name, logoUrl: state.logoUrl } : null);
  }, [state, userId]);

  if (state === undefined) return role === "agent" ? AGENT_PENDING_BRAND : null;
  return toWorkbenchBrand(role, state);
}
