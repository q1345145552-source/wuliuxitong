/**
 * ⚠️ 禁库硬闸：这个脚本只测令牌签发 / 校验 / 退出黑名单，不许连数据库。
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";
process.env.AUTH_SECRET = "test-only-secret-for-this-script";

/**
 * 2026-10-23 安全审查 S1：退出登录后，拿着旧令牌「换个写法」还能用。
 *
 * 成因：base64 解码很宽容（签名段后面补 `=`、夹空格 / `!`、`-` 换成 `+`、尾巴上没用的位改一改，
 * 解出来都是同一串字节，验签照过），而退出黑名单按**令牌原文**记 —— 换个写法就对不上。
 * 修法（token.ts isCanonicalBase64Url）：三段都必须是系统自己签出来的那种标准写法，否则当没登录。
 *
 * 这里守两件事：
 *   ① 正常签出来的令牌（含 08-25 / 08-31 以前没有 pv、jti 的老令牌）一张都不许误杀；
 *   ② 一张令牌只有一种写法能过验签 —— 退出拉黑了原文，就没有别的写法能绕过去。
 * 整条 HTTP 链路（真退出接口 + 真认证闸）在 test-logout-variants-db.ts 里测。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describeTokenFailure, signAuthToken, verifyAuthToken } from "../apps/api/src/modules/auth/token";
import { isTokenRevoked, revokeToken } from "../apps/api/src/modules/core/token-blacklist";

const failures: string[] = [];
function check(name: string, body: () => void): void {
  try {
    body();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(name);
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${message.split("\n").join("\n     ")}`);
  }
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const NON_CANONICAL = "编码不规范（不是系统签出来的写法，可能被改过）";
const WHO = { userId: "u_canon", companyId: "c_canon", role: "client" as const, userName: "规范写法" };

/** 签名里带 - 或 _ 的令牌（换成标准 base64 的 + / 才有东西可换）；随机的，几次就能碰上 */
function tokenWithUrlChars(): string {
  for (let i = 0; i < 200; i += 1) {
    const t = signAuthToken(WHO);
    if (/[-_]/.test(t.split(".")[2])) return t;
  }
  throw new Error("签了 200 张都没有 - / _，环境不对");
}

/** 末位还有没用上的位时，把这些位改掉（解出来字节不变）；没有空位就返回 null */
function twiddleTrailingBits(segment: string): string | null {
  const spare = [0, 0, 4, 2][segment.length % 4]; // 余 2 个字符 → 4 位空着；余 3 → 2 位
  if (!spare) return null;
  const idx = ALPHABET.indexOf(segment.slice(-1));
  const mask = (1 << spare) - 1;
  return segment.slice(0, -1) + ALPHABET[(idx & ~mask) | ((idx + 1) & mask)];
}

/** 同一张令牌的各种「换写法」：旧代码下这些全都能过验签（10-23 本地实测） */
function sigVariants(token: string): Record<string, string> {
  const [h, p, s] = token.split(".");
  const swapped = s.replace(/-/g, "+").replace(/_/g, "/");
  const out: Record<string, string> = {
    "签名补 =": `${h}.${p}.${s}=`,
    "签名补 ==": `${h}.${p}.${s}==`,
    "签名后加 !": `${h}.${p}.${s}!`,
    "签名中间夹空格": `${h}.${p}.${s.slice(0, 10)} ${s.slice(10)}`,
    "签名中间夹 tab": `${h}.${p}.${s.slice(0, 10)}\t${s.slice(10)}`,
    "签名中间夹 %": `${h}.${p}.${s.slice(0, 5)}%${s.slice(5)}`,
  };
  if (swapped !== s) out["签名 -_ 换成 +/"] = `${h}.${p}.${swapped}`;
  const tw = twiddleTrailingBits(s);
  if (tw) out["签名末位没用的位改掉"] = `${h}.${p}.${tw}`;
  return out;
}

function main(): void {
  console.log("【正常令牌不许误杀】");

  check("1) 500 张正常签发的令牌（各种名字长度 / 角色 / 带不带密码指纹）全部验得过", () => {
    const roles = ["admin", "staff", "client", "agent"] as const;
    for (let i = 0; i < 500; i += 1) {
      const t = signAuthToken({
        userId: `u${"x".repeat(i % 7)}`,
        companyId: "c",
        role: roles[i % roles.length],
        userName: "名".repeat(i % 31) + "a".repeat(i % 5),
        ...(i % 2 ? { passwordHash: `hash-${i}` } : {}),
      });
      assert.ok(verifyAuthToken(t), `第 ${i} 张正常令牌被拒：${describeTokenFailure(t)}`);
    }
  });

  check("2) 老令牌（08-25 / 08-31 以前签的，没有 pv、jti）照样验得过", () => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
    const exp = Math.floor(Date.now() / 1000) + 3600;
    for (const userName of ["", "a", "ab", "老客户", "老客户两个"]) {
      const body = `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ userId: "u_old", companyId: "c", role: "staff", userName, exp })}`;
      const sig = crypto.createHmac("sha256", process.env.AUTH_SECRET!).update(body).digest("base64url");
      const p = verifyAuthToken(`${body}.${sig}`);
      assert.ok(p, `名字「${userName}」的老令牌被拒：${describeTokenFailure(`${body}.${sig}`)}`);
      assert.equal(p!.jti, undefined);
      assert.equal(p!.pv, undefined);
    }
  });

  console.log("\n【一张令牌只有一种写法】");

  check("3) 签名换写法（补 = / 加 ! / 夹空格 / 换字母表 / 改末位空位）一律验不过，日志原因写「编码不规范」", () => {
    const t = tokenWithUrlChars();
    const variants = sigVariants(t);
    assert.ok(Object.keys(variants).length >= 8, `换写法只凑出 ${Object.keys(variants).length} 种，没测全`);
    for (const [name, v] of Object.entries(variants)) {
      assert.notEqual(v, t);
      assert.equal(verifyAuthToken(v), null, `「${name}」居然验过了`);
      assert.equal(describeTokenFailure(v), NON_CANONICAL, `「${name}」日志原因不对`);
    }
  });

  /* 头、内容两段本来就签在签名里（改一个字签名就对不上），这一项不靠这次的修复也会过；
     所以连日志原因一起核 —— 原因得是「编码不规范」，说明是新那道先挡下的（审查 10-23 指出原来这项是假绿） */
  check("4) 头、内容两段换写法也验不过，而且是「编码不规范」那道先挡下（补 = / 换字母表 / 改末位空位）", () => {
    let tried = 0;
    for (let i = 0; i < 50; i += 1) {
      const t = signAuthToken({ ...WHO, userName: "x".repeat(i) });
      const [h, p, s] = t.split(".");
      const cands = [`${h}=.${p}.${s}`, `${h}.${p}=.${s}`, `${h}.${p.replace(/-/g, "+").replace(/_/g, "/")}.${s}`];
      const tw = twiddleTrailingBits(p);
      if (tw) cands.push(`${h}.${tw}.${s}`);
      for (const v of cands) {
        if (v === t) continue;
        tried += 1;
        assert.equal(verifyAuthToken(v), null, `第 ${i} 张的变体验过了：${v.slice(0, 40)}…`);
        assert.equal(describeTokenFailure(v), NON_CANONICAL, `第 ${i} 张的变体不是被「编码不规范」挡下的`);
      }
    }
    assert.ok(tried > 100, `只试了 ${tried} 个变体`);
  });

  check("5) 穷举：签名后面加任何一个可见字符 / 空格、末位换成任何别的字符 —— 只有原文能过", () => {
    const t = signAuthToken(WHO);
    const [h, p, s] = t.split(".");
    let passed = 0;
    for (let c = 32; c < 127; c += 1) {
      const ch = String.fromCharCode(c);
      for (const v of [`${t}${ch}`, `${h}.${p}.${s.slice(0, 20)}${ch}${s.slice(20)}`]) {
        if (verifyAuthToken(v)) passed += 1;
      }
    }
    for (const ch of ALPHABET) {
      const v = `${h}.${p}.${s.slice(0, -1)}${ch}`;
      if (v !== t && verifyAuthToken(v)) passed += 1;
    }
    assert.equal(passed, 0, `有 ${passed} 种别的写法验过了`);
    assert.ok(verifyAuthToken(t), "原文自己反而验不过");
  });

  check("6) 退出拉黑原文后：原文查得到已作废，所有换写法都过不了验签（两道闸至少挡一道）", () => {
    const t = tokenWithUrlChars();
    const p = verifyAuthToken(t);
    assert.ok(p);
    revokeToken(t, p!.exp);
    assert.equal(isTokenRevoked(t), true);
    for (const [name, v] of Object.entries(sigVariants(t))) {
      const slipsThrough = verifyAuthToken(v) !== null && !isTokenRevoked(v);
      assert.equal(slipsThrough, false, `退出后「${name}」还能用`);
    }
    // 同一个人刚签的另一张不受连累（08-31 jti 那条规矩不能被这次改坏）
    const other = signAuthToken(WHO);
    assert.ok(verifyAuthToken(other));
    assert.equal(isTokenRevoked(other), false);
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length}/6 项不通过：${failures.join("；")}`);
    process.exit(1);
  }
  console.log("\n令牌标准写法：6 项全部通过");
}

main();
