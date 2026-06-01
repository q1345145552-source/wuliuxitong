"use client";

import { useEffect, useState } from "react";
import {
  clearAuthSession,
  getOptionalSession,
  setAuthSession,
  type MockRole,
  type MockSession,
} from "../../auth/mock-session";
import { login } from "../../services/auth-api";

const roleRouteMap: Record<MockRole, string> = {
  client: "/client",
  staff: "/staff",
  admin: "/admin",
};

const quickAccounts: Record<MockRole, string> = {
  client: "u_client_001",
  staff: "u_staff_001",
  admin: "u_admin_001",
};

export default function RoleSwitcher(props: { compact?: boolean }) {
  const [session, setSession] = useState<MockSession | null>(null);
  const [switchingRole, setSwitchingRole] = useState<MockRole | null>(null);
  const [error, setError] = useState("");
  const compact = props.compact ?? false;

  useEffect(() => {
    setSession(getOptionalSession());
  }, []);

  const logout = () => {
    clearAuthSession();
    window.location.href = "/login";
  };

  const quickSwitch = async (role: MockRole) => {
    if (switchingRole) return;
    setSwitchingRole(role);
    setError("");
    try {
      const result = await login({
        account: quickAccounts[role],
        password: "123456",
        role,
      });
      setAuthSession({
        userId: result.user.id,
        companyId: result.user.companyId,
        role: result.user.role,
        token: result.token,
      });
      window.location.href = roleRouteMap[result.user.role];
    } catch (e) {
      const text = e instanceof Error ? e.message : "切换失败";
      setError(`切换失败：${text}`);
    } finally {
      setSwitchingRole(null);
    }
  };

  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 10,
        padding: compact ? 8 : 12,
        background: "#fff",
      }}
    >
      <div style={{ fontSize: compact ? 12 : 13, color: "#000000", marginBottom: 8 }}>
        当前身份：{session ? `${session.role} / ${session.userId} / ${session.companyId}` : "未登录"}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <a href="/login" style={{ color: "#2563eb", textDecoration: "none" }}>返回登录</a>
        {(["client", "staff", "admin"] as MockRole[]).map((role) => (
          <button
            key={role}
            type="button"
            onClick={() => void quickSwitch(role)}
            disabled={switchingRole !== null}
            style={{
              border: "1px solid #d1d5db",
              borderRadius: 999,
              padding: compact ? "5px 10px" : "6px 12px",
              background: session?.role === role ? "#dbeafe" : "#fff",
              cursor: switchingRole ? "not-allowed" : "pointer",
            }}
          >
            {switchingRole === role ? "切换中..." : `切换为 ${role}`}
          </button>
        ))}
        <button
          type="button"
          onClick={logout}
          style={{
            border: "1px solid #d1d5db",
            borderRadius: 999,
            padding: compact ? "5px 10px" : "6px 12px",
            background: "#fff",
            cursor: "pointer",
          }}
        >
          退出登录
        </button>
      </div>
      {error ? <div style={{ marginTop: 8, fontSize: 12, color: "#b91c1c" }}>{error}</div> : null}
    </div>
  );
}
