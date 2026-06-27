import crypto from "node:crypto";

export interface AuthTokenPayload {
  userId: string;
  companyId: string;
  role: "admin" | "staff" | "client";
  userName: string;
  exp: number;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + "=".repeat(padLen), "base64");
}

function tokenSecret(): string {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret) {
    throw new Error("FATAL: AUTH_SECRET environment variable is required but not set. Generate a random key: openssl rand -base64 48");
  }
  return secret;
}

export function signAuthToken(input: {
  userId: string;
  companyId: string;
  role: "admin" | "staff" | "client";
  userName: string;
  expiresInSeconds?: number;
}): string {
  const header = { alg: "HS256", typ: "JWT" };
  const nowSec = Math.floor(Date.now() / 1000);
  const exp = nowSec + (input.expiresInSeconds ?? 7 * 24 * 60 * 60);
  const payload: AuthTokenPayload = {
    userId: input.userId,
    companyId: input.companyId,
    role: input.role,
    userName: input.userName,
    exp,
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const body = `${encodedHeader}.${encodedPayload}`;
  const sig = crypto.createHmac("sha256", tokenSecret()).update(body).digest();
  return `${body}.${base64UrlEncode(sig)}`;
}

export function verifyAuthToken(token: string): AuthTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSig] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSig) return null;

  const body = `${encodedHeader}.${encodedPayload}`;
  const expectedSig = crypto.createHmac("sha256", tokenSecret()).update(body).digest();
  const actualSig = base64UrlDecode(encodedSig);
  if (expectedSig.length !== actualSig.length) return null;
  if (!crypto.timingSafeEqual(expectedSig, actualSig)) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8")) as Partial<AuthTokenPayload>;
    if (!payload?.userId || !payload.companyId || !payload.role || !payload.exp) return null;
    if (payload.role !== "admin" && payload.role !== "staff" && payload.role !== "client") return null;
    if (Math.floor(Date.now() / 1000) >= payload.exp) return null;
    return {
      userId: payload.userId,
      companyId: payload.companyId,
      role: payload.role,
      userName: payload.userName ?? "",
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}
