/**
 * 发下一个业务单号的序号，号只往上加、删了也不回收（2026-09-29 老板选 A）。
 *
 * 原来五种单号（JH 集货任务 / JH-YW 集货预报单 / WHR 仓库版计划 / WHRP 仓库版预报单 / WD 尾端派送单）
 * 都是「库里现有最大号 + 1」：删掉最新那张单，下一张新单就拿回同一个号（测试库实测 JH0000002 删了又发出一个 JH0000002），
 * 客户余额流水里同一个单号对着两张不同的单。
 *
 * 现在：number_sequences 表记着每个号段「已经发到第几号」，这次发 max(记录, 库里现有最大号) + 1，并把记录推到这个号。
 *   · 记录只往上走，所以删掉的号不会再发；
 *   · 还带着「库里现有最大号」一起比：表刚建好是空的、或者有人绕过这里插了更大的号，也不会发出重号。
 *
 * ⚠️ 必须在**插入新单的那个事务**里、**在该号段原来那把咨询锁之后**调：
 *   记录这一行的行锁跟着事务走，插入失败回滚时这次推上去的记录也一起退回（没插进去的号不算发过）；
 *   号段的咨询锁照旧先拿，所以同一个号段永远排队，不会引入新的锁顺序。
 */
export async function nextSequenceValue(tx: any, name: string, currentMax: number): Promise<number> {
  const floor = Number.isFinite(currentMax) && currentMax > 0 ? Math.floor(currentMax) : 0;
  const rows: Array<{ last_value: bigint | number }> = await tx.$queryRaw`
    INSERT INTO number_sequences (name, last_value, updated_at)
    VALUES (${name}, ${floor}::bigint + 1, NOW())
    ON CONFLICT (name) DO UPDATE
      SET last_value = GREATEST(number_sequences.last_value, ${floor}::bigint) + 1,
          updated_at = NOW()
    RETURNING last_value
  `;
  return Number(rows[0].last_value);
}
