/**
 * 表单里「整格」核对数字（2026-09-29 Codex 全系统检查）。
 * 原来用 parseInt / parseFloat 只读开头：件数「1.9」读成 1、「12abc」读成 12，客户看不到任何提示。
 */

/** 整格是正整数（「3」行，「1.9」「12abc」「 」不行） */
export function isPositiveIntText(v: string | null | undefined): boolean {
  const t = (v ?? "").trim();
  return /^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= 2147483647;
}

/** 整格是大于 0 的数字（「1.25」行，「1.25kg」「abc」「-1」不行） */
export function isPositiveNumberText(v: string | null | undefined): boolean {
  const t = (v ?? "").trim();
  return /^\d+(\.\d+)?$/.test(t) && Number(t) > 0;
}
