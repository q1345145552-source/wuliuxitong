import crypto from "node:crypto";
import { isUserRole, type UserRole } from "../../../../../packages/shared-types/role";

export interface AuthTokenPayload {
  userId: string;
  companyId: string;
  role: UserRole;
  userName: string;
  exp: number;
  /**
   * 密码指纹（2026-08-25 新增）。改了密码之后，旧令牌的这个值就对不上了，
   * 认证时会被拒掉 —— 不用等它自己 7 天后过期。
   * ⚠️ 这是拿 AUTH_SECRET 对密码哈希再算一次 HMAC 的前 16 位，
   *    反推不出密码，也反推不出密码哈希。
   * ⚠️ 老令牌里没有这个字段，那种一律放行（它们最多 7 天就自己过期了），
   *    否则这次上线会把所有人当场踢下线。
   */
  pv?: string;
  /**
   * 随机令牌编号（2026-08-31 Codex 复核）。exp 只精确到秒，原来同一个人
   * 同一秒登录两次拿到的是**一模一样**的两张令牌 —— 黑名单按令牌本身记，
   * 退出旧标签页会把同秒刚登录拿到的新令牌一起拉黑。
   * 加 8 字节随机数保证每张令牌都不同。
   * ⚠️ 校验端**不要求**这个字段：老令牌里没有，得让它们活到自己过期。
   */
  jti?: string;
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

/**
 * 由密码哈希算出的指纹，放进令牌用来判断「密码是不是换过了」。
 * 用 HMAC 而不是直接哈希：令牌内容客户端能看见，直接放密码哈希的摘要不合适。
 */
export function passwordFingerprint(passwordHash: string | null | undefined): string {
  return crypto
    .createHmac("sha256", tokenSecret())
    .update(`pw:${passwordHash ?? ""}`)
    .digest("base64url")
    .slice(0, 16);
}

export function signAuthToken(input: {
  userId: string;
  companyId: string;
  role: UserRole;
  userName: string;
  expiresInSeconds?: number;
  /** 传了就把密码指纹写进令牌；改密码后旧令牌立刻失效 */
  passwordHash?: string | null;
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
    // 2026-08-31 Codex 复核：随机编号，保证同一秒签发的两张令牌也不相同（见 jti 字段注释）
    jti: crypto.randomBytes(8).toString("hex"),
    ...(input.passwordHash === undefined ? {} : { pv: passwordFingerprint(input.passwordHash) }),
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const body = `${encodedHeader}.${encodedPayload}`;
  const sig = crypto.createHmac("sha256", tokenSecret()).update(body).digest();
  return `${body}.${base64UrlEncode(sig)}`;
}

/**
 * 令牌为什么没通过 —— 只用来写日志，不参与任何判断。
 * 2026-08-07 加：原来认证失败一条日志都不记，出问题只能靠猜
 * （连续两次"莫名其妙被踢回登录页"查不出原因）。
 * ⚠️ 只返回原因，绝不返回令牌内容本身。
 */
export function describeTokenFailure(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) return "格式不对（不是三段）";
  const [encodedHeader, encodedPayload, encodedSig] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSig) return "格式不对（有空段）";
  try {
    const body = `${encodedHeader}.${encodedPayload}`;
    const expectedSig = crypto.createHmac("sha256", tokenSecret()).update(body).digest();
    const actualSig = base64UrlDecode(encodedSig);
    if (expectedSig.length !== actualSig.length || !crypto.timingSafeEqual(expectedSig, actualSig)) {
      return "签名对不上（密钥变了 / 令牌被改过）";
    }
  } catch {
    return "签名校验时报错";
  }
  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8")) as Partial<AuthTokenPayload>;
    if (!payload?.userId || !payload.companyId || !payload.role || !payload.exp) return "内容缺字段";
    const now = Math.floor(Date.now() / 1000);
    if (now >= payload.exp) return `已过期（过期于 ${new Date(payload.exp * 1000).toISOString()}，现在 ${new Date().toISOString()}）`;
    return "未知原因";
  } catch {
    return "内容解析失败";
  }
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
    /**
     * ⚠️ 角色硬闸（2026-09-16 加 agent）：不认得的角色一律当没登录。
     * 漏加 agent 的话，代理登录成功后下一个请求就被踢回登录页。
     */
    if (!isUserRole(payload.role)) return null;
    if (Math.floor(Date.now() / 1000) >= payload.exp) return null;
    return {
      pv: payload.pv,
      // 2026-08-31 Codex 复核：jti 原样带出但**不校验有无** —— 老令牌没有这个字段，要放行
      jti: payload.jti,
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
