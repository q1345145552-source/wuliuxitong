"use client";

import { useMemo, useState } from "react";
import { setAuthSession } from "../../auth/mock-session";
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
        <h1 style={{ margin: 0, fontSize: 24, textAlign: "center", color: "#171717" }}>湘泰物流系统登录</h1>
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

        <div style={{ marginTop: 12, fontSize: 13 }}>
          还没有账号？<a href="/register" style={{ color: "#2563eb", textDecoration: "none" }}>去注册</a>
        </div>
      </section>
    </div>
  );
}
