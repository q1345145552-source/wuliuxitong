"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { prepareLoginPage, setAuthSession } from "../../auth/auth-session";
import { login } from "../../services/auth-api";

const roleRouteMap: Record<string, string> = {
  admin: "/admin",
  staff: "/staff",
  client: "/client",
  agent: "/agent",
};

export default function LoginPage() {
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [message, setMessage] = useState("");
  const inFlight = useRef(false);

  useEffect(() => {
    // 打开/刷新另一张登录页不等于主动退出；换账号成功后由 setAuthSession 清旧缓存。
    prepareLoginPage();
    setReady(true);
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ready || inFlight.current) return;
    // 从真实表单取值，支持密码管理器/浏览器自动填充，不依赖是否触发 React onChange。
    const form = new FormData(event.currentTarget);
    const account = String(form.get("account") ?? "").trim();
    /**
     * 密码两端空格要去掉（2026-09-05 复查恢复）。
     * 后端管理员设密码/重置密码存的是 trim 过的哈希（admin/routes.ts），登录路由按原样比对；
     * 客户密码就是唛头本身、常从聊天记录复制，尾巴带个空格是常态——前端不 trim 就登不进去。
     */
    const password = String(form.get("password") ?? "").trim();
    if (!account || !password) {
      setMessage("请输入账号和密码。");
      return;
    }
    inFlight.current = true;
    setLoading(true);
    setMessage("");
    try {
      // 密码已在上面 trim 过（原因见那段注释），这里原样交给后端比对。
      const result = await login({ account, password });
      setAuthSession({
        userId: result.user.id,
        companyId: result.user.companyId,
        role: result.user.role,
        token: result.token,
      });
      window.location.href = roleRouteMap[result.user.role] || "/";
    } catch (error) {
      const text = error instanceof Error ? error.message : "请稍后重试";
      setMessage(`登录失败：${text}`);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-visual">
        <div className="auth-visual-text">
          <h2>湘泰物流</h2>
          <p>中泰跨境物流管理系统<br />预报 · 装柜 · 清关 · 派送 · 签收，全程可查</p>
        </div>
      </div>
      <div className="auth-panel">
        <form
          className="auth-form"
          method="post"
          action="/auth/login"
          onSubmit={(event) => void submit(event)}
          aria-labelledby="login-heading"
          aria-busy={loading}
          onKeyDownCapture={(event) => {
            if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault();
          }}
        >
          <h1 id="login-heading">登录</h1>
          <p className="auth-sub">使用你的账号进入对应工作台</p>
          <div className="auth-field">
            <label htmlFor="login-account">账号</label>
            <input
              id="login-account" name="account" required
              placeholder="请输入账号" autoComplete="username" autoCapitalize="none" spellCheck={false}
              disabled={loading} aria-describedby={message ? "login-error" : undefined}
              onChange={() => { if (message) setMessage(""); }}
            />
          </div>
          <div className="auth-field">
            <label htmlFor="login-password">密码</label>
            <div className="auth-password-field">
              <input
                id="login-password" name="password" type={showPassword ? "text" : "password"} required
                placeholder="请输入密码" autoComplete="current-password" disabled={loading}
                aria-describedby={[message ? "login-error" : "", capsLock ? "login-caps-lock" : ""].filter(Boolean).join(" ") || undefined}
                onChange={() => { if (message) setMessage(""); }}
                onKeyUp={(event) => setCapsLock(event.getModifierState("CapsLock"))}
                onKeyDown={(event) => setCapsLock(event.getModifierState("CapsLock"))}
                onBlur={() => setCapsLock(false)}
              />
              <button type="button" className="auth-password-toggle" aria-label={showPassword ? "隐藏密码" : "显示密码"} aria-pressed={showPassword} aria-controls="login-password" disabled={loading} onClick={() => setShowPassword((value) => !value)}>
                {showPassword ? "隐藏" : "显示"}
              </button>
            </div>
            {capsLock && <p id="login-caps-lock" className="auth-field-hint" role="status">大写锁定已开启</p>}
          </div>
          {message && <p id="login-error" className="auth-error" role="alert">{message}</p>}
          <button type="submit" className="auth-btn" disabled={!ready || loading}>
            {!ready ? "正在准备…" : loading ? "登录中…" : "登录"}
          </button>
          <noscript><p className="auth-error">请启用浏览器 JavaScript 后刷新页面再登录。</p></noscript>
          <div className="auth-foot">还没有账号？<a href="/register">申请开通</a></div>
        </form>
      </div>
    </div>
  );
}
