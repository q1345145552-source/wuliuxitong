/** 物流轨迹弹窗里的时间怎么显示（2026-09-29 从 ShipmentTrackModal.tsx 挪出来，测试能直接调） */

/* 轨迹时间一律按北京时间显示（2026-09-29 Codex 全系统检查）：原来按看的人电脑的时区，
   泰国客户看到的比员工看到的早 1 小时，两边对不上。系统别处的时间都是北京时间（modules/staff/utils 的 formatBeijingTime）。 */
function beijingParts(iso: string): Date {
  return new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000); // 下面一律用 getUTC* 读，读出来就是北京时间
}

export function formatTime(iso: string): string {
  const d = beijingParts(iso);
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hour = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${min}`;
}
