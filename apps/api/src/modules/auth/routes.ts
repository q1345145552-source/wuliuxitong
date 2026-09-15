import type { MinimalHttpApp } from "../../server";
import { prisma } from "../../db/prisma";
import { fail, ok, requireAuth } from "../core/http-utils";
import { logger } from "../core/logger";
import {
  checkRateLimit,
  clearLoginFailures,
  getClientIp,
  loginRetryAfterMs,
  rateLimitKey,
  recordLoginFailure,
} from "../core/rate-limit";
import { signAuthToken, verifyAuthToken } from "./token";
import { revokeToken } from "../core/token-blacklist";
import { hashPassword, verifyPassword } from "./crypto-utils";
import { checkPasswordStrength } from "./password-policy";
import { isUserRole } from "../../../../../packages/shared-types/role";

/**
 * 注册鉴权路由（登录 + 注册）
 *
 * ⚠️ B-2 改造：内部已完全切换到 Prisma + PostgreSQL。
 * 第二个参数 `_db` 保留只是为了兼容 main.ts 的调用签名，不再使用。
 * 等所有模块迁移完成后会从签名中移除。
 */
export function registerAuthRoutes(app: MinimalHttpApp): void {
  app.post("/auth/login", async (req, res) => {
    // 速率限制：每个 IP 每分钟最多 10 次登录尝试
    const ip = getClientIp(req.headers);
    if (checkRateLimit(rateLimitKey(ip, "login"), 10, 60_000)) {
      // 2026-08-31 Codex 二轮：这条 429 前端会原样弹给用户，原来是英文，普通用户看不懂。
      // 2026-09-01 Codex 复核收尾：去掉「联系管理员重置密码」——重置密码清的是按账号的计数，
      // 清不掉这道按 IP 的闸，给的是无效办法；这道闸窗口只有 1 分钟，等一下就能再试。
      fail(res, 429, "BAD_REQUEST", "登录尝试次数过多，请 1 分钟后再试。");
      return;
    }
    // 2026-08-04：原来直接 body.account?.trim()，账号传成数字/数组/对象时
    // .trim 不是函数 → 抛异常 → 500（日志里 5 次 "body.account?.trim is not a function"）。
    // 登录是完全对公网开放的入口，任何人都能随手打崩它一次，必须先卡类型。
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const asStr = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
    const body = {
      account: asStr(raw.account),
      password: typeof raw.password === "string" ? raw.password : "",
      role: asStr(raw.role),
    };
    if (!body.account) {
      fail(res, 400, "BAD_REQUEST", "account is required");
      return;
    }

    /**
     * ⚠️ 第二道限流：按**被敲的那个账号**算（2026-08-29 新增，老板拍板 30 分钟 20 次）。
     *
     * 上面那道是按 IP 算的，换个 IP 计数就从 0 开始 —— 攻击者拿 100 台机器
     * 一起猜同一个账号，每台各 10 次都不超限，一天能试 144 万次，
     * 而系统全程不知道这个账号正在被猜。加上这道之后一天封顶 960 次。
     *
     * ⚠️ 账号按**原样**当键，**不许转小写**（2026-08-29 改，注释一并更正）。
     * 这里原来写的是「要统一大小写，不然换个大小写就是新计数桶」——
     * 那个理由不成立：攻击者拿错的大小写去猜，库里查不到这个人，
     * 不管密码对不对都是 401，得不到任何关于密码的信息，
     * 只能死磕正确的那个写法。而转小写反而开了个真洞：
     * 查库区分大小写、计数按小写，于是用 `Admin` **正常登录成功**
     * 就能把 `admin` 的失败计数清零。详见 core/rate-limit.ts 里那段。
     */
    const waitMs = loginRetryAfterMs(body.account);
    if (waitMs > 0) {
      const waitMin = Math.max(1, Math.ceil(waitMs / 60_000));
      fail(
        res,
        429,
        "BAD_REQUEST",
        `这个账号密码错太多次了，请 ${waitMin} 分钟后再试。着急的话联系管理员重置密码。`,
      );
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: body.account },
      select: {
        id: true,
        companyId: true,
        role: true,
        name: true,
        status: true,
        passwordHash: true,
      },
    });

    /**
     * ⚠️ **三个失败出口都要记一笔**，一个都不能漏。
     * 只在「密码错」那一处记的话，攻击者拿不存在的账号刷、或者用错的 role 刷，
     * 一次都不会被计数 —— 而那两条路照样能拿来试账号存不存在。
     */
    if (!user || user.status !== "active") {
      recordLoginFailure(body.account);
      fail(res, 401, "UNAUTHORIZED", "invalid credentials");
      return;
    }
    if (body.role && body.role !== user.role) {
      recordLoginFailure(body.account);
      fail(res, 401, "UNAUTHORIZED", "invalid credentials");
      return;
    }
    if (!verifyPassword(body.password, user.passwordHash)) {
      recordLoginFailure(body.account);
      fail(res, 401, "UNAUTHORIZED", "invalid credentials");
      return;
    }

    // 登录成功 → 把这个账号的失败计数清零。
    // 不清的话，白天陆续打错几次会一路累积到 20，最后把自己关在门外。
    clearLoginFailures(body.account);

    /**
     * ⚠️ 角色做运行时校验，不许 `as` 硬转（2026-09-16 加 agent 时改）。
     * 库里要是出现不认得的角色，签出去的令牌下一个请求就会被 token.ts 的硬闸拒掉，
     * 用户看到的是「登录成功又被踢回登录页」—— 不如在这里直接拒、并留日志。
     */
    if (!isUserRole(user.role)) {
      logger.warn("登录失败：账号角色不认得", { 账号: user.id, 角色: user.role });
      fail(res, 401, "UNAUTHORIZED", "invalid credentials");
      return;
    }

    const token = signAuthToken({
      userId: user.id,
      companyId: user.companyId,
      role: user.role,
      userName: user.name,
      // 把密码指纹写进令牌：以后改了密码，这张令牌立刻失效，不用等 7 天
      passwordHash: user.passwordHash,
    });

    ok(res, {
      token,
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        companyId: user.companyId,
      },
    });
  });

  app.post("/auth/register", async (req, res) => {
    fail(res, 403, "FORBIDDEN", "自助注册已关闭，请联系管理员");
  });

  /**
   * 退出登录：把这张令牌在服务器上作废（2026-08-31 新增，排查报告第 58 条）。
   *
   * 原来「退出账号」只是前端删本机凭证，服务器不知道 —— 令牌要是在退出前
   * 被人抄走，退出之后最长还能用 7 天。现在退出时先调这个接口，
   * 把令牌记进内存黑名单（TTL = 令牌自己的剩余有效期），之后再拿它来就是 401。
   *
   * ⚠️ 黑名单在进程内存里，API 一重启就清空 —— 这是有意的轻量方案，
   *    取舍写在 core/token-blacklist.ts 的文件头注释里。
   * ⚠️ 前端就算调它失败（断网等）也照样本地清凭证，退出流程不被卡住。
   */
  app.post("/auth/logout", async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    // 能走到这里说明令牌刚通过认证，这里再解一次只是为了拿原始令牌和它的 exp
    const authHeader = typeof req.headers.authorization === "string" ? req.headers.authorization.trim() : "";
    const token = authHeader.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
    const payload = token ? verifyAuthToken(token) : null;
    if (payload) {
      revokeToken(token, payload.exp);
      logger.info("退出登录，令牌已作废", { 账号: auth.userId, 角色: auth.role });
    }
    ok(res, { loggedOut: true });
  });

  /**
   * 改自己的密码（三端通用：管理员 / 员工 / 客户都能用）。
   *
   * 2026-08-07 新增。原来只有 /admin/users/set-password，而那个接口写死了
   * 「只准改 staff 和 client」—— 管理员自己的密码全系统没有任何入口能改。
   *
   * ⚠️ 必须验旧密码：光凭令牌就能改密码的话，令牌被人拿去 = 账号直接被夺走。
   */
  app.post("/auth/change-password", async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;

    // 限流按账号来，不按 IP：换 IP 就能继续猜旧密码的话，这道限流等于没有。
    if (checkRateLimit(rateLimitKey(auth.userId, "change-password"), 5, 60_000)) {
      fail(res, 429, "BAD_REQUEST", "改密码太频繁了，请一分钟后再试");
      return;
    }

    // 和登录接口同样的理由：字段传成数字/数组时 .trim 不是函数会直接 500。
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const oldPassword = typeof raw.oldPassword === "string" ? raw.oldPassword : "";
    const newPassword = typeof raw.newPassword === "string" ? raw.newPassword : "";
    if (!oldPassword || !newPassword) {
      fail(res, 400, "BAD_REQUEST", "请填写旧密码和新密码");
      return;
    }

    const invalidReason = checkPasswordStrength(newPassword, oldPassword, auth.userId);
    if (invalidReason) {
      fail(res, 400, "BAD_REQUEST", invalidReason);
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { id: true, status: true, passwordHash: true },
    });
    if (!user || user.status !== "active") {
      fail(res, 401, "UNAUTHORIZED", "账号状态异常，请重新登录");
      return;
    }
    if (!verifyPassword(oldPassword, user.passwordHash)) {
      // 故意不说「旧密码错」还是「账号不存在」之外的细节，但这里是本人操作，
      // 说清楚反而更好用，且已经有按账号限流兜底。
      logger.warn("改密码失败：旧密码不对", { 账号: auth.userId, 来源IP: getClientIp(req.headers) });
      fail(res, 400, "BAD_REQUEST", "旧密码不对");
      return;
    }

    await prisma.user.update({
      where: { id: auth.userId },
      data: { passwordHash: hashPassword(newPassword) },
    });

    /**
     * 改成功顺手把登录失败计数清零（2026-08-31，跟 /admin/users/set-password 同一口径）。
     * 不清的话：账号被连错锁着的人自己改完密码，拿新密码登录还是被旧计数挡回去。
     * 计数的键就是登录账号原样（登录按 user.id 查库），auth.userId 正是同一个桶。
     */
    clearLoginFailures(auth.userId);

    logger.warn("改密码成功", { 账号: auth.userId, 角色: auth.role });
    ok(res, { changed: true });
  });
}
