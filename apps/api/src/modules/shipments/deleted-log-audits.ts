/**
 * 轨迹删除存底（audit_logs 里 action=DELETE、resourceType=StatusLog 的行）按运单 id 找。
 *
 * 删除接口把被删的那条记录整条 JSON 存进 beforeJson，里面的 shipmentId 不会变；
 * 备注里的「删除物流轨迹 <运单号>」在运单号改过以后就对不上了（Codex 第三批 P2-1：改号后管理员按新号查不到）。
 * 管理员「删过的记录」、整柜撤销自动放回「装入柜子」、老柜子撤销找员工删过的推进记录，三处都走这一份。
 *
 * 返回最近删的在前；调用方拿到后仍要解析 beforeJson、核对 shipmentId（这里是按文本包含查的）。
 */
export async function findDeletedLogAudits(
  db: any,
  companyId: string,
  shipmentIds: string[],
): Promise<Array<{ id: string; actorId: string; resourceId: string; beforeJson: string | null; createdAt: Date }>> {
  const ids = [...new Set(shipmentIds)];
  if (ids.length === 0) return [];
  return db.auditLog.findMany({
    where: {
      companyId,
      action: "DELETE",
      resourceType: "StatusLog",
      OR: ids.map((id) => ({ beforeJson: { contains: `"shipmentId":${JSON.stringify(id)}` } })),
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, actorId: true, resourceId: true, beforeJson: true, createdAt: true },
  });
}
