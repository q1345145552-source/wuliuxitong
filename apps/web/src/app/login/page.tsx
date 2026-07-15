"use client";

import { useEffect, useMemo, useState } from "react";
import { clearAuthSession, getOptionalSession, setAuthSession } from "../../auth/auth-session";
import { login } from "../../services/auth-api";

const roleRouteMap: Record<string, string> = {
  admin: "/admin",
  staff: "/staff",
  client: "/client",
};

export default function LoginPage() {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [existingSession, setExistingSession] = useState<ReturnType<typeof getOptionalSession>>(null);

  useEffect(() => {
    const session = getOptionalSession();
    // 如果是 token 过期跳转回来的，清掉旧 session，不显示进入工作台按钮
    const isExpired = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("expired");
    if (isExpired) {
      clearAuthSession();
      setExistingSession(null);
    } else {
      setExistingSession(session);
    }
  }, []);

  const canSubmit = useMemo(() => account.trim().length > 0 && password.trim().length > 0, [account, password]);

  const submit = async () => {
    if (!canSubmit || loading) return;
    setLoading(true);
    setMessage("");
    try {
      const result = await login({
        account: account.trim(),
        password: password.trim(),
      });
      setAuthSession({
        userId: result.user.id,
        companyId: result.user.companyId,
        role: result.user.role,
        token: result.token,
      });
      window.location.href = roleRouteMap[result.user.role] || "/";
    } catch (error) {
      const text = error instanceof Error ? error.message : "登录失败";
      setMessage(`登录失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
        minHeight: "100vh",
        width: "100vw",
        display: "grid",
        placeItems: "center",
        padding: 20,
        position: "relative",
        overflow: "hidden",
        backgroundImage: "url(/images/login-bg.jpg)",
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      }}>
      {/* 半透明遮罩 */}
      <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.15)", zIndex: 0 }} />
      <section style={{
          position: "relative",
          zIndex: 1,
          width: "100%",
          maxWidth: 440,
          border: "1px solid rgba(255,255,255,0.18)",
          borderRadius: 16,
          background: "rgba(255,255,255,0.75)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          padding: "32px 28px",
          boxShadow: "0 16px 48px rgba(0,0,0,0.3)",
        }}>
        <h1 style={{ margin: 0, fontSize: 24, textAlign: "center", color: "#171717" }}>湘泰物流网站登录</h1>

        {existingSession ? (
          <div style={{ marginTop: 16, textAlign: "center" }}>
            <p style={{ color: "#000000", fontSize: 14, marginBottom: 12 }}>
              检测到已登录账号：<strong>{existingSession.userId}</strong>（{existingSession.role === "admin" ? "管理员" : existingSession.role === "staff" ? "员工" : "客户"}）
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
              <button
                type="button"
                onClick={() => { window.location.href = roleRouteMap[existingSession.role] || "/"; }}
                style={{ border: "none", borderRadius: 8, padding: "10px 20px", background: "#2563eb", color: "#fff", fontWeight: 600, cursor: "pointer" }}
              >
                进入工作台
              </button>
              <button
                type="button"
                onClick={() => { clearAuthSession(); setExistingSession(null); }}
                style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 20px", background: "#fff", cursor: "pointer", color: "#dc2626" }}
              >
                退出并切换账号
              </button>
            </div>
          </div>
        ) : (
          <>
            <p style={{ marginTop: 8, color: "#000000", fontSize: 14, textAlign: "center" }}>请输入账号和密码登录系统。</p>

        <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
          <input
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            placeholder="账号"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 12px" }}
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="密码"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 12px" }}
          />

          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit || loading}
            style={{
              border: "none",
              borderRadius: 8,
              padding: "10px 12px",
              background: canSubmit && !loading ? "#2563eb" : "#000000",
              color: "#fff",
              fontWeight: 600,
              cursor: canSubmit && !loading ? "pointer" : "not-allowed",
            }}
          >
            {loading ? "登录中..." : "登录"}
          </button>
        </div>

        {message ? <p style={{ marginTop: 10, color: "#b91c1c", fontSize: 13 }}>{message}</p> : null}

        {!existingSession && (
        )}
          </>
        )}
      </section>
    </div>
  );
}
