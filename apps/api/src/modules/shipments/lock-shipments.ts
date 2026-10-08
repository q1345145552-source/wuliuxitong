import { BusinessError } from "../core/business-error";

/**
 * 「一次锁一批运单」的**唯一正确姿势**。
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么必须有这么个东西（2026-08-29，第八轮复核之后）
 * ════════════════════════════════════════════════════════════════════
 *
 * 全系统的锁序规矩是【全部子单（按 id 排）→ 全部父单（按 id 排）】。
 * 但这个规矩以前靠**每个调用点自己自觉**，于是接连出事：
 *
 *   · 第七轮：删订单把父单子单混在一起 `[...allIds].sort()`。
 *     看着很整齐，但**整齐 ≠ 跟别人一致** —— 复核开两个连接实测，
 *     PostgreSQL 报 `deadlock detected`。
 *
 *   · 第八轮：我改完删订单之后，在自测里开了张「审阅登记表」，
 *     给另外三处批量锁各写了一条「这批 id 里不会同时出现父单和它的子单」的理由。
 *     **三条理由全是错的**：
 *       - 建派送单：尾端页面取候选运单走 `/staff/shipments?all=1`，
 *         而后端 `all=1` 就是**明确不过滤父子**（shipments/routes.ts:427-429），
 *         父单和子单都能被勾选。复核在测试库查到 5 组父子单同时可派送，
 *         双连接实测又是一个真死锁。
 *       - 柜子那两条：`/admin/containers/load` **根本不检查父子关系**，
 *         父单和它的子单可以分别装进同一个柜。
 *
 * 教训：**靠人工推理的白名单，可靠性就等于那个人的推理。**
 * 我推了三条，三条全错。所以不再靠推理 —— 锁之前**真去查一遍父子关系**，
 * 调用方谁都不用再想「这批里会不会有父单」。
 */

/**
 * 「这批 id 里有查不到的」。
 * 单独一个类型，是为了让调用方能把它翻成 404 而不是笼统的 500「服务器繁忙」——
 * 员工看到「运单 xxx 不存在」才知道该去改什么。
 */
export class ShipmentsNotFoundError extends BusinessError {
  constructor(public readonly missingIds: string[], message?: string) {
    /**
     * ⚠️ **必须继承 BusinessError**（2026-08-29 第十轮改）。
     *
     * 上一版继承的是普通 `Error`，于是只有建派送单那一处 try/catch 翻成了 404，
     * 另外**四个调用点**（推进柜 / 撤销柜 / 两条删订单）抛上去会变成
     * `500 服务器繁忙` —— 员工完全不知道是哪一票单号不对。
     * 复核实测 `isBusinessError = false`，并指出柜子推进/撤销跟硬删除并发时
     * 「预读之后发现运单已经不在了」是真会发生的。
     *
     * `business-error.ts` 开头就记着同一条教训：
     * 「加四段 try/catch 治标不治本，下次再加一道闸门还是会有人忘」——
     * 我加了一道新闸门，然后又忘了。继承它，最外层自动翻，忘不了。
     */
    super(message ?? `运单不存在或不属于当前公司：${missingIds.join("、")}`, 404, "NOT_FOUND");
    this.missingIds = missingIds;
  }
}

/**
 * 锁完之后返回按锁定顺序排好的 id（调用方一般用不上，测试和排查时有用）。
 *
 * opts.allowGone（2026-10-08 模拟数据测试第 3 轮）：查不到 / 等锁期间被删掉的运单**跳过**、不报错，只锁还在的那些。
 * ⚠️ 只给「锁完会自己按库里现状重读、重读结果说了算」的调用方用 —— 现在只有删柜（unloadAllItemsOfContainer）：
 * 它锁完 readItems() 重读柜里还剩哪些记录，被别人删单带走的那几条自然不在里面。
 * 第 2 轮给 FOR UPDATE 加了「拿到 0 行就 404」以后，删柜跟删单同一瞬间撞上，删柜从原来的 200 变成 404「运单 X-1 已经不存在了」，
 * 员工删的是柜子、提示说的是运单，还得再点一次（实测 3/3）。别的调用方（删订单、建派送单……）手里那份 id 就是要动的东西，照旧严格报 404。
 */
export async function lockShipmentsChildrenFirst(
  tx: any,
  shipmentIds: string[],
  companyId: string,
  opts: { allowGone?: boolean } = {},
): Promise<string[]> {
  if (shipmentIds.length === 0) return [];

  const rows = await tx.shipment.findMany({
    where: { id: { in: shipmentIds }, companyId },
    select: { id: true, trackingNo: true, parentTrackingNo: true },
  });

  /**
   * ⚠️⚠️ **查不到的运单必须当场报错，不许悄悄丢掉**（2026-08-29 第九轮补）。
   *
   * 这是**我上一轮抽出这个函数时引入的回归**：
   * 原来建派送单是在循环里逐个 `findFirst`，找不到就抛
   * `LastmileShipmentNotFoundError` → 404、整批失败。
   * 改成批量 `findMany` 之后，查不到的 id 直接不在结果里，
   * 于是这个函数只返回「查到的那些」，调用方拿着它接着干活 ——
   *
   * 复核用真实路由夹具打出来的结果：
   *   传一批全是无效 id → **返回 200，建出一张 count: 0 的空派送单**；
   *   有效无效混着传   → **部分成功**，无效那几票**一声不吭地没了**。
   * 原来的「404 + 整批失败」语义被我改没了。
   *
   * ⚠️ 别家公司的 id 同样会落进这里（where 带了 companyId）——
   * 那本来就该 404，不该悄悄跳过。
   */
  const foundIds = new Set<string>(rows.map((r: any) => r.id));
  const missing = [...new Set(shipmentIds)].filter((id) => !foundIds.has(id));
  if (missing.length > 0 && !opts.allowGone) {
    throw new ShipmentsNotFoundError(missing);
  }

  /**
   * ⚠️ 多层分柜（A 是 B 的父单，B 又是 C 的父单）会让「两层」这个模型失效：
   * B 既是子单又是父单，放进哪一层都可能跟别人反着。
   *
   * 主流程已经禁止了（装柜时 `if (locked.parentTrackingNo) throw 子运单不能再次装柜`），
   * 第八轮复核在测试库也确认 **0 个多层分柜**。
   *
   * ⚠️⚠️ **这道拦截只挡得住一半，别当成保险箱**（2026-08-29 第九轮更正）。
   * 它认的是「中间单**和它的子单同时出现在这一批里**」；
   * 要是只把中间单单独传进来，这里**什么都看不出来**（它在这一批里就是个普通子单）。
   * 我上一版的注释写的是「历史数据里万一冒出来一个就会当场报错」——
   * **说过头了**，复核当场点了出来。
   *
   * 真要根治得在**建子单的时候**就禁止（那条路已经禁了），
   * 或者建一张父子关系表按层数排序。现在这道只是「能抓到就抓到」的兜底：
   * 抓到了总比让它安安静静去死锁强 —— 死锁随机出现、查起来极难，
   * 报错至少指得出是哪一票货。
   */
  const trackingNosInBatch = new Set<string>(rows.map((r: any) => r.trackingNo));
  const middle = rows.filter(
    (r: any) =>
      r.parentTrackingNo &&
      trackingNosInBatch.has(r.trackingNo) &&
      rows.some((o: any) => o.parentTrackingNo === r.trackingNo),
  );
  if (middle.length > 0) {
    // 业务错误（2026-09-29 dsh 复核）：原来是普通 Error，线上会变成一句英文「Internal server error」，
    // 员工不知道是哪几票货。现在提示原样给到页面（409）；事务照样整体回滚，行为不变。
    throw new BusinessError(
      `运单 ${middle.map((r: any) => r.trackingNo).join("、")} 既是子单又是父单（多层分柜），` +
        `加锁顺序无法确定，请先联系技术处理这几票货`,
      409,
      "VALIDATION_ERROR",
    );
  }

  /**
   * 第一层：子单（有 parentTrackingNo 的）；第二层：父单和独立单。
   * ⚠️ 两层内部都必须按 id 排序 —— 同一层里顺序不固定，同样会反向等待。
   * ⚠️ 排序写在 `.sort()` 上、不靠 SQL 的 orderBy：
   *    test-lock-order 第 6 项按「取锁的循环里必须看得见 .sort()」查，
   *    而且要求**以 `.sort()` 结尾**（`.sort().reverse()` 那种会被逮住）。
   */
  const childIds = rows.filter((r: any) => r.parentTrackingNo).map((r: any) => r.id);
  const parentIds = rows.filter((r: any) => !r.parentTrackingNo).map((r: any) => r.id);

  /**
   * ⚠️ 每一把 FOR UPDATE 都要看拿没拿到行（2026-10-08 模拟数据测试第 2 轮）。
   * 上面那句 findMany 不加锁：查完到这里排上锁之间，同事把子单卸柜 / 删柜（卸柜会删子单）并提交了，
   * FOR UPDATE 就拿到 0 行。原来不看，调用方接着往下跑 —— 删订单走到 tx.shipment.delete 报 P2025「Record to delete does not exist」→ 500「服务器繁忙」。
   * 行没了跟上面「查不到」是同一回事，抛同一个类型（调用方已有的 404 处理照样接得住），只是换一句能照做的话。
   */
  const trackingNoOf = new Map<string, string>(rows.map((r: any) => [r.id, r.trackingNo]));
  /** 拿到行返回 true；没拿到：allowGone 时返回 false（调用方跳过这一票），否则抛 404 */
  const stillThere = (got: unknown, sid: string): boolean => {
    if (Array.isArray(got) && got.length === 0) {
      if (opts.allowGone) return false;
      throw new ShipmentsNotFoundError([sid], `运单 ${trackingNoOf.get(sid) ?? sid} 已经不存在了（刚刚被别人卸柜或删掉），请刷新后再操作；本次没有改动`);
    }
    return true;
  };
  const ordered: string[] = [];
  for (const sid of [...childIds].sort()) {
    const got = await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${sid} FOR UPDATE`;
    if (stillThere(got, sid)) ordered.push(sid);
  }
  for (const sid of [...parentIds].sort()) {
    const got = await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${sid} FOR UPDATE`;
    if (stillThere(got, sid)) ordered.push(sid);
  }
  return ordered;
}

/**
 * 按**运单号**给一批父单上锁 —— 但内部统一换算成 **id** 再排序。
 *
 * ⚠️⚠️ 为什么必须有这个（2026-08-29，第八轮之后的补刀）：
 *
 * 我上面那个 `lockShipmentsChildrenFirst` 的父单层是 `[...parentIds].sort()`，
 * 按 **id** 排。而系统里另外三处「第二轮同步父单」写的是
 *   `for (const no of [...parentNosToSync].sort()) await syncParentStatusFromChildren(...)`
 * （containers/routes.ts ~491 / ~744、admin-ops/routes.ts ~685），
 * 而 `syncParentStatusFromChildren` 内部发的是
 *   `SELECT id FROM shipments WHERE tracking_no = ... FOR UPDATE`
 * —— 按**运单号**排。
 *
 * **同一批父单、两把不同的钥匙。** 两个事务从不同的门进来，顺序照样能反：
 *   事务A（给两张父单建派送单）按 id 序锁 P1 → P2
 *   事务B（推进一个柜，柜里装着 P1 和 P2 各自的子单）先锁两个子单，
 *         再按运单号序锁 P2 → P1
 * 成环。
 *
 * 测试库只读查过：**id 顺序和运单号顺序相反的父单对有 41 对**，
 * 不是理论上可能，是数据里就有。
 *
 * 所以全系统父单层**只认 id 一个排序键**。调用方要是手里只有运单号，
 * 就走这个函数换算，不许自己按运单号排。
 */
export async function lockParentsByTrackingNo(
  tx: any,
  parentTrackingNos: string[],
  companyId: string,
): Promise<string[]> {
  if (parentTrackingNos.length === 0) return [];
  const rows = await tx.shipment.findMany({
    where: { trackingNo: { in: parentTrackingNos }, companyId },
    select: { id: true },
  });
  const ordered: string[] = [];
  // ⚠️ 按 id 排，跟 lockShipmentsChildrenFirst 的父单层同一把钥匙
  for (const sid of rows.map((r: any) => r.id).sort()) {
    await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${sid} FOR UPDATE`;
    ordered.push(sid);
  }
  return ordered;
}

/**
 * 「锁一批父单 + 逐个重算它们的状态」—— 调用方**只许用这一个入口**。
 *
 * ⚠️ 为什么把循环也收进来（2026-08-29）：
 * 分成「先调 lockParentsByTrackingNo，再自己写 for 循环」两步的话，
 * 哪天有人把前面那句预锁删了，循环就重新变成决定锁序的那个人 ——
 * 而它迭代的是**运单号**清单，又回到「两把钥匙」那个 bug。
 * 合成一个函数，调用方连写错的机会都没有。
 */
export async function lockAndSyncParents(
  tx: any,
  parentTrackingNos: string[],
  companyId: string,
  sync: (tx: any, trackingNo: string, companyId: string) => Promise<unknown>,
): Promise<void> {
  const unique = [...new Set(parentTrackingNos)];
  if (unique.length === 0) return;
  // ① 先按 id 把这批父单全锁住（唯一决定锁序的一步）
  await lockParentsByTrackingNo(tx, unique, companyId);
  // ② 再逐个重算。这时候锁已经全在手里，②的顺序对死锁没有影响。
  for (const trackingNo of unique) {
    await sync(tx, trackingNo, companyId);
  }
}
