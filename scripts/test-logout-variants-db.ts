/**
 * 2026-10-23 安全审查 S1：退出登录不彻底 —— 真 HTTP 服务（createApp）+ 真退出接口 + 真库。
 *
 * 原来：退出后原令牌 401，可签名段后面补个 `=`、加个 `!` 再发，照样 200（本地一次性库实测）。
 * 现在：令牌三段必须是系统自己签出来的标准写法（token.ts isCanonicalBase64Url），换写法一律当没登录。
 * 令牌层面的穷举在 test-token-canonical.ts，这里测整条链路：
 *   L1 正常令牌照常能用；换写法不管退没退出都进不来、也不能拿来退出
 *   L2 退出后原令牌和各种换写法全 401；同一秒刚登录的另一张令牌照常能用
 *   L3 改密码、封号这两道老闸照旧有效（换写法同样挡住）
 *
 * 只连一次性库：DATABASE_URL 不是 Neon 时要 AGENT_PORTAL_TEST_ALLOW_DB=1。测试数据前缀 zz_lgv_，跑完清到 0。
 */
process.env.TZ = process.env.TZ || "UTC";
process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-only-secret-for-this-script";
import assert from "node:assert/strict";
import net from "node:net";
import type { AddressInfo } from "node:net";

const CO = "zz_lgv_co";
const CLIENT_ID = "ZZLGV1";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => { const p = (srv.address() as AddressInfo).port; srv.close(() => resolve(p)); });
  });
}

/** 同一张令牌的几种换写法（旧代码下全能过验签） */
function variants(token: string): Record<string, string> {
  const [h, p, s] = token.split(".");
  const out: Record<string, string> = {
    "签名补 =": `${h}.${p}.${s}=`,
    "签名后加 !": `${h}.${p}.${s}!`,
    "签名中间夹空格": `${h}.${p}.${s.slice(0, 10)} ${s.slice(10)}`,
  };
  const swapped = s.replace(/-/g, "+").replace(/_/g, "/");
  if (swapped !== s) out["签名 -_ 换成 +/"] = `${h}.${p}.${swapped}`;
  return out;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url || url.includes("blocked")) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  if (!url.includes("neon.tech") && process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：DATABASE_URL 不是 Neon 测试库，怕连到生产库不跑（确认是测试库可设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测");
    return;
  }
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  process.env.BIND_HOST = "127.0.0.1";
  const { prisma } = await import("../apps/api/src/db/prisma");
  const { signAuthToken, verifyAuthToken } = await import("../apps/api/src/modules/auth/token");
  const { ok, requireAuth } = await import("../apps/api/src/modules/core/http-utils");
  const { createApp } = await import("../apps/api/src/server");
  const pm: any = prisma;

  const app = createApp();
  (await import("../apps/api/src/modules/auth/routes")).registerAuthRoutes(app);
  (await import("../apps/api/src/modules/orders/routes")).registerOrderRoutes(app);
  // 走 requireAuth 的最小接口：认得出是谁就 200
  app.get("/zz-lgv/whoami", async (req, res) => { const a = requireAuth(req, res); if (a) ok(res, { userId: a.userId }); });
  const port = await freePort();
  await new Promise<void>((resolve) => app.listen(port, () => resolve()));
  const base = `http://127.0.0.1:${port}`;

  const get = async (path: string, token: string) => {
    const r = await fetch(base + path, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    await r.text();
    return r.status;
  };
  const logout = async (token: string) => {
    const r = await fetch(`${base}/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10_000) });
    await r.text();
    return r.status;
  };
  /** 两个接口（自己的最小接口 + 真的客户订单列表）都得是同一个结果 */
  const both = async (token: string) => [await get("/zz-lgv/whoami", token), await get("/client/orders", token)];

  let failures = 0;
  async function test(name: string, body: () => Promise<void>): Promise<void> {
    try { await body(); console.log(`  ✅ ${name}`); }
    catch (e) { failures += 1; console.log(`  ❌ ${name}\n     ${(e instanceof Error ? e.message : String(e)).split("\n").join("\n     ")}`); }
  }
  async function cleanup(): Promise<void> {
    await pm.user.deleteMany({ where: { companyId: CO } });
  }

  console.log("退出登录换写法（真 HTTP + 真库）");
  try {
    await cleanup();
    const hashA = "zz-lgv-hash-a";
    await pm.user.create({ data: { id: CLIENT_ID, companyId: CO, role: "client", name: "退出测试客户", phone: "000", status: "active", passwordHash: hashA } });
    const sign = (passwordHash: string) => signAuthToken({ userId: CLIENT_ID, companyId: CO, role: "client", userName: CLIENT_ID, passwordHash, expiresInSeconds: 600 });

    // T1、T2 落在同一秒（exp 相同）才测得到「退出一张不连累另一张」
    let t1 = ""; let t2 = "";
    for (let i = 0; i < 10; i += 1) {
      t1 = sign(hashA); t2 = sign(hashA);
      if (verifyAuthToken(t1)?.exp === verifyAuthToken(t2)?.exp) break;
    }
    assert.equal(verifyAuthToken(t1)?.exp, verifyAuthToken(t2)?.exp, "试了 10 次都没落在同一秒");

    await test("L1 正常令牌两个接口都 200；换写法不管退没退出都 401、拿换写法去退出也 401（原令牌不受影响）", async () => {
      assert.deepEqual(await both(t1), [200, 200]);
      for (const [name, v] of Object.entries(variants(t1))) {
        assert.deepEqual(await both(v), [401, 401], `退出前「${name}」`);
        assert.equal(await logout(v), 401, `拿「${name}」退出`);
      }
      assert.deepEqual(await both(t1), [200, 200], "拿换写法退出居然把原令牌作废了");
    });

    await test("L2 退出后：原令牌和每种换写法都 401（原来补 = / 加 ! 是 200）；同秒的另一张照常 200", async () => {
      assert.equal(await logout(t1), 200);
      assert.deepEqual(await both(t1), [401, 401], "原令牌");
      for (const [name, v] of Object.entries(variants(t1))) assert.deepEqual(await both(v), [401, 401], `退出后「${name}」`);
      assert.deepEqual(await both(t2), [200, 200], "同秒的另一张被连累了");
    });

    await test("L3 改密码后旧令牌连同换写法 401；新密码签的令牌 200；封号后它和换写法也 401", async () => {
      const hashB = "zz-lgv-hash-b";
      await pm.user.update({ where: { id: CLIENT_ID }, data: { passwordHash: hashB } });
      assert.deepEqual(await both(t2), [401, 401], "改密码后旧令牌");
      for (const [name, v] of Object.entries(variants(t2))) assert.deepEqual(await both(v), [401, 401], `改密码后「${name}」`);
      const t3 = sign(hashB);
      assert.deepEqual(await both(t3), [200, 200], "新密码签的令牌");
      await pm.user.update({ where: { id: CLIENT_ID }, data: { status: "inactive" } });
      assert.deepEqual(await both(t3), [401, 401], "封号后");
      for (const [name, v] of Object.entries(variants(t3))) assert.deepEqual(await both(v), [401, 401], `封号后「${name}」`);
    });
  } catch (e) {
    failures += 1;
    console.log(`  ❌ 中途出错，后面没跑完：${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  } finally {
    await cleanup();
    const left = await pm.user.count({ where: { companyId: CO } });
    if (left) { failures += 1; console.log(`  ❌ 测试数据没清干净：还剩 ${left} 个账号`); }
    await prisma.$disconnect();
  }
  if (failures) { console.error(`\n${failures} 项不通过`); process.exit(1); }
  console.log("\n退出登录换写法：3 项全部通过");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
