"use client";

import { useEffect, useState } from "react";

export default function ForbiddenPage() {
  const [from, setFrom] = useState<string>("-");

  useEffect(() => {
    const url = new URL(window.location.href);
    setFrom(url.searchParams.get("from") ?? "-");
  }, []);

  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ fontSize: 28, marginBottom: 10 }}>403 - 无权限访问</h1>
      <p style={{ color: "#4b5563", marginBottom: 8 }}>
        当前登录角色无权访问该页面。
      </p>
      <p style={{ color: "#000000", marginBottom: 16 }}>来源页面：{from}</p>
      <div style={{ display: "flex", gap: 10 }}>
        <a href="/login" style={{ color: "#2563eb", textDecoration: "none" }}>
          返回登录切换角色
        </a>
        <a href="/client" style={{ color: "#2563eb", textDecoration: "none" }}>
          去客户端
        </a>
        <a href="/staff" style={{ color: "#2563eb", textDecoration: "none" }}>
          去员工端
        </a>
        <a href="/admin" style={{ color: "#2563eb", textDecoration: "none" }}>
          去管理员端
        </a>
      </div>
    </main>
  );
}
