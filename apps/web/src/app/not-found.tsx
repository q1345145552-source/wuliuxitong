import Link from "next/link";

export default function NotFound() {
  return (
    <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f8fafc" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 8 }}>📦</div>
        <h1 style={{ margin: 0, fontSize: 24, color: "#111827" }}>404 — 页面未找到</h1>
        <p style={{ marginTop: 8, color: "#6b7280", fontSize: 14 }}>您访问的页面不存在或已被移除。</p>
        <Link href="/login" style={{ display: "inline-block", marginTop: 16, color: "#059669", fontSize: 14, textDecoration: "none" }}>
          返回登录
        </Link>
      </div>
    </main>
  );
}
