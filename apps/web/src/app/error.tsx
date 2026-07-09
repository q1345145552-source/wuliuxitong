"use client";

export default function RootError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f8fafc" }}>
      <div style={{ textAlign: "center", maxWidth: 400, padding: 24 }}>
        <h2 style={{ margin: 0, fontSize: 18, color: "#111827" }}>页面加载出错</h2>
        <p style={{ marginTop: 8, color: "#6b7280", fontSize: 13 }}>{error.message || "发生了未知错误"}</p>
        <button
          onClick={reset}
          style={{
            marginTop: 16, border: "none", borderRadius: 8, padding: "8px 20px",
            background: "#059669", color: "#fff", fontWeight: 600, cursor: "pointer", fontSize: 14,
          }}
        >
          重试
        </button>
      </div>
    </main>
  );
}
