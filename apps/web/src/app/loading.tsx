/**
 * 2026-09-16：工作台外壳挪进根布局以后，这个加载提示会画在外壳「右边内容区」里，
 * 左边深色菜单不动。所以这里不能再撑满 100vh、也不能带整屏底色 ——
 * 否则每次切页右边会闪一大块浅灰。只留一个小转圈，透明底。
 */
export default function RootLoading() {
  return (
    <div role="status" style={{ padding: "48px 24px", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ width: 28, height: 28, border: "3px solid var(--l-soft)", borderTopColor: "var(--c-green)", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto" }} />
        <p style={{ marginTop: 10, color: "var(--t-muted)", fontSize: 13 }}>加载中...</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  );
}
