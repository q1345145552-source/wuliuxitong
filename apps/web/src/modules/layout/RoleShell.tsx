"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { clearAuthSession, clearClientOrderCaches, getOptionalSession, type AuthRole, type AuthSession } from "../../auth/auth-session";
import { useWorkbenchBrand } from "../branding/useWorkbenchBrand";
import { changeOwnPassword } from "../../services/auth-api";
import { apiBaseUrl, apiRequest } from "../../services/core-api";
import { globalMenus, roleFunctionGroups, roleMenus, type MenuItem } from "./menu-config";
import { isSamePageHashLink, navigateToHash } from "./navigate-to-hash";
// 分组展开的默认值和记忆（代理单独一个键、默认展开「我的客户」，原因见该文件）
import { defaultExpandedGroups, initialExpandedGroups, saveExpandedGroups } from "./sidebar-expanded-groups";

const COLLAPSED_KEY = "xt_sidebar_collapsed";

/** 各角色的首页。登录后落地、错角色送回、换身份跳转都用这一张 */
const ROLE_HOME: Record<AuthRole, string> = { admin: "/admin", staff: "/staff", client: "/client", agent: "/agent" };
const ROLE_LABEL: Record<AuthRole, string> = { admin: "管理员", staff: "员工", client: "客户", agent: "代理" };

/**
 * 这个浏览器标签页里外壳是不是已经完整挂载过一次（2026-09-16 导航根治）。
 *
 * 外壳挂在根布局上以后，平常换页根本不会重新挂载；万一重新挂载（例如从非工作台路径客户端跳回来），
 * 第二次起首帧直接出完整外壳，不再画一屏骨架。
 * ⚠️ 第一次（服务端首屏 + 水合那一帧）必须照旧是骨架：服务端读不到登录信息，两边画的不一样会报水合错。
 * 模块变量只在浏览器里被改（写在 effect 里），服务端永远是 false。
 */
let shellMountedOnceInThisTab = false;

/**
 * 记住侧边栏是不是收起来的（只管电脑端；手机端一直是抽屉，见 globals.css 的 @media）。
 * 跟 sidebar-expanded-groups.ts 的读写一样包 try —— 记不住是小事，把整个工作台顶掉是大事。
 */
function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    /* 记不住就算了 */
  }
}

/** 已经挂载过一次才在首帧读浏览器（见 shellMountedOnceInThisTab），否则一律用服务端也能算出的默认值 */
function readOnRemount<T>(read: () => T, fallback: T): T {
  return shellMountedOnceInThisTab && typeof window !== "undefined" ? read() : fallback;
}

export default function RoleShell(props: {
  allowedRole: AuthRole | AuthRole[];
  title: string;
  children: ReactNode;
  /** 保留旧调用方的布局变体；三端视觉统一由 ledger-shell 管理。 */
  variant?: "default" | "a3";
}) {
  const { allowedRole, title, children, variant = "default" } = props;
  const allowedRoles = Array.isArray(allowedRole) ? allowedRole : [allowedRole];
  // 菜单高亮用的路径：外壳不随换页卸载，必须跟着 Next 的路由走，不能只在挂载时读一次
  const currentPath = usePathname() ?? "";
  const [mounted, setMounted] = useState(() => readOnRemount(() => true, false));
  const [session, setSession] = useState<AuthSession | null>(() => readOnRemount(getOptionalSession, null));
  const [identityChanging, setIdentityChanging] = useState(false);
  // 父业务页的查询/地址/图片状态不在 RoleShell 内，换身份必须重建整页。
  // 一次挂载绑定一次；暂时读到 null 或 Fast Refresh 时都不覆盖旧身份。
  const boundIdentityRef = useRef<string | null>(null);
  const identityReloadRef = useRef<AuthSession | null>(null);
  const acceptSession = useCallback((next: AuthSession | null) => {
    if (next) {
      const identity = JSON.stringify([next.userId, next.companyId, next.role]);
      if (boundIdentityRef.current && boundIdentityRef.current !== identity) {
        identityReloadRef.current = next;
        setIdentityChanging(true);
        return;
      }
      boundIdentityRef.current = identity;
    }
    setSession((prev) => {
      if (!next) return null;
      if (prev && prev.token === next.token && prev.userId === next.userId && prev.companyId === next.companyId && prev.role === next.role) return prev;
      return next;
    });
  }, []);

  useEffect(() => {
    const next = identityReloadRef.current;
    if (!identityChanging || !next) return;
    // 此 effect 在业务 children 已移出 DOM 后运行，不让旧客户数据留在新身份页面。
    if (allowedRoles.includes(next.role)) window.location.reload();
    else window.location.replace(ROLE_HOME[next.role] || "/login");
  }, [identityChanging, allowedRoles.join(",")]);
  const [currentHash, setCurrentHash] = useState(() => readOnRemount(() => window.location.hash, ""));
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobileNavigation, setMobileNavigation] = useState(() => readOnRemount(() => window.matchMedia("(max-width: 900px)").matches, false));
  const navigationId = useId();
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarTriggerRef = useRef<HTMLButtonElement>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    // 服务端首屏/水合那一帧读不到登录信息，也不许读 localStorage → 按「没角色、没记忆」给老默认值；
    // 挂载后下面的 effect 按真实角色重读
    () => readOnRemount(() => initialExpandedGroups(getOptionalSession()?.role), new Set(defaultExpandedGroups(null))),
  );
  /**
   * 电脑端把侧边栏整个收起来，把宽度让给表格（运单列表那些表很宽）。
   * ⚠️ 首次挂载初值必须是 false、进浏览器后再从 localStorage 读 ——
   * 服务端渲染读不到 localStorage，直接用它当初值两边对不上会报 hydration 错。
   */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readOnRemount(readCollapsed, false));
  const brand = useWorkbenchBrand(session);

  // 和 globals.css 的抽屉断点一致。窄屏收起的导航退出键盘顺序，桌面仍是正常导航。
  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const sync = () => {
      setMobileNavigation(media.matches);
      if (!media.matches) setSidebarOpen(false);
    };
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!mobileNavigation || !sidebarOpen || !sidebar) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const controls = () => Array.from(sidebar.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
    const focusFrame = window.requestAnimationFrame(() => controls()[0]?.focus({ preventScroll: true }));
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        setSidebarOpen(false);
      }
      if (event.key !== "Tab") return;
      const items = controls();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !sidebar.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !sidebar.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      // 点击导航/遮罩或 Escape 后回到开关；打开的其它弹窗会自行接管焦点。
      if (sidebarTriggerRef.current?.getClientRects().length) sidebarTriggerRef.current.focus({ preventScroll: true });
    };
  }, [mobileNavigation, sidebarOpen]);

  const toggleSidebarCollapsed = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      saveCollapsed(next);
      return next;
    });
  };

  // 修改密码（三端共用，管理员/员工/客户都是改自己的）
  const [pwdOpen, setPwdOpen] = useState(false);
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [pwdError, setPwdError] = useState("");
  const [pwdSubmitting, setPwdSubmitting] = useState(false);
  const [pwdDone, setPwdDone] = useState(false);
  // 打字时能不能看见自己输的内容。默认关，勾上才显示。
  const [showPwd, setShowPwd] = useState(false);

  const openPwdModal = () => {
    setOldPwd("");
    setNewPwd("");
    setConfirmPwd("");
    setPwdError("");
    setPwdDone(false);
    // 每次重新打开都回到「看不见」，免得上次勾了这次被人瞄到
    setShowPwd(false);
    setPwdOpen(true);
  };

  const submitPwd = async () => {
    if (pwdSubmitting) return;
    if (!oldPwd || !newPwd) {
      setPwdError("请把旧密码和新密码都填上");
      return;
    }
    if (newPwd.length < 8) {
      setPwdError("新密码至少 8 位");
      return;
    }
    if (newPwd !== confirmPwd) {
      setPwdError("两次输入的新密码不一样");
      return;
    }
    setPwdSubmitting(true);
    setPwdError("");
    try {
      await changeOwnPassword({ oldPassword: oldPwd, newPassword: newPwd });
      // 改完必须重新登录：2026-08-25 起后端会把改密码之前签发的令牌全部作废
      //（包括这个人在别的设备上登着的），留着也用不了。
      setPwdDone(true);
      setOldPwd("");
      setNewPwd("");
      setConfirmPwd("");
      window.setTimeout(() => {
        // 改密码这条路不用调 /auth/logout：后端靠令牌里的密码指纹已把旧令牌全作废了。
        // 但运单清单缓存同样要清（2026-08-31，排查报告第 57 条）。
        clearClientOrderCaches();
        clearAuthSession();
        window.location.href = "/login";
      }, 1500);
    } catch (e) {
      setPwdError(e instanceof Error ? e.message : "修改失败，请重试");
    } finally {
      setPwdSubmitting(false);
    }
  };

  // 挂载一次：核对登录信息、读回侧边栏的展开/收起记忆。
  // 外壳挂在根布局上，换页不会再跑这里（换页后「当前页所在分区展开」由下面按路径的 effect 管）。
  useEffect(() => {
    const initialSession = getOptionalSession();
    acceptSession(initialSession);
    setMounted(true);
    shellMountedOnceInThisTab = true;
    setCurrentHash(window.location.hash);
    // 换身份会整页重开（见 identityChanging），所以按挂载时的角色读一次就够
    setExpandedGroups(initialExpandedGroups(initialSession?.role));
    // 上次是不是把侧边栏收起来了。放在这里读：这个 effect 只在浏览器里跑
    setSidebarCollapsed(readCollapsed());
  }, [acceptSession]);

  // 换页（Link 客户端跳转 / 后退前进）后重读 #：Next 在提交这次渲染前已经把地址写进历史记录
  useEffect(() => {
    if (!mounted) return;
    setCurrentHash(window.location.hash);
  }, [currentPath, mounted]);

  useEffect(() => {
    if (!mounted) return;
    const handleLocationChange = () => {
      setCurrentHash(window.location.hash);
    };
    window.addEventListener("hashchange", handleLocationChange);
    window.addEventListener("popstate", handleLocationChange);
    return () => {
      window.removeEventListener("hashchange", handleLocationChange);
      window.removeEventListener("popstate", handleLocationChange);
    };
  }, [mounted]);

  // 菜单按登录身份取（不按页面允许的第一个角色）：管理员进员工页（装柜管理、整柜询价）看到的仍是管理员菜单
  const menuRole = session?.role;

  // 当前页所在的分组自动展开（换页、后退前进时也要）。只加不减、不写 localStorage：
  // 用户手动展开/收起才记下来，自动展开不覆盖他的记忆。
  useEffect(() => {
    if (!mounted || !menuRole) return;
    const here = currentPath + currentHash;
    const hit = (roleFunctionGroups[menuRole] ?? []).find((g) =>
      g.items.some(
        (item) =>
          item.href === here ||
          // 独立页面（href 里没有 #）按路径匹配即可
          (!item.href.includes("#") && item.href === currentPath),
      ),
    );
    if (!hit) return;
    setExpandedGroups((prev) => {
      if (prev.has(hit.groupLabel)) return prev;
      const next = new Set(prev);
      next.add(hit.groupLabel);
      return next;
    });
  }, [mounted, menuRole, currentPath, currentHash]);

  // 2026-08-07：登录信息原来只在页面打开时读一次。之后就算它被清掉
  // （在别的标签页退出登录、或者接口返回 401 被清），这个外壳还照常显示
  // 用户名和菜单 —— 看着像登着，点什么都失败。
  // 这里在「别的标签页动了登录信息」和「切回本页」时重新核对一次；
  // 发现没了就交给下面那个 effect 跳登录页。
  useEffect(() => {
    if (!mounted) return;
    const recheck = () => {
      acceptSession(getOptionalSession());
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") recheck();
    };
    window.addEventListener("storage", recheck);
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("storage", recheck);
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [mounted, acceptSession]);

  useEffect(() => {
    if (!mounted || identityChanging) return;
    if (!session) {
      // storage/focus 事件可能先排入旧的 null 状态，随后另一标签已经完成新登录。
      // 真正跳转前以当前共享存储再核对，避免旧事件把新会话误送回登录页。
      const latest = getOptionalSession();
      if (latest) {
        acceptSession(latest);
        return;
      }
      // 2026-08-07：踢人之前把现场记下来。反复出现「所有接口都 200、
      // 却突然被弹回登录页」，没有日志根本查不出是哪一步把登录信息弄丢的。
      // ⚠️ 只记有没有、长度，绝不打印令牌内容。
      if (typeof window !== "undefined") {
        let rawLen = -1;
        let rawErr = "";
        try {
          rawLen = window.localStorage.getItem("auth_session_v1")?.length ?? 0;
        } catch (e) {
          rawErr = e instanceof Error ? e.message : String(e);
        }
        const info = {
          页面: window.location.pathname,
          浏览器里还有没有登录信息: rawLen > 0 ? `有（${rawLen} 字符）` : rawLen === 0 ? "没有" : "读不到",
          读取报错: rawErr || "无",
          再读一次的结果: getOptionalSession() ? "读到了（说明刚才是瞬时读不到）" : "还是读不到",
        };
        console.warn("[被踢回登录页] RoleShell 认为没登录", info);
        // 临时排查用：跳页之后 console 会清空，写一份到 sessionStorage
        try {
          const prev = JSON.parse(window.sessionStorage.getItem("__xt_kick_log") || "[]");
          prev.push(info);
          window.sessionStorage.setItem("__xt_kick_log", JSON.stringify(prev.slice(-10)));
        } catch { /* 存不进去就算了 */ }
      }
      const from = encodeURIComponent(window.location.pathname);
      window.location.href = `/login?from=${from}`;
      return;
    }
    if (!allowedRoles.includes(session.role)) {
      const from = encodeURIComponent(window.location.pathname);
      window.location.href = `${ROLE_HOME[session.role] || "/login"}?from=${from}`;
      return;
    }
    return;
  // allowedRoles 已提前计算为稳定数组，用 join 避免引用变化导致重复执行
  }, [allowedRoles.join(","), mounted, session, identityChanging, acceptSession]);

  if (identityChanging) {
    return <main role="status" style={{ padding: 24 }}>账号已切换，正在重新载入工作台…</main>;
  }

  if (!mounted) {
    return (
      <main style={{ padding: 24 }}>
        <div className="shell-skeleton">
          <div className="skeleton skeleton-title" />
          <div className="skeleton skeleton-subtitle" />
          <div className="skeleton skeleton-line" />
          <div className="skeleton skeleton-line" />
          <div className="skeleton skeleton-line" />
        </div>
      </main>
    );
  }

  if (!session) {
    return (
      <main style={{ padding: 24 }}>
        <h1 className="biz-title" style={{ fontSize: 28, marginBottom: 8 }}>{title}</h1>
        <p style={{ color: "var(--c-red-deep)" }}>
          当前未登录，正在跳转到登录页...
        </p>
      </main>
    );
  }

  if (!allowedRoles.includes(session.role)) {
    return (
      <main style={{ padding: 24 }}>
        <h1 className="biz-title" style={{ fontSize: 28, marginBottom: 8 }}>{title}</h1>
        <p style={{ color: "var(--c-red-deep)" }}>
          当前身份为 {session.role}，无权访问该页面，正在跳转到 403 页面...
        </p>
      </main>
    );
  }

  const closeSidebar = () => setSidebarOpen(false);

  // 品牌钩子（B4 接）：藏哪些菜单、改哪些名字。为 null 时全部照旧
  const hiddenMenuIds = new Set(brand?.hiddenMenuIds ?? []);
  const visibleItems = <T extends MenuItem>(items: T[]) => items.filter((item) => !hiddenMenuIds.has(item.id));
  const menuLabel = (item: MenuItem) => brand?.labelOverrides[item.id] ?? item.label;

  /**
   * 菜单链接统一走 next/link（2026-09-16 导航根治）：
   * - 跨页面：交给 Link 客户端跳转，外壳不卸载、左边菜单不消失；Cmd/Ctrl/中键开新标签照常（Link 不拦）。
   * - 同一页只换 #：Link 自己处理不会发 hashchange，页面切不了分区；在 onNavigate 里拦下，
   *   改走 navigateToHash（带 Next 的历史标记 + 手动发 hashchange，后退前进才对得上）。
   * - 手机端点完菜单关抽屉，照旧。
   */
  const renderNavLink = (item: MenuItem, active: boolean, ariaCurrent: "page" | "location", tabIndex?: number) => (
    <Link
      key={item.id}
      href={item.href}
      className={`dashboard-sidebar-link ${active ? "dashboard-sidebar-link-active" : ""}`}
      aria-current={active ? ariaCurrent : undefined}
      tabIndex={tabIndex}
      onClick={closeSidebar}
      onNavigate={(event) => {
        if (!isSamePageHashLink(item.href)) return;
        event.preventDefault();
        navigateToHash(item.href);
      }}
    >
      {menuLabel(item)}
    </Link>
  );

  return (
    <main
      className={`dashboard-layout ledger-shell${variant === "a3" ? " a3-shell" : ""}${
        sidebarCollapsed ? " sidebar-collapsed" : ""
      }`}
    >
      {/* 手机端遮罩 */}
      <div className={`sidebar-overlay ${sidebarOpen ? "open" : ""}`} onClick={closeSidebar} aria-hidden="true" />

      <aside
        id={navigationId}
        ref={sidebarRef}
        className={`dashboard-sidebar ${sidebarOpen ? "open" : ""}`}
        aria-label="工作台导航"
        aria-hidden={mobileNavigation && !sidebarOpen ? true : undefined}
        inert={mobileNavigation && !sidebarOpen}
      >
        <button type="button" className="sidebar-close-btn" onClick={closeSidebar} aria-label="关闭导航菜单">×</button>
        <h2 className="dashboard-sidebar-title">
          {brand?.logoUrl ? <img src={brand.logoUrl} alt="" style={{ height: 24, marginRight: 8, verticalAlign: "middle" }} /> : null}
          {brand ? brand.name : "湘泰物流"}
          {(brand ? brand.caption : "XIANGTAI") ? <span className="dashboard-brand-caption">{brand ? brand.caption : "XIANGTAI"}</span> : null}
        </h2>
        {/* 桌面收起按钮保持绝对定位，避免影响顶栏及 sticky 列。 */}
        <button
          type="button"
          className="sidebar-collapse-btn"
          onClick={toggleSidebarCollapsed}
          title="收起侧边栏"
          aria-label="收起侧边栏"
        >
          ‹‹
        </button>
        <div className="dashboard-sidebar-group">
          {visibleItems(roleMenus[session.role] ?? []).map((item) =>
            renderNavLink(item, currentPath === item.href && !currentHash, "page"),
          )}
        </div>

        {(roleFunctionGroups[session.role] ?? []).map((group, groupIndex) => {
          const items = visibleItems(group.items);
          if (items.length === 0) return null;
          const isExpanded = expandedGroups.has(group.groupLabel);
          return (
            <div
              key={group.groupLabel}
              className={`dashboard-sidebar-group dashboard-sidebar-group-collapsible ${isExpanded ? "is-expanded" : ""}`}
            >
              <button
                type="button"
                className="dashboard-sidebar-group-header"
                aria-expanded={isExpanded}
                aria-controls={`${navigationId}-group-${groupIndex}`}
                onClick={() => {
                  setExpandedGroups((prev) => {
                    const next = new Set(prev);
                    if (next.has(group.groupLabel)) next.delete(group.groupLabel);
                    else next.add(group.groupLabel);
                    // 存下来，刷新/新开标签后还能恢复
                    saveExpandedGroups(session.role, next);
                    return next;
                  });
                }}
              >
                {/* 箭头只有一个字符，展开靠 CSS 转 90 度，换字符会丢掉过渡动画 */}
                <span className="dashboard-sidebar-group-arrow">▸</span>
                {group.groupLabel}
              </button>
              {/* 收起时不摘节点，只把外层高度收到 0：摘掉就没法放收起动画了 */}
              <div id={`${navigationId}-group-${groupIndex}`} className="dashboard-sidebar-group-body" aria-hidden={!isExpanded}>
                <div className="dashboard-sidebar-group-body-inner">
                  {items.map((item) =>
                    renderNavLink(item, currentPath + currentHash === item.href, "location", isExpanded ? undefined : -1),
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {globalMenus.length > 0 && <h3 className="dashboard-sidebar-subtitle">全局菜单</h3>}
        <div className="dashboard-sidebar-group">
          {visibleItems(globalMenus).map((item) =>
            renderNavLink(item, currentPath === item.href && !currentHash, "page"),
          )}
        </div>
        <div className="dashboard-sidebar-actions">
          <button
            type="button"
            className="dashboard-password-button"
            onClick={() => {
              closeSidebar();
              openPwdModal();
            }}
          >
            修改密码
          </button>
          <button
            type="button"
            className="dashboard-logout-button"
            onClick={async () => {
              // 先告诉服务器把这张令牌作废（2026-08-31，排查报告第 58 条）——
              // 不然退出前被抄走的令牌还能用最长 7 天。
              // ⚠️ 必须在清本地凭证**之前**调：清完就没有令牌可发了。
              // ⚠️ 调失败（断网、后端没起）也照样往下走本地清理，退出不能被卡住。
              // ⚠️ 最多等 3 秒（2026-08-31 复查 #20）：服务器连得上却不响应时，
              //    apiRequest 单次超时要 30 秒，用户点了退出会干等半分钟以为死机。
              //    3 秒等不到就不等了，本地清理照做。
              try {
                const revoke = apiRequest(`${apiBaseUrl()}/auth/logout`, { method: "POST" });
                // 兜底超时后它才失败的话，别在控制台冒「未处理的 Promise 错误」
                revoke.catch(() => {});
                await Promise.race([
                  revoke,
                  new Promise((_, reject) => window.setTimeout(() => reject(new Error("logout timeout")), 3000)),
                ]);
              } catch {
                /* 服务器侧作废失败/超时就算了，本地清理照做 */
              }
              // 共用电脑场景：运单清单缓存也得清（排查报告第 57 条）
              clearClientOrderCaches();
              clearAuthSession();
              window.location.href = "/login";
            }}
          >
            退出账号
          </button>
        </div>
      </aside>
      <div className="dashboard-content" inert={mobileNavigation && sidebarOpen}>
        <div className="glass-topbar">
          <button
            ref={sidebarTriggerRef}
            type="button"
            className="mobile-hamburger"
            onClick={() => setSidebarOpen(true)}
            aria-label="打开导航菜单"
            aria-expanded={sidebarOpen}
            aria-controls={navigationId}
          >
            <span className="hamburger-line" aria-hidden="true" />
            <span className="hamburger-line" aria-hidden="true" />
            <span className="hamburger-line" aria-hidden="true" />
          </button>
          {/* 收起后仍须能从侧边栏外展开；保持顶栏高度不变。 */}
          <button
            type="button"
            className="sidebar-expand-btn"
            onClick={toggleSidebarCollapsed}
            title="展开侧边栏"
            aria-label="展开侧边栏"
          >
            ››
          </button>
          <span className="glass-topbar-title">{title}</span>
          <span className="glass-topbar-meta">{session.userId} · {ROLE_LABEL[session.role]}</span>
        </div>
        {children}
      </div>

      {/* 修改密码弹窗：三端共用，改的永远是当前登录的这个账号 */}
      {pwdOpen && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 60, display: "flex",
            alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,0.4)", padding: 16,
          }}
        >
          <div
            style={{
              width: "100%", maxWidth: 380, background: "var(--canvas)",
              border: "1px solid var(--hairline)", borderRadius: 10, padding: 20,
            }}
          >
            <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 600, color: "var(--ink-legacy)" }}>修改密码</h3>
            <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--ink-mute)" }}>
              当前账号：{session.userId}
            </p>

            {pwdDone ? (
              <p style={{ margin: 0, fontSize: 14, color: "var(--ink-legacy)" }}>
                密码已修改。正在退出，请用新密码重新登录…
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <input
                  type={showPwd ? "text" : "password"}
                  value={oldPwd}
                  onChange={(e) => setOldPwd(e.target.value)}
                  placeholder="旧密码"
                  autoComplete="current-password"
                  style={{ border: "1px solid var(--hairline)", borderRadius: 8, padding: "8px 12px", fontSize: 14 }}
                />
                <input
                  type={showPwd ? "text" : "password"}
                  value={newPwd}
                  onChange={(e) => setNewPwd(e.target.value)}
                  placeholder="新密码（至少 8 位，不能全是数字）"
                  autoComplete="new-password"
                  style={{ border: "1px solid var(--hairline)", borderRadius: 8, padding: "8px 12px", fontSize: 14 }}
                />
                <input
                  type={showPwd ? "text" : "password"}
                  value={confirmPwd}
                  onChange={(e) => setConfirmPwd(e.target.value)}
                  placeholder="再输一次新密码"
                  autoComplete="new-password"
                  onKeyDown={(e) => { if (e.key === "Enter") void submitPwd(); }}
                  style={{ border: "1px solid var(--hairline)", borderRadius: 8, padding: "8px 12px", fontSize: 14 }}
                />
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--ink-mute)", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={showPwd}
                    onChange={(e) => setShowPwd(e.target.checked)}
                    style={{ cursor: "pointer" }}
                  />
                  显示密码
                </label>
                {pwdError ? (
                  <p style={{ margin: 0, fontSize: 13, color: "var(--danger)" }}>{pwdError}</p>
                ) : null}
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
                  <button
                    type="button"
                    onClick={() => setPwdOpen(false)}
                    style={{ border: "1px solid var(--hairline)", borderRadius: 8, padding: "8px 16px", fontSize: 13, background: "var(--canvas)", cursor: "pointer", color: "var(--t-strong)" }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={pwdSubmitting}
                    onClick={() => void submitPwd()}
                    style={{ border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 13, background: "var(--brand)", color: "var(--white)", fontWeight: 500, cursor: pwdSubmitting ? "not-allowed" : "pointer" }}
                  >
                    {pwdSubmitting ? "提交中…" : "确认修改"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
