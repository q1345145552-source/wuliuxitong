export type AuthRole = "admin" | "staff" | "client";

export interface AuthSession {
  userId: string;
  companyId: string;
  role: AuthRole;
  token: string;
}

const SESSION_KEY = "auth_session_v1";

export function getOptionalSession(): AuthSession | null {
  if (typeof window === "undefined") return null;
  let raw = window.localStorage.getItem(SESSION_KEY);
  // 兼容旧 key 无缝迁移
  if (!raw) {
    const oldRaw = window.localStorage.getItem("mock_session_v1");
    if (oldRaw) {
      window.localStorage.setItem(SESSION_KEY, oldRaw);
      window.localStorage.removeItem("mock_session_v1");
      raw = oldRaw;
    }
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AuthSession;
    if (!parsed?.role || !parsed.userId || !parsed.companyId || !parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function setAuthSession(session: AuthSession): AuthSession {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }
  return session;
}

export function clearAuthSession(): void {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(SESSION_KEY);
  }
}
