/**
 * 湘泰物流 — 共享业务常量
 * 前后端共用，避免硬编码分散。
 */

/** 默认运费（元/立方米） */
export const DEFAULT_SHIPPING_PRICES = {
  sea: 550,
  land: 1070,
} as const;

/** 敏感货物加价（元/立方米） */
export const INSPECTION_SURCHARGE = 150;
export const SENSITIVE_SURCHARGE = 250;
