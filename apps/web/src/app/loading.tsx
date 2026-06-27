export default function RootLoading() {
  return (
    <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f8fafc" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ width: 40, height: 40, border: "3px solid #e5e7eb", borderTopColor: "#059669", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto" }} />
        <p style={{ marginTop: 12, color: "#6b7280", fontSize: 14 }}>加载中...</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </main>
  );
}
