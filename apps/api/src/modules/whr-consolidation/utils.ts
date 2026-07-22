import { prisma } from "../../db/prisma";

/**
 * 同步计划状态：根据计划下所有客户的状态自动推进计划状态
 * - 所有客户都不再是 filling → plan = loading
 * - 所有客户都是 thailand_received 或 cancelled → plan = completed
 */
export async function syncPlanStatus(
  planId: string,
  tx: any // Prisma transaction client
): Promise<string | null> {
  const customers = await tx.whrConsolidationPlanCustomer.findMany({
    where: { planId },
    select: { status: true },
  });

  if (customers.length === 0) return null;

  const allPastFilling = customers.every(
    (c: any) => c.status !== "filling"
  );
  const allDone = customers.every(
    (c: any) => c.status === "thailand_received" || c.status === "cancelled"
  );

  let newStatus: string | null = null;

  if (allDone) {
    newStatus = "completed";
  } else if (allPastFilling) {
    newStatus = "loading";
  }

  if (newStatus) {
    const plan = await tx.whrConsolidationPlan.findUnique({
      where: { id: planId },
      select: { status: true },
    });
    if (plan && plan.status !== newStatus && plan.status !== "completed") {
      await tx.whrConsolidationPlan.update({
        where: { id: planId },
        data: { status: newStatus },
      });
    }
  }

  return newStatus;
}
