"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

/**
 * 财务系统授权页（2026-11-04）：海外仓财务系统跳过来，用户在这里输物流账号和密码，成功后跳回财务系统。
 * 样式全用登录页现成的 auth-* 类，放在 /login 下面，不占代理前缀的保留字。
 *
 * ⚠️ 这一页不碰任何登录状态：不用 core-api 的 apiRequest（它会带浏览器里的登录令牌，碰到 401 还可能清会话、跳登录页），
 *    也不调 prepareLoginPage / setAuthSession。登录着别的账号的人打开这一页，他的登录不受影响。
 * ⚠️ 仓名只认后端从数据库取的，不从网址取。跳回地址也只认后端给的。
 */

type PageState =
  | { kind: "loading" }
  | { kind: "ready"; warehouseName: string }
  | { kind: "stopped"; text: string }
  | { kind: "done" };

const EXPIRED_TEXT = "这个授权链接已过期或已经用过，请回财务系统重新点「授权登录物流系统」。";
const CLOSED_TEXT = "财务系统授权暂时没有打开，请稍后再试。";
const NETWORK_TEXT = "暂时连不上物流系统，请稍后刷新这一页再试。";
const BUSY_TEXT = "请求太频繁了，请 1 分钟后刷新这一页再试。";

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => null);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

export default function FinanceLinkAuthorizePage() {
  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [requestId, setRequestId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [message, setMessage] = useState("");
  const inFlight = useRef(false);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("request") ?? "";
    setRequestId(id);
    if (!id) {
      setState({ kind: "stopped", text: EXPIRED_TEXT });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/auth/finance-link/request?request=${encodeURIComponent(id)}`, { cache: "no-store" });
        if (cancelled) return;
        if (response.status === 503) { setState({ kind: "stopped", text: CLOSED_TEXT }); return; }
        if (response.status === 429) { setState({ kind: "stopped", text: BUSY_TEXT }); return; }
        if (!response.ok) { setState({ kind: "stopped", text: NETWORK_TEXT }); return; }
        const body = await readJson(response);
        if (cancelled) return;
        if (body.expired !== false || typeof body.warehouseName !== "string") {
          setState({ kind: "stopped", text: EXPIRED_TEXT });
          return;
        }
        setState({ kind: "ready", warehouseName: body.warehouseName });
      } catch {
        if (!cancelled) setState({ kind: "stopped", text: NETWORK_TEXT });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current) return;
    // 从真实表单取值，支持密码管理器 / 浏览器自动填充；密码去首尾空格（同登录页）
    const form = new FormData(event.currentTarget);
    const account = String(form.get("account") ?? "").trim();
    const password = String(form.get("password") ?? "").trim();
    if (!account || !password) {
      setMessage("请输入账号和密码。");
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/auth/finance-link/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, account, password }),
      });
      const body = await readJson(response);
      if (response.ok && typeof body.redirectUrl === "string") {
        setState({ kind: "done" });
        // 用 replace：浏览器后退不会再回到这张已经用过的授权页
        window.location.replace(body.redirectUrl);
        return;
      }
      if (response.status === 503) setState({ kind: "stopped", text: CLOSED_TEXT });
      else if (body.code === "LINK_REQUEST_INVALID") setState({ kind: "stopped", text: EXPIRED_TEXT });
      // 跟登录页同一句，不说是账号不存在还是密码错
      else if (response.status === 401) setMessage("登录失败：账号或密码不对，请重新输入");
      else if (response.status === 403 || response.status === 429) setMessage(typeof body.message === "string" ? body.message : "请稍后再试。");
      else setMessage(NETWORK_TEXT);
    } catch {
      setMessage(NETWORK_TEXT);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
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
        {state.kind === "ready" ? (
          <form
            className="auth-form"
            onSubmit={(event) => void submit(event)}
            aria-labelledby="authorize-heading"
            aria-busy={submitting}
            onKeyDownCapture={(event) => {
              if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault();
            }}
          >
            <h1 id="authorize-heading">授权查看运单</h1>
            <p className="auth-sub">海外仓财务系统（{state.warehouseName}）申请查看你这个账号的运单状态。只能看，不能改。你的密码不会交给财务系统。</p>
            <div className="auth-field">
              <label htmlFor="authorize-account">账号</label>
              <input
                id="authorize-account" name="account" required
                placeholder="请输入物流账号" autoComplete="username" autoCapitalize="none" spellCheck={false}
                disabled={submitting} aria-describedby={message ? "authorize-error" : undefined}
                onChange={() => { if (message) setMessage(""); }}
              />
            </div>
            <div className="auth-field">
              <label htmlFor="authorize-password">密码</label>
              <div className="auth-password-field">
                <input
                  id="authorize-password" name="password" type={showPassword ? "text" : "password"} required
                  placeholder="请输入密码" autoComplete="current-password" disabled={submitting}
                  aria-describedby={[message ? "authorize-error" : "", capsLock ? "authorize-caps-lock" : ""].filter(Boolean).join(" ") || undefined}
                  onChange={() => { if (message) setMessage(""); }}
                  onKeyUp={(event) => setCapsLock(event.getModifierState("CapsLock"))}
                  onKeyDown={(event) => setCapsLock(event.getModifierState("CapsLock"))}
                  onBlur={() => setCapsLock(false)}
                />
                <button type="button" className="auth-password-toggle" aria-label={showPassword ? "隐藏密码" : "显示密码"} aria-pressed={showPassword} aria-controls="authorize-password" disabled={submitting} onClick={() => setShowPassword((value) => !value)}>
                  {showPassword ? "隐藏" : "显示"}
                </button>
              </div>
              {capsLock && <p id="authorize-caps-lock" className="auth-field-hint" role="status">大写锁定已开启</p>}
            </div>
            {message && <p id="authorize-error" className="auth-error" role="alert">{message}</p>}
            <button type="submit" className="auth-btn" disabled={submitting}>
              {submitting ? "授权中…" : "登录并授权"}
            </button>
            <noscript><p className="auth-error">请启用浏览器 JavaScript 后刷新页面再登录。</p></noscript>
          </form>
        ) : (
          <div className="auth-form" aria-live="polite">
            <h1>授权查看运单</h1>
            <p className="auth-sub">
              {state.kind === "loading" ? "正在读取授权信息…" : state.kind === "done" ? "授权成功，正在回到财务系统…" : state.text}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
