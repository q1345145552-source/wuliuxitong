"use client";

import { useEffect, useState } from "react";
import { clearAuthSession, getOptionalSession, type MockSession } from "../../auth/mock-session";

export default function MockLoginPanel() {
  const [session, setSession] = useState<MockSession | null>(null);

  useEffect(() => {
    setSession(getOptionalSession());
  }, []);

  return (
    <section
      style={{
        marginTop: 18,
        maxWidth: 680,
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        padding: 16,
      }}
    >
      <h2 style={{ margin: 0, fontSize: 18 }}>账号入口</h2>
      <p style={{ marginTop: 8, color: "#1f2937" }}>
        系统已切换为真实登录模式。请先登录或注册后再进入工作台。
      </p>

      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <a
          href="/login"
          style={{
            border: "1px solid #2563eb",
            borderRadius: 8,
            padding: "8px 14px",
            color: "#2563eb",
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          去登录
        </a>
        <a
          href="/register"
          style={{
            border: "1px solid #059669",
            borderRadius: 8,
            padding: "8px 14px",
            color: "#059669",
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          去注册
        </a>
        {session ? (
          <button
            type="button"
            onClick={() => {
              clearAuthSession();
              window.location.href = "/login";
            }}
            style={{
              border: "1px solid #dc2626",
              borderRadius: 8,
              padding: "8px 14px",
              background: "#fff",
              color: "#dc2626",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            退出登录
          </button>
        ) : null}
      </div>

    </section>
  );
}
