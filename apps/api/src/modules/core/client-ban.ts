/**
 * 封禁的客户唛头不许再挂新单（2026-10-17 老板问「为什么客户账号已经封禁了，还是能加进去运单？」，选 A）。
 *
 * 封禁原来只管登录（users.status 不是 active 就登不进来），建单、到货通知、整柜、超管改唛头都不看它，
 * 所以封了的唛头照样能被选上、挂上新单。现在这几处遇到封禁的唛头一律拦下：
 *   - 新建：员工 / 超管「创建订单」（批量导入也走这条）、到货通知新登记、到货通知转运单时新建一张、整柜建单；
 *   - 把唛头**换成**封禁的那个：超管「运单管理」改唛头、到货通知改唛头（待入库那张运单跟着换）、整柜改唛头。
 * 已经挂在封禁唛头名下的单不动：不换唛头的修改、装柜、派送、待入库转正式（还是同一张运单）、预报单确认收货照常走。
 *
 * 跟「封禁 / 解封」排队（2026-10-17 dsh 审查）：光在事务里读一下状态不够 —— 挂单的事务读到「没封」以后、提交之前，
 * 超管那边封禁先提交了，这张单照样落在封禁唛头名下（订单外键对客户行拿的锁跟改 status 不冲突，也不会碰巧排上队）。
 * 所以两边拿同一把锁（按 公司 + 唛头 一把，到事务提交才放），分两档：
 *   - 挂单这边拿「共享」档（assertClientNotBanned）：挂单之间互不排队（同一个客户同时建好几张照常），只跟封禁那一下排队；
 *     在各条路**已经拿完自己的锁之后**再拿它、拿到再读状态。
 *     放锁序最后一环是为了不动原来的锁序（号锁 → 通知 / 柜 → 运单 → 订单）：拿到它以后只写自己这张单（已经锁住）和新插的行，
 *     别的挂单事务也都是拿完自己的行锁才来等它，不会有谁先握着这张单的行再来等这把锁，绕不成圈。
 *   - 封禁这边拿「独占」档（lockClientBan，admin/routes.ts /admin/users/toggle-ban），**只「试」不排队**：
 *     pg_try_advisory_xact_lock，拿不到隔 0.1 秒再试，最多试 CLIENT_BAN_WAIT_MS（10 秒），拿不到回 409 叫他过几秒再点；
 *     拿到以后再锁客户那一行写 status（最多等 CLIENT_BAN_ROW_WAIT 1 秒，等不到也 409），然后提交。
 *     为什么不直接排队（Codex / dsh 第 3 轮）：PostgreSQL 为了不饿死排队的独占锁，会让后来的共享锁排在它后面 ——
 *     封禁一旦排上队，同一个客户新来的挂单全被挡在后面，挂单事务默认 5 秒就超时报 500。只「试」的话封禁从来不在队里，
 *     拿着独占的时间最多 1 秒（等客户行），后来的挂单最多等这 1 秒。
 *     为什么试锁期间不先锁客户行（dsh 第 4 轮）：试锁最长 10 秒，这期间锁着客户行，同一客户存收货地址、发客服消息、改运费配置
 *     （都要锁这一行、事务默认 5 秒）就会超时报 500。
 * 结果：挂单先拿到 → 封禁等它提交（这张单算封禁前挂的）；封禁先拿到 → 挂单等封禁提交后再读，读到「已封禁」拦下。
 */
import type { Prisma } from "@prisma/client";
import { BusinessError } from "./business-error";

/** 拦下时给人看的那句（员工、超管都会看到）。老板 2026-10-17 定的：「提示说账号已封禁」—— 就这几个字，页面上那句一样（web 的 BANNED_MARK_HINT） */
export const BANNED_CLIENT_MESSAGE = "账号已封禁";

/** 跟登录同一个口径（auth/routes.ts、session-guard.ts）：不是 active 就算封禁 */
export function isBannedStatus(status: string): boolean {
  return status !== "active";
}

/** 封禁那一边最多试多久拿独占锁（理由见文件头） */
export const CLIENT_BAN_WAIT_MS = 10000;
/** 拿到独占锁以后，等客户那一行最多等多久（拿着独占锁等，后来的挂单跟着等，所以要远短于挂单事务默认的 5 秒；
 *  挂单可能已经在自己前面的锁上花了几秒，这 1 秒是加在后面的 —— Codex / dsh 第 5 轮从 2 秒缩到 1 秒） */
export const CLIENT_BAN_ROW_WAIT = "1s";
/** 封禁那个事务的时限：比上面多留 5 秒给写 status、提交（Prisma 默认 5 秒不够）。前端账号写操作自己等 30 秒，留够余量 */
export const CLIENT_BAN_TX = { timeout: 15000, maxWait: 5000 } as const;
/** 封禁拿不到锁时给超管看的话 */
export const CLIENT_BAN_BUSY_MESSAGE = "刚好有同事正在给这个客户建单 / 改单，这次没改成，过几秒再点一次";

/**
 * 「封禁 / 解封」那一边：独占档，只试不排队（公司 + 唛头一把；必须在事务里调，拿到了到提交才放）。编号 83070 全仓没别人用。
 * 拿不到隔 0.1 秒再试，试到 waitMs 还拿不到抛 409（BusinessError，事务跟着回滚，status 不变）。
 */
export async function lockClientBan(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">, companyId: string, clientId: string, waitMs: number = CLIENT_BAN_WAIT_MS,
): Promise<void> {
  const until = Date.now() + waitMs;
  for (;;) {
    const r = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT pg_try_advisory_xact_lock(83070, hashtext(${`${companyId}:${clientId}`})) AS ok`;
    if (r[0]?.ok) return;
    if (Date.now() >= until) throw new BusinessError(CLIENT_BAN_BUSY_MESSAGE, 409, "VALIDATION_ERROR");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * 挂单那一边：先拿同一把锁的共享档，再读 —— 这个唛头是本公司的客户、而且封禁了 → 抛 400。
 * 必须在挂单那个事务里、各条路自己的锁都拿完以后调（理由见文件头）。
 * 不存在 / 别家公司 / 不是客户的不在这里管（各条路原来的「唛头不存在」那道检查管），这里直接放过。
 * message：客户自己报预报单那条路给客户看的话不一样（不提超管、客户管理）。
 */
export async function assertClientNotBanned(
  tx: Pick<Prisma.TransactionClient, "user" | "$executeRaw">, companyId: string, clientId: string, message?: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(83070, hashtext(${`${companyId}:${clientId}`}))`;
  const u = await tx.user.findFirst({ where: { id: clientId, companyId, role: "client" }, select: { status: true } });
  if (u && isBannedStatus(u.status)) throw new BusinessError(message ?? BANNED_CLIENT_MESSAGE);
}
