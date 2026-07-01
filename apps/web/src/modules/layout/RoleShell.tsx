"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  BadgeDollarSign,
  Boxes,
  Brain,
  Building2,
  FileText,
  LayoutDashboard,
  LogOut,
  PackageSearch,
  Route,
  ShieldCheck,
  Truck,
  UserCog,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { clearAuthSession, getOptionalSession, type AuthRole, type AuthSession } from "../../auth/auth-session";
import { globalMenus, roleFunctionGroups, roleMenus } from "./menu-config";

/**
 * 为导航菜单返回对应的 Lucide 图标。
 */
function iconForMenuId(id: string): LucideIcon {
  if (id.includes("overview") || id.includes("home")) return LayoutDashboard;
  if (id.includes("staff")) return UserCog;
  if (id.includes("client") || id.includes("clients")) return Users;
  if (id.includes("order") || id.includes("shipment")) return Truck;
  if (id.includes("track")) return Route;
  if (id.includes("bill") || id.includes("settlement")) return BadgeDollarSign;
  if (id.includes("wallet")) return Wallet;
  if (id.includes("docs") || id.includes("knowledge")) return FileText;
  if (id.includes("ai")) return Brain;
  if (id.includes("customs")) return ShieldCheck;
  if (id.includes("lastmile")) return PackageSearch;
  if (id.includes("lmp")) return Building2;
  if (id.includes("import")) return Boxes;
  return LayoutDashboard;
}

export default function RoleShell(props: {
  allowedRole: AuthRole | AuthRole[];
  title: string;
  children: ReactNode;
}) {
  const { allowedRole, title, children } = props;
  const allowedRoles = Array.isArray(allowedRole) ? allowedRole : [allowedRole];
  const [mounted, setMounted] = useState(false);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [currentPath, setCurrentPath] = useState("");
  const [currentHash, setCurrentHash] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    const next = getOptionalSession();
    setSession(next);
    setMounted(true);
    setCurrentPath(window.location.pathname);
    setCurrentHash(window.location.hash);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const handleLocationChange = () => {
      setCurrentPath(window.location.pathname);
      setCurrentHash(window.location.hash);
    };
    window.addEventListener("hashchange", handleLocationChange);
    window.addEventListener("popstate", handleLocationChange);
    return () => {
      window.removeEventListener("hashchange", handleLocationChange);
      window.removeEventListener("popstate", handleLocationChange);
    };
  }, [mounted]);

  useEffect(() => {
    if (!mounted) return;
    if (!session) {
      const from = encodeURIComponent(window.location.pathname);
      window.location.href = `/login?from=${from}`;
      return;
    }
    if (!allowedRoles.includes(session.role)) {
      const from = encodeURIComponent(window.location.pathname);
      const goMap: Record<string, string> = { admin: "/admin", staff: "/staff", client: "/client" };
      window.location.href = `${goMap[session.role] || "/login"}?from=${from}`;
      return;
    }
    return;
  }, [allowedRole, mounted, session]);

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
        <p style={{ color: "#b91c1c" }}>
          当前未登录，正在跳转到登录页...
        </p>
      </main>
    );
  }

  if (!allowedRoles.includes(session.role)) {
    return (
      <main style={{ padding: 24 }}>
        <h1 className="biz-title" style={{ fontSize: 28, marginBottom: 8 }}>{title}</h1>
        <p style={{ color: "#b91c1c" }}>
          当前身份为 {session.role}，无权访问该页面，正在跳转到 403 页面...
        </p>
      </main>
    );
  }

  const closeSidebar = () => setSidebarOpen(false);

  return (
    <main className="dashboard-layout">
      {/* 手机端遮罩 */}
      <div className={`sidebar-overlay ${sidebarOpen ? "open" : ""}`} onClick={closeSidebar} />

      <aside className={`dashboard-sidebar ${sidebarOpen ? "open" : ""}`}>
        <button type="button" className="sidebar-close-btn" onClick={closeSidebar}>✕</button>
        <h2 className="dashboard-sidebar-title">工作台导航</h2>
        <div className="dashboard-sidebar-group">
          {roleMenus[session.role].map((item) => (
            <a
              key={item.id}
              href={item.href}
              className={`dashboard-sidebar-link ${currentPath === item.href ? "dashboard-sidebar-link-active" : ""}`}
              onClick={closeSidebar}
            >
              {(() => {
                const Icon = iconForMenuId(item.id);
                return <Icon size={14} />;
              })()}
              {item.label}
            </a>
          ))}
        </div>
        <h3 className="dashboard-sidebar-subtitle">功能分区</h3>
        {(roleFunctionGroups[allowedRoles[0]] ?? []).map((group) => (
          <div key={group.groupLabel} className="dashboard-sidebar-group">
            <div className="dashboard-sidebar-group-label">{group.groupLabel}</div>
            {group.items.map((item) => (
              <a
                key={item.id}
                href={item.href}
                className={`dashboard-sidebar-link ${currentPath + currentHash === item.href ? "dashboard-sidebar-link-active" : ""}`}
                onClick={closeSidebar}
              >
                {(() => {
                  const Icon = iconForMenuId(item.id);
                  return <Icon size={14} />;
                })()}
                {item.label}
              </a>
            ))}
          </div>
        ))}
        <h3 className="dashboard-sidebar-subtitle">全局菜单</h3>
        <div className="dashboard-sidebar-group">
          {globalMenus.map((item) => (
            <a
              key={item.id}
              href={item.href}
              className={`dashboard-sidebar-link ${currentPath === item.href ? "dashboard-sidebar-link-active" : ""}`}
              onClick={closeSidebar}
            >
              {(() => {
                const Icon = iconForMenuId(item.id);
                return <Icon size={14} />;
              })()}
              {item.label}
            </a>
          ))}
        </div>
        <div className="dashboard-sidebar-actions">
          <button
            type="button"
            className="dashboard-logout-button"
            onClick={() => {
              clearAuthSession();
              window.location.href = "/login";
            }}
          >
            <LogOut size={14} />
            退出账号
          </button>
        </div>
      </aside>
      <div className="dashboard-content">
        <div className="glass-topbar">
          <button type="button" className="mobile-hamburger" onClick={() => setSidebarOpen(true)}>
            <span className="hamburger-line" />
            <span className="hamburger-line" />
            <span className="hamburger-line" />
          </button>
          <span className="glass-topbar-title">{title}</span>
          <span className="glass-topbar-meta">{session.userId} · {session.role}</span>
        </div>
        {children}
      </div>
    </main>
  );
}
