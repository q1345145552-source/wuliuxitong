/**
 * ⚠️ 禁库硬闸：这个脚本不许连数据库。
 * 「不小心连上测试库」这个坑我已经踩过四次，靠记性不行。
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";

/**
 * 「从柜子里卸货」的自测。
 *
 * 这两个 bug 都是上线后排查出来的、**上线前就存在的老毛病**：
 *
 * 1. **卸柜之后父单状态永远不再更新。**
 *    装柜时父单件数被扣到 0，它的状态就跟着子单走
 *    （parent-status.ts:132「父单自己没货了才接管它的状态」）。
 *    卸柜把件数还回去之后父单又「自己有货」了，那条规矩就不再接管它 ——
 *    **父单状态从此永远冻在卸柜之前那一刻**。
 *    最坏：货已经推到「已签收」，员工发现装错柜卸下来，
 *    客户还看到「已签收」，而货其实躺在仓库里。
 *
 * 2. **删除柜子会把子单变成孤儿。**
 *    删柜子原来只删柜子和柜内记录，子单原样留着（状态写着「已装柜」却不属于任何柜子），
 *    父单被扣走的件数/方数/重量永远回不来。
 *    而「建错柜子删掉重来」是员工很日常的动作。
 *
 * ⚠️ 用**假 tx** 真调那个函数 —— 扫源码证明不了行为，这条教训这个项目里栽过四次。
 */
import assert from "node:assert/strict";
import { unloadAllItemsOfContainer, unloadItemFully } from "../apps/api/src/modules/shipments/unload-item";

const failures: string[] = [];
// 2026-09-02 终审整改：项数动态数，别再写死「8」—— 加减项时收尾输出跟着走
let 总项数 = 0;
async function check(name: string, body: () => Promise<void>): Promise<void> {
  总项数 += 1;
  try { await body(); console.log(`  ✅ ${name}`); }
  catch (error) {
    failures.push(name);
    const m = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${m.split("\n").join("\n     ")}`);
  }
}

/** 假 tx：记下所有写操作，不连任何数据库 */
function makeTx(parent: any, items: any[] = []) {
  const 记录 = { 删掉的柜内记录: [] as string[], 删掉的运单: [] as string[], 父单更新: null as any, 轨迹: [] as any[] };
  return {
    记录,
    tx: {
      shipmentContainerItem: {
        delete: async ({ where }: any) => { 记录.删掉的柜内记录.push(where.id); },
        findMany: async () => items,
      },
      shipment: {
        findFirst: async () => parent,
        update: async ({ data }: any) => { 记录.父单更新 = data; return data; },
        delete: async ({ where }: any) => { 记录.删掉的运单.push(where.id); },
      },
      statusLog: { create: async ({ data }: any) => { 记录.轨迹.push(data); } },
      $queryRaw: async () => [],
    },
  };
}

const 子单 = (over: any = {}) => ({
  id: "s_child", parentTrackingNo: "YW0001", packageCount: 30, volumeM3: 1.5, weightKg: 120, ...over,
});

/**
 * 2026-09-02 三审整改（P3）：给第 8 项「真调路由」用的假 prisma。
 * apps/api/src/db/prisma.ts 是 `globalThis.__prisma ?? new PrismaClient()`，
 * 在动态 import 路由**之前**把 __prisma 换成假的，真 PrismaClient 根本不会被 new 出来；
 * 文件头那行被挡死的 DATABASE_URL 是第二道保险（写法照 test-client-address-update.ts）。
 * 假 prisma 只有 $transaction 一个方法：直接把「当前场景的假 tx」递给事务回调。
 */
let 路由用假tx: any = null;
(globalThis as any).__prisma = {
  $transaction: async (fn: (tx: any) => Promise<unknown>) => fn(路由用假tx),
};

/** 换上一套新的路由假 tx（每个场景一套），把所有写操作录下来供断言 */
function 装路由假tx(opts: { item: any; parent?: any }) {
  const 记录 = {
    柜内记录更新: null as any,
    子单更新: null as any,
    父单更新: null as any,
    运单更新次数: 0,
    轨迹: [] as any[],
  };
  路由用假tx = {
    shipmentContainerItem: {
      // 同一个函数要伺候两次 findFirst（锁前的 lockTarget + 锁后重查的 item），
      // 假对象把两边要的字段都带上就行，不用理会 select/include
      findFirst: async () => opts.item,
      update: async ({ data }: any) => { 记录.柜内记录更新 = data; return data; },
    },
    shipment: {
      findFirst: async () => opts.parent ?? null,
      update: async ({ where, data }: any) => {
        记录.运单更新次数 += 1;
        if (opts.parent && where?.id === opts.parent.id) 记录.父单更新 = data;
        else 记录.子单更新 = data;
        return data;
      },
    },
    statusLog: { create: async ({ data }: any) => { 记录.轨迹.push(data); } },
    $queryRaw: async () => [],
  };
  return { 记录 };
}

type Handler = (req: any, res: any) => Promise<void> | void;

async function main(): Promise<void> {
  console.log("从柜子里卸货");

  await check("1) 卸柜：件数/方数/重量要全部还给父单", async () => {
    // ⚠️ 三个数字互不相同（父 0 件 / 子 30 件；父 0 方 / 子 1.5 方；父 0kg / 子 120kg）
    const { tx, 记录 } = makeTx({ id: "s_parent", packageCount: 0, volumeM3: 0, weightKg: 0, currentStatus: "delivered" });
    await unloadItemFully(tx as any, { id: "i_1", shipment: 子单() }, "c_1");
    assert.equal(记录.父单更新.packageCount, 30, "件数没还回父单");
    assert.equal(Number(记录.父单更新.volumeM3), 1.5, "方数没还回父单");
    assert.equal(Number(记录.父单更新.weightKg), 120, "重量没还回父单");
    assert.deepEqual(记录.删掉的柜内记录, ["i_1"], "柜内记录没删");
    assert.deepEqual(记录.删掉的运单, ["s_child"], "子单没删");
  });

  await check("2) 卸柜：父单状态要退回「已入库」，还要写一条客户看得懂的轨迹", async () => {
    /**
     * ⚠️ 这就是那个「状态永远冻住」的 bug。
     * 父单原来是 delivered（跟着子单走的），卸柜之后货回到国内仓，
     * 状态必须跟着退回来，否则客户一直看到「已签收」。
     * 2026-09-02：退回目标从「已创建」改成「已入库」（inWarehouseCN 进了流程）——
     * 货卸下来就在仓里，退到「已创建」反而说成还没入库。
     */
    const { tx, 记录 } = makeTx({ id: "s_parent", packageCount: 0, volumeM3: 0, weightKg: 0, currentStatus: "delivered" });
    await unloadItemFully(tx as any, { id: "i_1", shipment: 子单() }, "c_1");
    assert.equal(记录.父单更新.currentStatus, "inWarehouseCN", "父单状态没退回「已入库」—— 客户会一直看到「已签收」");
    assert.equal(记录.轨迹.length, 1, "没写轨迹 —— 客户会觉得状态莫名其妙变了");
    assert.equal(记录.轨迹[0].fromStatus, "delivered", "轨迹的起点状态不对");
    assert.equal(记录.轨迹[0].toStatus, "inWarehouseCN", "轨迹的终点状态不对");
    assert.ok(/退回国内仓/.test(记录.轨迹[0].remark), `轨迹备注看不懂：${记录.轨迹[0].remark}`);
  });

  await check("3) 父单还停在「已创建/已入库」时不许改状态、不许多写轨迹（别刷屏）", async () => {
    // 「已创建」的老单不回填（2026-09-02 拍板），「已入库」的状态本来就对 —— 两种都不动
    for (const cur of ["created", "inWarehouseCN"]) {
      const { tx, 记录 } = makeTx({ id: "s_parent", packageCount: 70, volumeM3: 3, weightKg: 200, currentStatus: cur });
      await unloadItemFully(tx as any, { id: "i_1", shipment: 子单() }, "c_1");
      assert.equal(记录.轨迹.length, 0, `父单是 ${cur} 时还写了轨迹`);
      assert.equal(记录.父单更新.packageCount, 100, "件数还是要还回去（70 + 30）");
      assert.equal(记录.父单更新.currentStatus, undefined, `父单是 ${cur} 时不该动它的状态`);
    }
  });

  await check("4) 没有父单的整票货：不删运单、按终态口径退状态、件数方数重量一个不许动", async () => {
    /**
     * ⚠️ 整票装柜（没分柜）时子单就是运单本身。
     * 这里要是跟着删，客户的运单就凭空没了。
     *
     * 2026-09-02 终审整改（P1）补断言，2026-09-02 复核整改跟上主管裁定的新口径：
     *   · delivered / exception / 一切运输中状态 → 退回「已入库」+ 写 sl_unld_ 轨迹
     *     （货物理上回仓了，挂着已签收/异常就是假话；卸柜是显式业务动作，
     *     不受「自动推进只往前」限制）；
     *   · returned / cancelled → 保持不动（业务已终止不能因卸柜复活），
     *     只写 fromStatus=toStatus 的备注轨迹；
     *   · ⚠️⚠️ 铁的护栏：件数/方数/重量三个字段**不许出现在 update 里**
     *     （排查第 3 条拍板：整票记录卸柜不许改运单数字）。
     */
    // 4a) 运输中 / 已签收 / 异常：都要退回「已入库」+ 写轨迹，数字一个不动
    for (const cur of ["departed", "delivered", "exception"]) {
      // makeTx 第一个参数在这条分支里当「运单自己」用（mock 的 findFirst 不分对象）
      const { tx, 记录 } = makeTx({ id: "s_child", currentStatus: cur });
      const r = await unloadItemFully(tx as any, { id: "i_1", shipment: 子单({ parentTrackingNo: null }) }, "c_1");
      assert.deepEqual(记录.删掉的柜内记录, ["i_1"], "柜内记录没删");
      assert.deepEqual(记录.删掉的运单, [], "把整票货的运单删掉了 —— 客户的单会凭空消失");
      assert.equal(r.删了子单, false);
      assert.ok(记录.父单更新, `整票卸柜后没有动运单（${cur}）—— 状态没退回`);
      assert.equal(记录.父单更新.currentStatus, "inWarehouseCN", `${cur} 的整票卸柜后状态没退回「已入库」—— 客户看到的还是假状态`);
      assert.ok(!("packageCount" in 记录.父单更新), "整票卸柜动了件数 —— 排查第 3 条拍板不许改");
      assert.ok(!("volumeM3" in 记录.父单更新), "整票卸柜动了方数 —— 排查第 3 条拍板不许改");
      assert.ok(!("weightKg" in 记录.父单更新), "整票卸柜动了重量 —— 排查第 3 条拍板不许改");
      assert.equal(记录.轨迹.length, 1, "没写轨迹 —— 客户会觉得状态莫名其妙变了");
      assert.ok(String(记录.轨迹[0].id).startsWith("sl_unld_"), `轨迹 id 前缀不是 sl_unld_：${记录.轨迹[0].id}`);
      assert.equal(记录.轨迹[0].fromStatus, cur, "轨迹的起点状态不对");
      assert.equal(记录.轨迹[0].toStatus, "inWarehouseCN", "轨迹的终点状态不对");
      assert.ok(/退回国内仓/.test(记录.轨迹[0].remark), `轨迹备注看不懂：${记录.轨迹[0].remark}`);
    }
    // 4b) 已退回 / 已取消：业务已终止，不许因卸柜复活；只留 fromStatus=toStatus 的备注轨迹
    for (const cur of ["returned", "cancelled"]) {
      const { tx, 记录 } = makeTx({ id: "s_child", currentStatus: cur });
      await unloadItemFully(tx as any, { id: "i_1", shipment: 子单({ parentTrackingNo: null }) }, "c_1");
      assert.equal(记录.父单更新, null, `${cur} 的整票运单被拽回了 —— 已终止的单不许复活`);
      assert.equal(记录.轨迹.length, 1, `${cur} 卸柜该留一条备注轨迹给排查用`);
      assert.equal(记录.轨迹[0].fromStatus, cur, "备注轨迹的起点状态不对");
      assert.equal(记录.轨迹[0].toStatus, cur, `${cur} 的备注轨迹不该改状态`);
      assert.ok(/已退回\/已取消，卸柜不改变其状态/.test(记录.轨迹[0].remark), `备注轨迹措辞不对：${记录.轨迹[0].remark}`);
    }
    // 4c) 还在国内仓（已创建/已入库/暂缓装柜）：状态不动、也不刷轨迹
    for (const cur of ["created", "inWarehouseCN", "holdLoading"]) {
      const { tx, 记录 } = makeTx({ id: "s_child", currentStatus: cur });
      await unloadItemFully(tx as any, { id: "i_1", shipment: 子单({ parentTrackingNo: null }) }, "c_1");
      assert.equal(记录.父单更新, null, `整票运单是 ${cur} 时不该动它的状态`);
      assert.equal(记录.轨迹.length, 0, `整票运单是 ${cur} 时还写了轨迹（刷屏）`);
    }
  });

  await check("5) 删柜子：柜里每一条都要卸，而且按 id 排序（锁序规矩）", async () => {
    /**
     * ⚠️ 这就是「删柜子把子单变孤儿」那个 bug。
     * 原来删柜子只 deleteMany 柜内记录，子单原样留着、父单数字回不来。
     * ⚠️ 用**乱序**的 id 喂进去，确认它按 id 排序处理 ——
     *    同一批行的加锁顺序必须固定，不然会跟别处死锁。
     */
    const items = [
      { id: "i_c", shipment: 子单({ id: "s_c" }) },
      { id: "i_a", shipment: 子单({ id: "s_a" }) },
      { id: "i_b", shipment: 子单({ id: "s_b" }) },
    ];
    const { tx, 记录 } = makeTx({ id: "s_parent", packageCount: 0, volumeM3: 0, weightKg: 0, currentStatus: "loaded" }, items);
    const n = await unloadAllItemsOfContainer(tx as any, "ct_1", "c_1");
    assert.equal(n, 3, "没有把柜里三条都卸掉");
    assert.deepEqual(记录.删掉的柜内记录, ["i_a", "i_b", "i_c"], "没有按 id 排序处理 —— 会跟别处反向加锁");
    assert.deepEqual(记录.删掉的运单, ["s_a", "s_b", "s_c"], "子单没删干净 —— 会变成孤儿");
  });

  await check("6) 空柜子直接删，不用做别的", async () => {
    const { tx, 记录 } = makeTx(null, []);
    const n = await unloadAllItemsOfContainer(tx as any, "ct_1", "c_1");
    assert.equal(n, 0);
    assert.deepEqual(记录.删掉的柜内记录, []);
  });

  await check("7) 两条路必须走同一份实现（改一处不能漏另一处）", async () => {
    /**
     * ⚠️ 这个项目里「N 个入口只修了 M 个」已经犯过五六次。
     * 这一项盯着：卸柜和删柜子都得调 unload-item 里那两个函数，不许自己再写一遍。
     * ⚠️ 只能证明「源码里写了」，证明不了运行时 —— 真正的守卫是上面 1~6 项。
     */
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const 剔注释 = (t: string): string =>
      t.split("\n").filter((l) => {
        const s2 = l.trim();
        return !s2.startsWith("*") && !s2.startsWith("//") && !s2.startsWith("/*");
      }).join("\n");
    const api = path.join(__dirname, "..", "apps", "api", "src", "modules");
    const 卸柜 = 剔注释(fs.readFileSync(path.join(api, "loading-manifests", "routes.ts"), "utf-8"));
    const 删柜 = 剔注释(fs.readFileSync(path.join(api, "containers", "routes.ts"), "utf-8"));
    assert.ok(/unloadItemFully\(/.test(卸柜), "卸柜没走共用实现");
    assert.ok(/unloadAllItemsOfContainer\(/.test(删柜), "删柜子没走共用实现");
    assert.ok(
      !/shipmentContainerItem\.deleteMany\(\s*\{\s*where:\s*\{\s*containerId/.test(删柜),
      "删柜子还留着直接 deleteMany 柜内记录的写法 —— 那就是子单变孤儿的病根",
    );
  });

  await check("8) 部分卸柜还货给父单：真调 remove-shipment 路由，退状态和写轨迹必须真的发生", async () => {
    /**
     * 2026-09-02 三审整改（P3）：这一项从「扫源码」升级成**真调路由**。
     * 前两版（grep 字符串 → 锚点圈段找活代码）都被 Codex 变异实测打脸：
     * 把「要退状态」永久改成 false 后仍全绿 —— 因为那几个字样还在源码里活着，
     * 只是条件永远不成立。扫源码证明不了运行时行为，这个教训项目里已经第五次了。
     *
     * 现在照 test-client-address-update.ts / test-product-rows.ts 第 11 项的写法：
     * 真注册 loading-manifests 路由，拿到 POST /staff/loading-manifests/remove-shipment
     * 的 handler 真调；假 prisma 的 $transaction 直接把假 tx 递给回调，全程不连库。
     *
     * 变异自证（2026-09-02 真做过）：routes.ts 里「要退状态」写死 false → 本项变红
     * （父单 update 里没有 currentStatus + 没写 sl_unld_ 轨迹两条一起报）；还原后全绿。
     */
    const routes = new Map<string, Handler>();
    const fakeApp: any = {
      get(p: string, h: Handler) { routes.set(`GET ${p}`, h); },
      post(p: string, h: Handler) { routes.set(`POST ${p}`, h); },
      delete(p: string, h: Handler) { routes.set(`DELETE ${p}`, h); },
      listen() {},
    };
    const mod = await import("../apps/api/src/modules/loading-manifests/routes");
    (mod as any).registerLoadingManifestRoutes(fakeApp);
    const handler = routes.get("POST /staff/loading-manifests/remove-shipment");
    assert.ok(handler, "没注册到 POST /staff/loading-manifests/remove-shipment —— 路由被改名/搬家了，这一项要跟着改");

    const call卸柜 = async (body: unknown): Promise<{ status: number; message: string }> => {
      let status = 0;
      let payload: any = {};
      const res: any = { status(c: number) { status = c; return res; }, json(v: unknown) { payload = v; } };
      await handler!({
        method: "POST", path: "", query: {}, headers: {}, body,
        auth: { userId: "STAFF1", companyId: "c_1", role: "staff", name: "测试员工", agentId: null },
      }, res);
      // 成功时 ok() 包成 { data: { message } }，失败时 fail() 是顶层 message
      return { status, message: payload?.data?.message ?? payload?.message ?? "" };
    };

    // 一条柜内记录：柜里装着 30 件，只卸 10 件（10 < 30 → 走部分卸柜分支）
    const 柜内记录 = (parentTrackingNo: string | null) => ({
      id: "i_1", containerId: "ct_1", shipmentId: "s_child",
      loadedPieceCount: 30,
      // ⚠️ 故意比运单总方数小（0.9 < 1.5）：顺带盯住 2026-08-31 修的
      // 「部分卸柜把已装方数按运单总体积重算覆盖」那个 bug 不复发
      loadedVolumeM3: 0.9,
      shipment: { id: "s_child", parentTrackingNo, packageCount: 30, volumeM3: 1.5, weightKg: 120 },
    });

    // 8a) 子单带父单、父单状态已前进（departed）→ 必须退回「已入库」+ 写 sl_unld_ 轨迹
    {
      const { 记录 } = 装路由假tx({
        item: 柜内记录("YW0001"),
        // ⚠️ 父单三个数字互不相同（5 件 / 2 方 / 50kg），防「凑巧相等」假绿
        parent: { id: "s_parent", packageCount: 5, volumeM3: 2, weightKg: 50, currentStatus: "departed" },
      });
      const r = await call卸柜({ itemId: "i_1", pieceCount: 10 });
      assert.equal(r.status, 200, `部分卸柜没走通：${r.status} ${JSON.stringify(r.message)}`);
      assert.ok(记录.父单更新, "父单根本没被 update —— 还货那段没跑到");
      assert.equal(记录.父单更新.currentStatus, "inWarehouseCN",
        "父单状态没退回「已入库」——「要退状态」那条判断是死的，客户会一直看到旧状态");
      /**
       * ⚠️ 这条分支跟第 4 项那个「整票不许动数字」的口径**正好相反**：
       * 还货给父单时，件数/方数/重量三兄弟**必须出现在父单 update 里而且加对**
       * （5+10 件 / 2+0.5 方 / 50+40 kg）—— 卸下来的货凭空消失才是 bug。
       * 「三兄弟不许出现」只适用于没父单的整票记录，那个在下面 8b 盯。
       */
      assert.equal(记录.父单更新.packageCount, 15, "件数没还回父单（5 + 10）");
      assert.equal(Number(记录.父单更新.volumeM3), 2.5, "方数没还回父单（2 + 0.5）");
      assert.equal(Number(记录.父单更新.weightKg), 90, "重量没还回父单（50 + 40）");
      assert.equal(记录.轨迹.length, 1, "没写 sl_unld_ 轨迹 —— 客户会觉得状态莫名其妙变了");
      assert.ok(String(记录.轨迹[0].id).startsWith("sl_unld_"), `轨迹 id 前缀不是 sl_unld_：${记录.轨迹[0].id}`);
      assert.equal(记录.轨迹[0].fromStatus, "departed", "轨迹的起点状态不对");
      assert.equal(记录.轨迹[0].toStatus, "inWarehouseCN", "轨迹的终点状态不对");
      assert.ok(/退回国内仓/.test(记录.轨迹[0].remark), `轨迹备注看不懂：${记录.轨迹[0].remark}`);
      // 柜内记录按**自己的已装量**等比缩：0.9 × 20/30 = 0.6（不是按运单总方数 1.5 重算）
      assert.equal(记录.柜内记录更新?.loadedPieceCount, 20, "柜内记录件数没减对（30 − 10）");
      assert.equal(Number(记录.柜内记录更新?.loadedVolumeM3), 0.6, "柜内已装方数没按记录自己的已装量等比缩（0.9 × 20/30）");
      // 子单自己也要砍小，砍下来的那份才是还给父单的
      assert.equal(记录.子单更新?.packageCount, 20, "子单件数没砍成 20（30 − 10）");
    }

    // 8b) 整票记录（没父单）部分卸柜：运单的件数/方数/重量三兄弟一个都不许动
    //     （排查第 3 条拍板；2026-08-31 修过「先把运单砍小、又没人收还货」的凭空消失 bug）
    {
      const { 记录 } = 装路由假tx({ item: 柜内记录(null) });
      const r = await call卸柜({ itemId: "i_1", pieceCount: 10 });
      assert.equal(r.status, 200, `整票部分卸柜没走通：${r.status} ${JSON.stringify(r.message)}`);
      assert.equal(记录.运单更新次数, 0, "整票部分卸柜动了运单 —— 件数/方数/重量会凭空变小");
      assert.equal(记录.轨迹.length, 0, "整票部分卸柜不该写状态轨迹");
      assert.equal(记录.柜内记录更新?.loadedPieceCount, 20, "柜内记录件数没减对（30 − 10）");
    }
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length}/${总项数} 项不通过：${failures.join("；")}`);
    process.exit(1);
  }
  console.log(`从柜子里卸货：${总项数} 项全部通过`);
}

main().catch((e) => { console.error(e); process.exit(1); });
