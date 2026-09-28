/**
 * 给客户 / 代理看的备注抹柜号时用的「本公司全部柜号」（2026-09-28，Codex 复核第 2 条）。
 *
 * 原来只传「这票货现在装着的柜」：员工先在备注里写了柜号、后来把货从柜里卸下来（卸柜会删柜内记录），
 * 那个柜号就不在名单里了，客户重新看得到。现在按本公司所有柜号精确抹，再加 client-privacy 里按标准柜号样子认的那一道。
 *
 * ⚠️ 柜号跟**看的这个客户自己的**运单号一模一样的不抹（生产只读核过 2026-09-28：323 个柜里有 24 个柜号就是运单号，
 *    「JL20260701-…」那种，分属 5 个客户）—— 那是这个客户自己本来就看得到的运单号，抹了反而看不懂。
 *    原来是「跟全公司任何一张运单号一样就不抹」（2026-09-28 分支审查 Codex 复看第 2 条）：别的客户备注里写了这个号，
 *    照样原样给人家看。现在按调用方传进来的「看的人是哪些客户」来排：别人的运单号兼柜号照抹。
 * ⚠️ 不做缓存（2026-09-28 分支审查，Codex 第 2 条）：原来缓存 60 秒，新建的柜号 60 秒内被员工写进别的单的备注，
 *    客户这 60 秒里照样看得到。生产只读实测这句查询 15 毫秒（柜子 + 运单 / 订单柜号 + 集货任务柜号全算上），
 *    每次现查代价很小，就不要这个窗口了。
 * 列名已对 schema.prisma 核过：containers.container_no / company_id，shipments.tracking_no / batch_no / container_no / order_id / company_id，
 * orders.client_id / batch_no，consolidation_tasks.container_no。
 */
import { prisma } from "../../db/prisma";

/**
 * @param viewerClientIds 看这份备注的是哪些客户（客户自己 = [自己的唛头]；代理 = 名下全部客户；给某个客户签字的签收单 = [那个客户]）。
 *        这些客户自己的运单号不抹；不传 = 一律照抹。
 * @param extraNos 调用方手上另外要抹的柜号（这票货装过的柜、本任务 / 本整柜的柜号）。**一定要从这里传进来**，
 *        别在外面自己拼到结果后面 —— 外面拼的绕开了「看的人自己的运单号不抹」（2026-09-29 实跑发现：
 *        柜号正好是客户自己的运单号、货又装在这个柜里，客户查轨迹时自己的单号被抹成「柜号已隐藏」）。
 */
export async function companyContainerNosForMasking(companyId: string, viewerClientIds: readonly string[] = [], extraNos: readonly (string | null | undefined)[] = []): Promise<string[]> {
  /* 2026-09-28 分支审查：柜号不只存在柜子表里 ——
       · 运单 / 订单上「柜号」那一格（batch_no，收货弹窗里填的）；
       · 运单上的「装柜号」（shipments.container_no，超管编辑里那一格；生产目前 0 条，堵以后的口子）；
       · 普通版集货任务装柜时填的柜号（consolidation_tasks.container_no）。
     员工在这些格里填了、柜子表里没建过（或写法不一样）的号，照样会被员工抄进备注。几处合在一起抹。
     生产只读核过：现在 batch_no 里的号全都在柜子表里，这一步是堵以后的口子。生产实测这句 15 毫秒。 */
  const rows = await prisma.$queryRaw<Array<{ container_no: string }>>`
    SELECT DISTINCT btrim(v.no) AS container_no
    FROM (
      SELECT c.container_no AS no FROM containers c WHERE c.company_id = ${companyId}
      UNION ALL
      SELECT s.batch_no FROM shipments s WHERE s.company_id = ${companyId} AND s.batch_no IS NOT NULL
      UNION ALL
      SELECT s.container_no FROM shipments s WHERE s.company_id = ${companyId} AND s.container_no IS NOT NULL
      UNION ALL
      SELECT o.batch_no FROM orders o WHERE o.company_id = ${companyId} AND o.batch_no IS NOT NULL
      UNION ALL
      SELECT t.container_no FROM consolidation_tasks t WHERE t.company_id = ${companyId} AND t.container_no IS NOT NULL
    ) v
    WHERE btrim(coalesce(v.no, '')) <> ''`;
  // 看的人自己的运单号（小写）：这些不抹。原写法和去空格写法都要比 —— 去空格那个也可能正好是自己的运单号
  const own = new Set<string>();
  const ids = [...new Set(viewerClientIds.filter((id) => typeof id === "string" && id.trim() !== ""))];
  if (ids.length > 0) {
    const mine = await prisma.$queryRaw<Array<{ t: string }>>`
      SELECT lower(s.tracking_no) AS t
      FROM shipments s JOIN orders o ON o.id = s.order_id
      WHERE s.company_id = ${companyId} AND o.client_id = ANY(${ids})`;
    for (const r of mine) if (typeof r.t === "string") own.add(r.t);
  }
  const list: string[] = [];
  const candidates = [...rows.map((r) => r.container_no), ...extraNos];
  for (const raw of candidates) {
    const no = typeof raw === "string" ? raw.trim() : "";
    if (!no) continue;
    if (!own.has(no.toLowerCase())) list.push(no);
    // 填的时候中间带了空格（「L26 0821 9129」），备注里常常连着写（「L2608219129」）：两种写法都抹
    const compact = no.replace(/\s+/g, "");
    if (compact !== no && !own.has(compact.toLowerCase())) list.push(compact);
  }
  return list;
}

/** 原来清 60 秒缓存用的；现在不缓存了，留着是因为几份测试还在调（调了也无害） */
export function clearContainerNosCache(): void {
  /* 不缓存，没东西可清 */
}
