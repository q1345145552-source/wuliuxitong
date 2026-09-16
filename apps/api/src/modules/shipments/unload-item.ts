import { BusinessError } from "../core/business-error";

/**
 * 把**一条柜内记录**整个卸下来：件数/方数/重量还给父单，然后删掉子单。
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么要有这个（2026-08-29）
 * ════════════════════════════════════════════════════════════════════
 *
 * 这段逻辑原来只写在「卸柜」那条路里（loading-manifests/routes.ts）。
 * 上线前排查发现 **「删除柜子」那条路完全没做这件事** ——
 * 它只删柜子和柜内记录，**子单原样留着**：
 *   · 子单变成孤儿：状态还写着「已装柜」，却不属于任何柜子
 *   · 父单被扣走的件数/方数/重量**永远回不来**（父单永远 0 件 0 方 0 公斤）
 * 而「建错柜子删掉重来」是员工很日常的动作，删除按钮就在卸柜按钮旁边，
 * 确认框还只说「此操作不可恢复」，没提会把货的数字弄没。
 *
 * 生产库只读查过（2026-08-29）：**目前还没有被踩到**（0 张孤儿子单、
 * 0 个父单被清零），所以这次修完不用清数据。
 *
 * ⚠️ 一份实现两处调用 —— 这个项目里「N 个入口只修了 M 个」已经犯过五六次。
 */

/** 卸一条柜内记录需要的信息（调用方先查好，因为两条路查的方式不一样） */
export interface UnloadableItem {
  id: string;
  shipment: {
    id: string;
    parentTrackingNo: string | null;
    packageCount: number | null;
    volumeM3: unknown;
    weightKg: unknown;
  };
}

const toNum = (v: unknown): number => (v == null ? 0 : Number(v));

/**
 * 点「卸柜 / 删柜子」的人。卸柜写的轨迹记这个人（老板 2026-09-17 拍板）。
 *
 * ⚠️ 2026-08-29 加这条轨迹时这里没收操作人，三处写死成 system / 系统，
 *    线上 20 条卸柜记录因此查不到是谁动的货。现在**必填**：漏传编译就不过。
 * 「谁能看到操作人」不在这里管 —— 只有超级管理员能看，见 core/operator-visibility.ts。
 */
export interface UnloadOperator {
  userId: string;
  role: string;
  name?: string | null;
}

export async function unloadItemFully(
  tx: any,
  item: UnloadableItem,
  companyId: string,
  operator: UnloadOperator,
): Promise<{ 还给父单: boolean; 删了子单: boolean }> {
  await tx.shipmentContainerItem.delete({ where: { id: item.id } });

  /**
   * 没有父单 = 这票货是整票装进柜的（没分柜），子单就是它自己 ——
   * 那种情况不许删运单，只把柜内记录删掉就行。
   *
   * 2026-09-02 终审整改（P1）：原来这里删完柜内记录就走人，**运单状态不退回**——
   * 整票货卸下来躺在国内仓，客户看到的还是「运输中/已签收」（跟下面父单那个
   * 「状态冻住」是同一个病，只是这条分支当时漏了）。现在补上：状态退回「已入库」
   * + 写 sl_unld_ 轨迹。
   *
   * ⚠️⚠️ 铁的护栏：**件数/方数/重量一个字段都不许动**（排查第 3 条拍板：
   * 整票记录卸柜不许改运单数字 —— 整票装柜时本来就没扣过运单数字，没有可还的）。
   * 这条分支只许碰 currentStatus 和轨迹。
   */
  if (!item.shipment.parentTrackingNo) {
    /**
     * 先锁自己这张运单再读状态（CLAUDE.md 第 28 条：用锁内数据做决定）。
     * 锁序仍是【柜 → 运单 → 父单】：卸柜那条路（loading-manifests ~861）进来前
     * 已经按这个顺序锁过同一行，同一事务重复锁同一行是免费的；
     * 删柜子那条路按柜内记录 id 排序逐条处理，加锁顺序固定。
     */
    await tx.$queryRaw`
      SELECT id FROM shipments
      WHERE id = ${item.shipment.id} AND company_id = ${companyId}
      FOR UPDATE
    `;
    const self = await tx.shipment.findFirst({
      where: { id: item.shipment.id, companyId },
      select: { currentStatus: true },
    });
    const cur: string | undefined = self?.currentStatus;

    /**
     * 2026-09-02 复核整改（P1，主管已裁定的终态口径）：
     * 「状态只往前不往后」管的是**自动推进**；卸柜是员工点出来的**显式业务动作**，
     * 不受那条限制。货物理上确实回到国内仓了，状态就得说实话：
     *   · created / inWarehouseCN：状态没往前走过 / 本来就对，不退也不刷轨迹；
     *   · holdLoading：本来就是「在国内仓暂缓装柜」，货的位置没变，
     *     退成 inWarehouseCN 反而丢了「暂缓」这层意思 —— 保守不动；
     *   · delivered / exception / 一切运输中状态：**退回 inWarehouseCN + 写轨迹**。
     *     货已经卸回仓里了，还挂着「已签收/异常/运输中」就是假话
     *     （上一版把 delivered/exception 当终态不许拽回，主管裁定改掉）；
     *   · returned / cancelled：**保持不动**。业务已经终止的单不能因为卸柜复活，
     *     只写一条 fromStatus = toStatus 的备注轨迹，给排查留「被卸下来过」的痕迹。
     */
    const 业务已终止 = ["returned", "cancelled"];
    const 在仓不动 = ["created", "inWarehouseCN", "holdLoading"];
    if (cur && !在仓不动.includes(cur)) {
      const 已终止 = 业务已终止.includes(cur);
      if (!已终止) {
        await tx.shipment.update({
          where: { id: item.shipment.id },
          // ⚠️ 只动状态。件数/方数/重量绝不出现在这份 data 里（见上面的铁护栏）。
          data: { currentStatus: "inWarehouseCN", updatedAt: new Date() },
        });
      }
      await tx.statusLog.create({
        data: {
          id: `sl_unld_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          companyId,
          shipmentId: item.shipment.id,
          operatorId: operator.userId,
          operatorRole: operator.role,
          operatorName: operator.name ?? "",
          fromStatus: cur,
          toStatus: 已终止 ? cur : "inWarehouseCN",
          remark: 已终止
            ? "运单已退回/已取消，卸柜不改变其状态"
            : "已从柜子卸下，退回国内仓等待重新装柜",
          changedAt: new Date(),
        },
      });
    }
    return { 还给父单: false, 删了子单: false };
  }

  // ⚠️ 锁序【... → 运单 → 父单】，跟别处一致
  await tx.$queryRaw`
    SELECT id FROM shipments
    WHERE tracking_no = ${item.shipment.parentTrackingNo} AND company_id = ${companyId}
    FOR UPDATE
  `;
  const parent = await tx.shipment.findFirst({
    where: { trackingNo: item.shipment.parentTrackingNo, companyId },
    select: { id: true, packageCount: true, volumeM3: true, weightKg: true, currentStatus: true },
  });

  if (parent) {
    /**
     * ⚠️ 子单马上要被删掉，它身上的**体积和重量必须先全部加回父单**，
     * 否则这两个数随子单一起消失（2026-08-22 修过一次）。
     */
    const childVol = toNum(item.shipment.volumeM3);
    const childWt = item.shipment.weightKg == null ? null : Number(item.shipment.weightKg);
    const pv = toNum(parent.volumeM3);
    const pw = parent.weightKg == null ? null : Number(parent.weightKg);
    const newPkg = (parent.packageCount ?? 0) + (item.shipment.packageCount ?? 0);

    /**
     * ⚠️⚠️ **状态也要退回来**（2026-08-29 补，这是另一个 bug）。
     *
     * 装柜时父单件数被扣到 0，于是它的状态跟着子单走
     * （parent-status.ts:132「父单自己没货了才接管它的状态」）。
     * 卸柜把件数还回去之后父单又「自己有货」了，那条规矩就不再接管它 ——
     * **父单的状态从此永远冻在卸柜之前那一刻**，再也没人会更新。
     *
     * 最坏的情况：一票货已经推到「已签收」，员工发现装错柜、卸下来，
     * 客户在订单里还是看到「已签收」，而货其实躺在仓库里。
     *
     * 所以这里明确把它退回「已入库」（inWarehouseCN）—— 货卸下来就在国内仓里、
     * 等着重新装柜（2026-09-02 起它进了流程，正是 loaded 之前的在仓状态；
     * 原来退的是「已创建」，那是还没入库的意思，跟货的真实位置对不上）。
     * ⚠️ 只在**父单确实拿回了货**（newPkg > 0）且状态确实往前走过时才退：
     *    还停在 created 的老单不动（拍板：老运单不回填），
     *    已经是 inWarehouseCN 的也不动（状态没变就别刷一条轨迹）。
     */
    const 要退状态 =
      newPkg > 0 && parent.currentStatus !== "created" && parent.currentStatus !== "inWarehouseCN";
    await tx.shipment.update({
      where: { id: parent.id },
      data: {
        packageCount: newPkg,
        volumeM3: Number((pv + childVol).toFixed(3)) as any,
        ...(pw == null || childWt == null ? {} : { weightKg: Number((pw + childWt).toFixed(2)) as any }),
        ...(要退状态 ? { currentStatus: "inWarehouseCN" } : {}),
        updatedAt: new Date(),
      },
    });

    if (要退状态) {
      // 写一条轨迹，让客户看得懂「货为什么退回去了」，而不是状态莫名其妙变了
      await tx.statusLog.create({
        data: {
          id: `sl_unld_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          companyId,
          shipmentId: parent.id,
          operatorId: operator.userId,
          operatorRole: operator.role,
          operatorName: operator.name ?? "",
          fromStatus: parent.currentStatus,
          toStatus: "inWarehouseCN",
          remark: "已从柜子卸下，退回国内仓等待重新装柜",
          changedAt: new Date(),
        },
      });
    }
  }

  await tx.shipment.delete({ where: { id: item.shipment.id } });
  return { 还给父单: !!parent, 删了子单: true };
}

/**
 * 删整个柜子之前，把柜里每一条记录都卸下来。
 * ⚠️ 按 id 排序处理，跟别处的锁序规矩一致（同一批行的加锁顺序必须固定）。
 */
export async function unloadAllItemsOfContainer(
  tx: any,
  containerId: string,
  companyId: string,
  operator: UnloadOperator,
): Promise<number> {
  const items = await tx.shipmentContainerItem.findMany({
    where: { containerId },
    select: {
      id: true,
      shipment: {
        select: { id: true, parentTrackingNo: true, packageCount: true, volumeM3: true, weightKg: true },
      },
    },
  });
  if (items.length === 0) return 0;
  const ordered = [...items].sort((a: any, b: any) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const it of ordered) {
    if (!it.shipment) {
      throw new BusinessError("柜内记录指向的运单不存在，请联系技术处理", 400, "VALIDATION_ERROR");
    }
    await unloadItemFully(tx, it as UnloadableItem, companyId, operator);
  }
  return ordered.length;
}
