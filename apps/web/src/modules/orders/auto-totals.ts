/**
 * 建单 / 下预报单时，产品行自动算出来的总体积、总重量怎么往表单里填（2026-09-29，员工页和客户页共用）。
 *
 * 规矩（Codex / dsh 复查后定下的）：
 *   · 总体积：有产品行时那个框是只读的，一律跟着产品行算；产品行算出来是 0 或者删光了，
 *     框里还是「上一次自动填的」就清空，是别的（比如不分产品行时按整票长宽高算的）不动。
 *   · 总重量：有产品行时也能手改。框里是空的、或者还是上一次自动填的，才用新算出来的；
 *     人手改过的（比如按实际称重改的）不动。产品行算出来是 0 或者删光了，也只清「自动填的」。
 *   · 原来的毛病：① 产品行删光时直接 return，旧合计留在框里照样提交；
 *                ② 产品行算出来不是 0 就无条件覆盖，手改的重量改一下品名就被改回去。
 *
 * 纯函数：只看传进来的值，重复调用结果一样（React 严格模式下 setState 的回调会被调两次）。
 */
export interface AutoTotalsMemory {
  /** 上一次自动填进总体积框的值；null = 框里现在的值不是自动填的 */
  volumeM3: string | null;
  /** 上一次自动填进总重量框的值；null = 框里现在的值不是自动填的 */
  weightKg: string | null;
}

export function nextAutoTotals(
  current: { volumeM3: string; weightKg: string },
  memory: AutoTotalsMemory,
  /** 产品行算出来的总体积（已格式化）；null = 算出来是 0 / 没有产品行 */
  volStr: string | null,
  /** 产品行算出来的总重量（已格式化）；null = 算出来是 0 / 没有产品行 */
  wtStr: string | null,
): { volumeM3: string; weightKg: string; memory: AutoTotalsMemory } {
  const volIsAuto = memory.volumeM3 !== null && current.volumeM3 === memory.volumeM3;
  const volumeM3 = volStr !== null ? volStr : (volIsAuto ? "" : current.volumeM3);

  const wtIsAuto = memory.weightKg !== null && current.weightKg === memory.weightKg;
  const weightKg = wtStr !== null
    ? (current.weightKg === "" || wtIsAuto ? wtStr : current.weightKg)
    : (wtIsAuto ? "" : current.weightKg);

  return {
    volumeM3,
    weightKg,
    memory: {
      volumeM3: volStr,
      weightKg: wtStr !== null && weightKg === wtStr ? wtStr : null,
    },
  };
}
