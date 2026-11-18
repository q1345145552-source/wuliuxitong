/* ==========================================================================
   接口专用密钥：只存指纹、定长比较、同时认新旧两把（2026-11-19，财务系统2 对接用）
   --------------------------------------------------------------------------
   约定 1.1：密钥放 `Authorization: Bearer <密钥>`；收的一方只存密钥的 sha256 指纹，比对用定长比较；
   密钥不写进代码、不进 git、不打进日志；换密钥期间新旧两把都认。

   ⚠️ 这个文件是**通用**的，不绑财务系统2：放货拦截（第 9 期）那边以后要收别的系统来的请求，也用这里的
      readKeyFingerprints + bearerKeyMatchesAny，自己挑两个环境变量名就行。
      反过来「物流去拉财务的名单」带的是对方发的明文密钥，那把要原样发出去，不归这里管。

   环境变量里放的是**指纹**（64 位小写十六进制），不是密钥本身：服务器上的 .env 泄露了也拿不到能用的密钥。
   生成一把：node scripts/finance2-make-key.ts（打印密钥和它的指纹；密钥交给对方，指纹填进 .env）。
   ========================================================================== */
import { createHash, timingSafeEqual } from "node:crypto";

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
/** 送来的密钥超过这么长就不算了，免得有人塞几兆进来让服务器算哈希 */
const KEY_MAX_LEN = 512;

export function sha256HexOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export type FingerprintsResult = { ok: true; fingerprints: Buffer[] } | { ok: false; reason: string };

/**
 * 从环境变量读指纹。names 依次是「现在这把」「上一把（换密钥期间才填）」……
 * 第一个必须填；后面的可以空着。填了但格式不对、或者两把一样，整个按不合格处理（宁可全拒，不猜）。
 */
export function readKeyFingerprints(env: NodeJS.ProcessEnv, names: readonly string[]): FingerprintsResult {
  const fingerprints: Buffer[] = [];
  for (const [i, name] of names.entries()) {
    const raw = env[name];
    if (raw === undefined || raw === "") {
      if (i === 0) return { ok: false, reason: `${name} 没填` };
      continue;
    }
    if (!FINGERPRINT_RE.test(raw)) return { ok: false, reason: `${name} 不是 64 位小写十六进制的 sha256 指纹（填的是指纹，不是密钥本身）` };
    fingerprints.push(Buffer.from(raw, "hex"));
  }
  const unique = new Set(fingerprints.map((b) => b.toString("hex")));
  if (unique.size !== fingerprints.length) return { ok: false, reason: `${names.join(" / ")} 不能填同一把` };
  return { ok: true, fingerprints };
}

/**
 * 请求头里的 Bearer 密钥对不对得上任何一把指纹。
 * 每一把都比一遍（不在第一把对上时提前结束），比的是定长的 32 字节哈希。
 */
export function bearerKeyMatchesAny(header: unknown, fingerprints: readonly Buffer[]): boolean {
  if (typeof header !== "string" || fingerprints.length === 0) return false;
  const m = /^Bearer ([^\s]+)$/.exec(header.trim());
  if (!m || m[1].length > KEY_MAX_LEN) return false;
  const given = createHash("sha256").update(m[1], "utf8").digest();
  let matched = false;
  for (const fp of fingerprints) {
    if (fp.length === given.length && timingSafeEqual(fp, given)) matched = true;
  }
  return matched;
}
