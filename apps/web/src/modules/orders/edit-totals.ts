/**
 * 2026-10-16 从 apps/web/src/app/admin/page.tsx 原样挪过来（超管「运单管理」编辑弹窗和到货通知里改已转正式运单的那条共用一份，
 * 两边存出来的总重量 / 总体积口径一样）。
 */
/**
 * 编辑运单时「总重量/总体积到底听谁的」的裁决（2026-08-31，排查报告第22条）。
 * 老毛病：只要任何一行产品填了尺寸，手填的总体积就被静默扔掉 —— 三行货仓库只量了
 * 一箱的尺寸，管理员手填实际总体积 3.5 方，保存后悄悄变成那一箱的 0.6 方，没人察觉。
 * 现在的规则：
 * - 每一行都填齐了尺寸（或单箱重）→ 数据齐全，按产品行自动算，手填值不生效；
 * - 有行没填齐 → 手填了就以手填为准；没手填才拿不完整的自动值凑合（跟原来一致）；
 * - 哪边生效通过 notes 在编辑框旁边和保存提示里明说，不再静默。
 * 保存和界面提示都调这一个函数，保证两边口径一致。
 */
export function decideEditTotals(
  products: Array<{ packageCount: string; lengthCm: string; widthCm: string; heightCm: string; weightKg: string }>,
  manualWeightRaw: string,
  manualVolumeRaw: string,
): { finalWeight: number | null; finalVolume: number | null; notes: string[] } {
  let autoVolume = 0;
  let autoWeight = 0;
  let dimRows = 0;
  let weightRows = 0;
  for (const p of products) {
    const qty = Number(String(p.packageCount).trim()) || 0;
    const l = Number(p.lengthCm);
    const w = Number(p.widthCm);
    const h = Number(p.heightCm);
    if (l > 0 && w > 0 && h > 0) {
      autoVolume += (l * w * h * qty) / 1_000_000;
      dimRows++;
    }
    const pw = Number(p.weightKg);
    if (pw > 0) {
      autoWeight += pw * qty;
      weightRows++;
    }
  }
  const manualVolume = manualVolumeRaw.trim() ? Number(manualVolumeRaw) : null;
  const manualWeight = manualWeightRaw.trim() ? Number(manualWeightRaw) : null;
  const notes: string[] = [];

  let finalVolume: number | null;
  if (products.length > 0 && dimRows === products.length) {
    finalVolume = autoVolume;
    if (manualVolume !== null && Math.abs(manualVolume - autoVolume) > 0.0005) {
      notes.push(`产品行尺寸已填齐：总体积按尺寸自动算为 ${autoVolume.toFixed(3)} m³，手填的 ${manualVolume} 不生效`);
    }
  } else if (dimRows > 0) {
    if (manualVolume !== null) {
      finalVolume = manualVolume;
      notes.push(`产品行尺寸没填齐（${dimRows}/${products.length} 行有尺寸）：总体积以手填的 ${manualVolume} m³ 为准`);
    } else {
      finalVolume = autoVolume;
      notes.push(`产品行尺寸没填齐、也没手填总体积：先按已填尺寸的 ${dimRows} 行算出 ${autoVolume.toFixed(3)} m³，偏小`);
    }
  } else {
    finalVolume = manualVolume;
  }

  let finalWeight: number | null;
  if (products.length > 0 && weightRows === products.length) {
    finalWeight = autoWeight;
    if (manualWeight !== null && Math.abs(manualWeight - autoWeight) > 0.005) {
      notes.push(`产品行单箱重已填齐：总重量自动算为 ${autoWeight.toFixed(2)} kg，手填的 ${manualWeight} 不生效`);
    }
  } else if (weightRows > 0) {
    if (manualWeight !== null) {
      finalWeight = manualWeight;
      notes.push(`产品行单箱重没填齐（${weightRows}/${products.length} 行有重量）：总重量以手填的 ${manualWeight} kg 为准`);
    } else {
      finalWeight = autoWeight;
      notes.push(`产品行单箱重没填齐、也没手填总重量：先按已填重量的 ${weightRows} 行算出 ${autoWeight.toFixed(2)} kg，偏小`);
    }
  } else {
    finalWeight = manualWeight;
  }

  return { finalWeight, finalVolume, notes };
}
