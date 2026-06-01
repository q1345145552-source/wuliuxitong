"use client";

import { useMemo, useState } from "react";
import { setAuthSession } from "../../auth/mock-session";
import { registerClient } from "../../services/auth-api";

export default function RegisterPage() {
  const [form, setForm] = useState({
    account: "",
    password: "",
    name: "",
    phone: "",
    companyId: "c_001",
    companyName: "",
    email: "",
  });
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const canSubmit = useMemo(() => {
    return (
      form.account.trim().length > 0 &&
      form.password.trim().length >= 6 &&
      form.name.trim().length > 0 &&
      form.phone.trim().length > 0
    );
  }, [form]);

  const submit = async () => {
    if (!canSubmit || loading) return;
    setLoading(true);
    setMessage("");
    try {
      const result = await registerClient({
        account: form.account.trim(),
        password: form.password.trim(),
        name: form.name.trim(),
        phone: form.phone.trim(),
        companyId: form.companyId.trim() || "c_001",
        companyName: form.companyName.trim() || undefined,
        email: form.email.trim() || undefined,
      });
      setAuthSession({
        userId: result.user.id,
        companyId: result.user.companyId,
        role: result.user.role,
        token: result.token,
      });
      window.location.href = "/client";
    } catch (error) {
      const text = error instanceof Error ? error.message : "注册失败";
      setMessage(`注册失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#f8fafc", padding: 20 }}>
      <section style={{ width: "100%", maxWidth: 460, border: "1px solid #e5e7eb", borderRadius: 12, background: "#fff", padding: 20 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>湘泰物流系统注册</h1>
        <p style={{ marginTop: 8, color: "#000000", fontSize: 14 }}>注册后将以客户身份进入系统。</p>

        <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
          <input
            value={form.account}
            onChange={(e) => setForm((v) => ({ ...v, account: e.target.value }))}
            placeholder="账号（必填）"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 12px" }}
          />
          <input
            type="password"
            value={form.password}
            onChange={(e) => setForm((v) => ({ ...v, password: e.target.value }))}
            placeholder="密码（至少6位）"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 12px" }}
          />
          <input
            value={form.name}
            onChange={(e) => setForm((v) => ({ ...v, name: e.target.value }))}
            placeholder="姓名（必填）"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 12px" }}
          />
          <input
            value={form.phone}
            onChange={(e) => setForm((v) => ({ ...v, phone: e.target.value }))}
            placeholder="手机号（必填）"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 12px" }}
          />
          <input
            value={form.companyId}
            onChange={(e) => setForm((v) => ({ ...v, companyId: e.target.value }))}
            placeholder="公司ID（默认 c_001）"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 12px" }}
          />
          <input
            value={form.companyName}
            onChange={(e) => setForm((v) => ({ ...v, companyName: e.target.value }))}
            placeholder="公司名称（选填）"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 12px" }}
          />
          <input
            type="email"
            value={form.email}
            onChange={(e) => setForm((v) => ({ ...v, email: e.target.value }))}
            placeholder="邮箱（选填）"
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
              background: canSubmit && !loading ? "#059669" : "#000000",
              color: "#fff",
              fontWeight: 600,
              cursor: canSubmit && !loading ? "pointer" : "not-allowed",
            }}
          >
            {loading ? "注册中..." : "注册并登录"}
          </button>
        </div>

        {message ? <p style={{ marginTop: 10, color: "#b91c1c", fontSize: 13 }}>{message}</p> : null}

        <div style={{ marginTop: 12, fontSize: 13 }}>
          已有账号？<a href="/login" style={{ color: "#2563eb", textDecoration: "none" }}>去登录</a>
        </div>
      </section>
    </main>
  );
}
