/**
 * 实时推送：每个「改数据」的接口算哪一类变化（2026-10-05 老板要做 app：「数据都能连接上，不能有延迟」）。
 *
 * ⚠️ 只推「哪一类变了」，**不推内容**。页面收到后照旧调自己原来的接口重新拉 ——
 * 权限、公司隔离、柜号脱敏全都还是原来那一套，推送这条路不多漏任何数据，
 * 也不用 120 多个改数据的接口一个个去改。
 *
 * 分类故意分得粗：页面订自己关心的几类，宁可多拉一次，不能漏拉。
 * 新加改数据的接口不用改这里 —— 落到最后的「shipping」也会推（宁多勿漏）；
 * 只有确定「改了别人也看不见」的才进 SKIP。测试 test:realtime-source 会把全部接口过一遍。
 */
export const REALTIME_TOPICS = [
  "shipping", // 运单 / 预报单 / 装柜 / 柜子 / 尾端派送 / 地址
  "consolidation", // 普通版集货
  "whr", // 仓库版集货
  "fcl", // 整柜管理 + 整柜询价
  "chat", // 客服对话
  "wallet", // 集货余额 / 充值
  "accounts", // 账号、代理、代理返佣
  "config", // 运费 / 状态名 / 清关 / AI 知识库等配置
] as const;

export type RealtimeTopic = (typeof REALTIME_TOPICS)[number];

/** 客户能收到的分类（账号类是员工管的，客户收了也没页面用） */
export const CLIENT_TOPICS: ReadonlySet<RealtimeTopic> = new Set<RealtimeTopic>([
  "shipping", "consolidation", "whr", "fcl", "chat", "wallet", "config",
]);

/** 代理能收到的分类（代理端只有客户、价格、返佣、查运单） */
export const AGENT_TOPICS: ReadonlySet<RealtimeTopic> = new Set<RealtimeTopic>(["shipping", "accounts", "config"]);

/**
 * 改了也不用通知任何页面的接口：登录 / 退出 / 改自己密码、通知订阅开关、客户问 AI。
 * ⚠️ 只放「确定别的页面看不到变化」的。拿不准就别放，多推一次只是多拉一次。
 */
const SKIP_EXACT: ReadonlySet<string> = new Set([
  "/auth/login",
  "/auth/logout",
  "/auth/change-password",
  "/client/ai/chat",
  "/client/chat/push/subscribe",
  "/client/chat/push/unsubscribe",
  "/staff/chat/push/subscribe",
  "/staff/chat/push/unsubscribe",
]);

/** 改数据接口 → 分类；返回 null 表示不推 */
export function topicForWrite(path: string): RealtimeTopic | null {
  if (SKIP_EXACT.has(path)) return null;
  if (/^\/(client|staff)\/chat\//.test(path)) return "chat";
  if (path.includes("/whr-consolidation/") || path === "/admin/clients/whr-price") return "whr";
  if (path.includes("/consolidation/")) return "consolidation";
  if (/\/fcl-(containers|inquiries)(\/|$)/.test(path)) return "fcl";
  if (path.includes("/wallet/")) return "wallet";
  if (/^\/admin\/(users|clients|agents)(\/|$)/.test(path) || path.startsWith("/agent/") || path === "/auth/register") {
    return "accounts";
  }
  if (/^\/admin\/(shipping|system|customs|ai|lmp)(\/|$)/.test(path)) return "config";
  if (/^\/(admin|staff|client)\//.test(path)) return "shipping";
  return null;
}
