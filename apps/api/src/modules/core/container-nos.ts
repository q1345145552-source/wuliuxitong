/**
 * 给客户 / 代理看的备注抹柜号时用的「本公司全部柜号」（2026-09-28，Codex 复核第 2 条）。
 *
 * 原来只传「这票货现在装着的柜」：员工先在备注里写了柜号、后来把货从柜里卸下来（卸柜会删柜内记录），
 * 那个柜号就不在名单里了，客户重新看得到。现在按本公司所有柜号精确抹，再加 client-privacy 里按标准柜号样子认的那一道。
 *
 * ⚠️ 柜号跟某张运单号一模一样的不列进来（生产库只读核过 2026-09-28：323 个柜里有 24 个，「JL…」那种）——
 *    那个号本来就是客户看得到的运单号，抹了反而把客户自己的运单号也抹掉。
 * 60 秒缓存：客户页面十来秒刷一次，没必要每次都查一遍柜子表。新建的柜最多晚 60 秒进名单，
 * 期间「这票货装着的柜」那份名单照样在（调用方会一起传）。
 * 列名已对 schema.prisma 核过：containers.container_no / company_id，shipments.tracking_no / company_id。
 */
import { prisma } from "../../db/prisma";

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; list: string[] }>();

export async function companyContainerNosForMasking(companyId: string): Promise<string[]> {
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.list;
  const rows = await prisma.$queryRaw<Array<{ container_no: string }>>`
    SELECT c.container_no
    FROM containers c
    WHERE c.company_id = ${companyId}
      AND NOT EXISTS (
        SELECT 1 FROM shipments s
        WHERE s.company_id = c.company_id AND lower(s.tracking_no) = lower(c.container_no)
      )`;
  const list = rows.map((r) => r.container_no).filter((no): no is string => typeof no === "string" && no.trim().length > 0);
  cache.set(companyId, { at: Date.now(), list });
  return list;
}

/** 测试用：清掉缓存（测试里新建了柜子要马上生效） */
export function clearContainerNosCache(): void {
  cache.clear();
}
