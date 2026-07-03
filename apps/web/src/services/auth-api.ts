import { apiBaseUrl, apiRequest } from "./core-api";

export function login(payload: { account: string; password: string; role?: "admin" | "staff" | "client" }) {
  return apiRequest<{ token: string; user: { id: string; name: string; role: "admin" | "staff" | "client"; companyId: string } }>(
    `${apiBaseUrl()}/auth/login`, { method: "POST", body: JSON.stringify(payload) }
  );
}

export function registerClient(payload: { account: string; password: string; name: string; phone: string; companyId?: string; companyName?: string; email?: string }) {
  return apiRequest<{ token: string; user: { id: string; name: string; role: "client"; companyId: string } }>(
    `${apiBaseUrl()}/auth/register`, { method: "POST", body: JSON.stringify(payload) }
  );
}
