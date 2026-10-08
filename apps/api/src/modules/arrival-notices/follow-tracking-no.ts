import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { logger } from "../core/logger";

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * 「运单管理改号」和「到货通知登记 / 改号」按**同一个号**排队（2026-10-08 修复第 3 轮）。
 *
 * 为什么要有：运单号在两张表里各有唯一约束（shipments.tracking_no、arrival_notices 的公司 + 运单号），
 * 两张表之间没有共同的约束。改号那边查「到货通知占没占这个号」、登记那边查「运单表有没有这个号」，
 * 两边同一瞬间各查各的、都赶在对方写入之前查完，就都放行了 —— 运单是 X、另一条没转的到货通知也是 X，
 * 那条从此转不了，转出这张运单的那条也跟不上新号（实测 Promise.all 同时发，15 次里 14~15 次两边都存上）。
 *
 * 做法：两边都在**各自事务的第一句**拿这把锁（拿之前不持有任何行锁），拿到以后在事务里重查对方的表再写。
 * pg_advisory_xact_lock 到事务提交才放：后到的那一边醒来时，先到的已经提交，重查一定看得见。
 * 不碰行锁：拿锁时手里什么都没有，所以跟「订单 → 运单」「到货通知 → 订单 → 运单」两种锁序都不会互相等成死锁（第 35 条②）。
 * 第一个参数 83050 是这把锁的命名空间（跟 83040 客服会话那把一样用两个 int 的写法，不跟别的锁撞）；
 * 号用 hashtext 折成 int，不同的号偶尔折到同一个值只会多等一下，不会出错。
 * 锁键只有号、不带公司（修复第 4 轮）：shipments.tracking_no 全库唯一，别家登记 X 和本公司改号成 X 也得排队，
 * 原来带着公司各排各的，两家同一瞬间一个登记、一个改号，10 次 10 次两边都存上。
 */
export async function lockTrackingNoForArrivalNotice(tx: Prisma.TransactionClient, trackingNo: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(83050, hashtext(${trackingNo}))`;
}

/**
 * 改号前先问一句：新号是不是被同公司**另一条**到货通知登记着（2026-10-08 修复第 1 轮）。
 * 「另一条」= 还没转运单的，或者转出的不是这几张运单（ownShipmentIds）的。
 *
 * 不挡的话：改号放行（两条改号路原来只查 shipments 表），followShipmentTrackingNos 撞唯一约束跳过，
 * 那条没转的到货通知再点转运单永远提示「已经有运单了」，按新号在到货通知里也只搜得到它、搜不到真转出这张运单的那条。
 * 返回给员工看的那句话；没被占返回 null。只在号真的要变时调，号没变不拦别的修改。
 * 两条改号路各调两次：事务前用 prisma 先查一遍（早点给个提示），事务里拿了 lockTrackingNoForArrivalNotice 以后用 tx 再查一遍（说了算的那次，修复第 3 轮）。
 *
 * 别家公司的也要查（修复第 4 轮）：运单号全库唯一（shipments.tracking_no @unique），别家一条还没转的到货通知登记着 X，
 * 本公司把运单改成 X 以后，别家那条转正式 / 转待入库永远报「已经被用过了」。
 * 别家的只挡「还会按这个号去转」的：没转的，或者转出的运单已经被删了（到货通知回到「没转」、可以重转，同 toDto 的 shipmentGone）；
 * 转过、运单还在的不挡 —— 它显示和再转都按它那张运单现在的号，库里这个旧号只在它自己公司里占着。
 * 提示跟 assertTrackingNoFree 撞别家运单时一样，只说「已经被用过了」，不说是哪家、哪个唛头。
 *
 * mode = "create"：员工「创建订单 / 批量导入」也调（2026-10-08 模拟数据测试：原来建单这个入口不查，用到货通知登记着的号建单照样成功，
 * 那条到货通知从此转不了），提示语换成建单的说法；查法完全一样（ownShipmentIds 传空数组 = 同公司任何一条登记着这个号都挡）。
 */
export async function arrivalNoticeHoldingMessage(db: Db, companyId: string, trackingNo: string, ownShipmentIds: string[], mode: "rename" | "create" = "rename"): Promise<string | null> {
  const holder = await db.arrivalNotice.findFirst({
    where: {
      companyId,
      trackingNo,
      // shipment_id 空的要单独列：SQL 里 NULL NOT IN (...) 不算真
      ...(ownShipmentIds.length ? { OR: [{ shipmentId: null }, { shipmentId: { notIn: ownShipmentIds } }] } : {}),
    },
    select: { clientId: true, convertedTo: true, shipmentId: true },
  });
  /* 本公司那条要是「转过、转出的运单还在」，而存的号又跟那张运单现在的号对不上（迁移回填跳过的老数据，
     2026-10-08 模拟数据测试第 2 轮）：它卡片上显示、搜索、再转都按那张运单现在的号，库里这个旧号只是没跟上。
     原来照样挡，提示让人去「到货通知」转 / 改 / 删 —— 可它早就转过了（不能改、不能删），按这个旧号也搜不到它，员工无路可走。
     不算占号（同别家公司那一支的 stillConvertible 规矩），放行 —— 只有一种例外：
     改号时被改的这张运单自己也有转出它的到货通知，改过去以后那条跟不上新号（撞这条旧号），又多一条对不上的；这种照样挡，
     但提示说清楚占着的那条现在对应哪张运单、该找谁处理 */
  const holderShipment = holder?.convertedTo && holder.shipmentId
    ? await db.shipment.findFirst({ where: { id: holder.shipmentId, companyId }, select: { trackingNo: true } })
    : null;
  if (holder && holderShipment && holderShipment.trackingNo !== trackingNo) {
    const ownNotice = mode === "rename" && ownShipmentIds.length
      ? await db.arrivalNotice.findFirst({ where: { companyId, shipmentId: { in: ownShipmentIds }, convertedTo: { not: null } }, select: { id: true } })
      : null;
    if (ownNotice) {
      return `运单号 ${trackingNo} 还被一条早已转成运单的到货通知占着（唛头 ${holder.clientId ?? "未填"}，它现在对应的运单是 ${holderShipment.trackingNo}，库里存的还是旧号），` +
        `改成这个号以后，这张运单的到货通知就跟不上新号。这是旧数据没对齐，请找管理员 / 技术处理那一条；本次修改都没有保存`;
    }
  } else if (holder) {
    const where = `运单号 ${trackingNo} 已经登记在「到货通知」里了（唛头 ${holder.clientId ?? "未填"}${holder.convertedTo ? "" : "，还没转运单"}），`;
    if (mode === "create") {
      return where + "用这个号建单以后那条到货通知就转不了。是同一票货的话请到「到货通知」里直接转运单；不是的话先把那一条的运单号改掉或删掉，再回来建单；本次没有建单";
    }
    return where + "改成这个号以后那条到货通知就转不了。请先到「到货通知」搜这个号，把那一条的运单号改掉或删掉，再回来改号；本次修改都没有保存";
  }
  // 别家公司的（同一个号每家最多一条，见 @@unique([companyId, trackingNo])）
  const foreign = await db.arrivalNotice.findMany({
    where: { trackingNo, NOT: { companyId } },
    select: { companyId: true, convertedTo: true, shipmentId: true },
  });
  for (const f of foreign) {
    const stillConvertible = !f.convertedTo || !f.shipmentId ||
      !(await db.shipment.findFirst({ where: { id: f.shipmentId, companyId: f.companyId }, select: { id: true } }));
    if (stillConvertible) return `运单号 ${trackingNo} 已经被用过了，换一个号；${mode === "create" ? "本次没有建单" : "本次修改都没有保存"}`;
  }
  return null;
}

/**
 * 运单在「运单管理」里改了号：转出这张运单的到货通知跟着改成新号（F06，2026-10-08）。
 * 不跟的话：卡片上还是旧号、按新号搜不到，旧号也一直被这条到货通知占着（同公司同号只能登记一条），
 * 旧号其实是别人的真单号时，那票货到了在到货通知里登记不进来。
 *
 * 单独放一个文件：改号的两条路（admin/routes.ts、orders/routes.ts）只 import 这一个函数，不用把整个到货通知路由拉进来。
 *
 * ⚠️ 由改号的两条路（/admin/orders/update、/staff/orders/patch-shipment-bundle）在**它们的事务提交以后**单独调一句，
 *    不放进它们的事务：那两条路锁的是「订单 → 运单」，这里再改到货通知就成了「订单 → 运单 → 到货通知」，
 *    跟到货通知自己「到货通知 → 订单 → 运单」反着，两人同时点会死锁（CLAUDE.md 第 35 条②）。
 *    在改号事务外面另起一个小事务，只锁挂在这张运单下面的到货通知行、不等别的锁（见下面 ⚠️ 第二段）。调用方出错只记日志，不影响改号本身。
 * 没跟上（新号正好被另一条到货通知登记着）就跳过并点名记一条 warn：改号的两条路已用 arrivalNoticeHoldingMessage 在锁里挡过
 * （修复第 3 轮），这里只剩老数据（上线前就对不上、迁移回填跳过的）。列表按运单现在的号显示（toDto），只是旧号还占着。
 * 每次保存都调（不管改没改号），只改「号对不上」的那几行：顺手修好上线前已经对不上的老记录。
 *
 * ⚠️ 写进去的号必须是「写的那一刻」运单上的号，不能是先读进内存的那份（修复第 3 轮）：
 *    原来分三步（读运单号 → 查占没占 → updateMany 写内存里那个号），各自自动提交、中间不排队。
 *    两人先后把运单 S 改成 X、再改成 Y：前一个的跟号读到 X 后慢了一拍，后一个已经把到货通知写成 Y，
 *    前一个这才把 X 写回去 —— 运单是 Y、到货通知是 X，X 明明空出来了却被这条占着，别人用 X 登记被挡。
 *    现在每张运单一个小事务：先锁住挂在它下面的到货通知行，再用**一句** UPDATE … FROM shipments 直接取运单当时的号写进去。
 *    先锁后读：谁最后拿到这几行的锁，谁读到的就是最新提交的号（每条改号路都是提交以后才调跟号），最后落库的一定是运单现在的号。
 *    只锁到货通知、不锁运单：锁序是「到货通知 →（只读）运单」，跟到货通知自己的「到货通知 → 订单 → 运单」同向，
 *    不会跟改号的「订单 → 运单」或到货通知那边互相等成死锁（第 35 条②，所以照旧不放进改号的事务）。
 *    占没占在同一句里用 NOT EXISTS 判断，不去撞唯一约束（撞了 Prisma 会自己往日志里打一条 prisma:error，看着像出了事、又不说是哪条）；
 *    判断和写之间又被抢的，撞唯一约束照样跳过。
 * 列名都核过库（tracking_no / shipment_id / converted_to / company_id / updated_at 都有 @map，教训 26）；
 * updated_at 是不带时区的 timestamp(3)、Prisma 按 UTC 存，所以写 NOW() AT TIME ZONE 'UTC'（同下面 followShipmentClientIds）。
 */
export async function followShipmentTrackingNos(companyId: string, shipmentIds: string[]): Promise<void> {
  if (shipmentIds.length === 0) return;
  for (const shipmentId of shipmentIds) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM arrival_notices
           WHERE company_id = ${companyId} AND shipment_id = ${shipmentId} AND converted_to IS NOT NULL
           ORDER BY id
             FOR UPDATE`;
        // 目标表不起别名（写成 UPDATE arrival_notices SET）：scripts/test-lock-order.ts 按「UPDATE 表名 SET」认 raw 写语句，起了别名它就看不见这个事务
        await tx.$executeRaw`
          UPDATE arrival_notices
             SET tracking_no = s.tracking_no, updated_at = (NOW() AT TIME ZONE 'UTC')
            FROM shipments AS s
           WHERE arrival_notices.company_id = ${companyId}
             AND arrival_notices.shipment_id = s.id
             AND arrival_notices.converted_to IS NOT NULL
             AND s.company_id = ${companyId}
             AND s.id = ${shipmentId}
             AND arrival_notices.tracking_no IS DISTINCT FROM s.tracking_no
             AND NOT EXISTS (
               SELECT 1 FROM arrival_notices AS h
                WHERE h.company_id = ${companyId} AND h.tracking_no = s.tracking_no AND h.id <> arrival_notices.id)`;
        // 等行锁最多 15 秒（同事正在转这条 / 传照片）：超时抛错，调用方只记日志，下次保存这张运单再跟
      }, { timeout: 15000 });
    } catch (e) {
      if (isUniqueViolation(e)) continue; // 判断完到写之间号被别条抢了：跟下面「被占着」一样跳过、点名
      throw e;
    }
  }
  // 还对不上的（新号被另一条到货通知登记着）：点名记一条，员工 / 运维按日志去「到货通知」处理
  const stale = await prisma.$queryRaw<{ notice_id: string; shipment_id: string; tracking_no: string; holder_id: string | null }[]>`
    SELECT n.id AS notice_id, s.id AS shipment_id, s.tracking_no, h.id AS holder_id
      FROM arrival_notices AS n
      JOIN shipments AS s ON s.id = n.shipment_id AND s.company_id = n.company_id
      LEFT JOIN arrival_notices AS h ON h.company_id = n.company_id AND h.tracking_no = s.tracking_no AND h.id <> n.id
     WHERE n.company_id = ${companyId}
       AND s.id IN (${Prisma.join(shipmentIds)})
       AND n.converted_to IS NOT NULL
       AND n.tracking_no IS DISTINCT FROM s.tracking_no`;
  for (const r of stale) {
    logger.warn("arrival notice follow trackingNo skipped: number held by another arrival notice", { noticeId: r.notice_id, shipmentId: r.shipment_id, trackingNo: r.tracking_no, holderNoticeId: r.holder_id });
  }
}

/**
 * 要用号 T 建单 / 改号成 T 之前：同公司一条「转过、运单还在、存的却还是旧号 T」的到货通知（迁移跳过的老数据），
 * 先让它跟上它那张运单现在的号（2026-10-08 模拟数据测试第 3 轮）。
 *
 * 为什么：第 2 轮让 arrivalNoticeHoldingMessage 不再把这种老通知算占号（它显示、搜索、再转都按运单现在的号），建单 / 改号放行了；
 * 可它库里存的还是 T。之后那张运单（连订单）一被删，它按 shipmentGone 回到「没转」、卡片上显示 T、提示可以重转 ——
 * 而 T 已经是刚建的那张别人的运单了，转正式 / 转待入库 / 原样保存全报「已经有运单了」（实测 OLD1006F4）。
 * 让它先跟上：删运单以后它回到「没转」时显示的是它自己那张运单的最后一个号，跟新建的 T 不相干。
 *
 * 就是 followShipmentTrackingNos 本来每次保存都会做的那件事（它那张运单一直没人保存过，所以一直没跟上），只是换个时机触发。
 * ⚠️ 调用时手里不能有任何锁（followShipmentTrackingNos 自己开小事务、先锁到货通知行）—— 放在建单 / 改号的事务**之前**。
 * 跟不上（它运单现在的号又被另一条到货通知登记着，双重老数据）就照旧不动，后面 arrivalNoticeHoldingMessage 照第 2 轮的规矩判。
 * 出错只记日志、不挡建单 / 改号（说了算的是后面锁里那次 arrivalNoticeHoldingMessage）。
 */
export async function followStaleArrivalNoticeHolding(companyId: string, trackingNo: string): Promise<void> {
  try {
    const holder = await prisma.arrivalNotice.findFirst({
      where: { companyId, trackingNo, convertedTo: { not: null }, shipmentId: { not: null } },
      select: { shipmentId: true },
    });
    if (holder?.shipmentId) await followShipmentTrackingNos(companyId, [holder.shipmentId]);
  } catch (e) {
    logger.warn("follow stale arrival notice holding trackingNo failed", { companyId, trackingNo, error: String((e as Error)?.message ?? e) });
  }
}

/** 唯一约束冲突：Prisma 普通写法报 P2002；$executeRaw 报 P2010、meta.code 是 PostgreSQL 的 23505 */
function isUniqueViolation(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (e.code === "P2002") return true;
  return e.code === "P2010" && String((e.meta as { code?: unknown } | undefined)?.code ?? "") === "23505";
}

/**
 * 运单在「运单管理」里改了唛头（超管 /admin/orders/update 改订单 clientId）：转出这张运单的到货通知跟着改成新唛头，
 * 原来的「已通知客户」清掉、回到「待通知」页签（2026-10-08 修复第 2 轮，跟 G01「到货通知自己改唛头清已通知」同一个道理）。
 * 不跟的话：卡片上运单号是新的（F06 跟了号）、唛头还是旧客户 A，「已通知」照留；按新唛头 B 搜不到，
 * 复制给客户的文案写的也是 A —— 新客户 B 没人通知。
 *
 * 跟 followShipmentTrackingNos 一样：调用方在**事务提交以后**单独调、出错只记日志（锁序理由同上）；
 * 每次保存都调，只改「唛头对不上」的那几行，顺手修好上线前已经对不上的老记录。单条 UPDATE 自动提交，
 * 唛头取的是语句执行那一刻订单上的值，两人先后改唛头也以最后落库的为准。
 * 列名都核过库（client_id / notified_at / notified_by / notified_by_name / updated_at 都有 @map，教训 26）；
 * updated_at 是不带时区的 timestamp(3)、Prisma 按 UTC 存，所以写 NOW() AT TIME ZONE 'UTC'，不受连接时区影响。
 */
export async function followShipmentClientIds(companyId: string, shipmentIds: string[]): Promise<number> {
  if (shipmentIds.length === 0) return 0;
  return prisma.$executeRaw`
    UPDATE arrival_notices AS n
       SET client_id = o.client_id, notified_at = NULL, notified_by = NULL, notified_by_name = NULL, updated_at = (NOW() AT TIME ZONE 'UTC')
      FROM shipments AS s
      JOIN orders AS o ON o.id = s.order_id AND o.company_id = s.company_id
     WHERE n.company_id = ${companyId}
       AND n.shipment_id = s.id
       AND n.converted_to IS NOT NULL
       AND s.company_id = ${companyId}
       AND s.id IN (${Prisma.join(shipmentIds)})
       AND n.client_id IS DISTINCT FROM o.client_id`;
}
