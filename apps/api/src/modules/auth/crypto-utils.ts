import crypto from "node:crypto";

/**
 * 统一使用 scrypt 生成密码哈希（含随机盐）。
 * 格式：scrypt$N$r$p$base64(salt)$base64(derived)
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const cost = 16384;
  const blockSize = 8;
  const parallelization = 1;
  const keyLen = 64;
  const derived = crypto.scryptSync(password, salt, keyLen, { N: cost, r: blockSize, p: parallelization });
  return `scrypt$${cost}$${blockSize}$${parallelization}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

/**
 * 验证密码（兼容 scrypt 和旧版 SHA-256 哈希）。
 */
export function verifyPassword(password: string, passwordHash: string | null): boolean {
  if (!passwordHash) return false;
  if (passwordHash.startsWith("scrypt$")) {
    const parts = passwordHash.split("$");
    if (parts.length !== 6) return false;
    const [, nRaw, rRaw, pRaw, saltBase64, hashBase64] = parts;
    const n = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    if (!saltBase64 || !hashBase64 || Number.isNaN(n) || Number.isNaN(r) || Number.isNaN(p)) return false;
    try {
      const salt = Buffer.from(saltBase64, "base64");
      const expected = Buffer.from(hashBase64, "base64");
      const actual = crypto.scryptSync(password, salt, expected.length, { N: n, r, p });
      if (actual.length !== expected.length) return false;
      return crypto.timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }
  // 向后兼容旧版 SHA-256 哈希
  const legacy = crypto.createHash("sha256").update(password, "utf8").digest("hex");
  return legacy === passwordHash;
}
