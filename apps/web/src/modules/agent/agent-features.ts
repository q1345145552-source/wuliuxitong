/**
 * 代理工作台：暂时关掉的分区（2026-09-18 老板拍板）。
 *
 * 老板原话：「代理的话直接把这个功能的前端页面先屏蔽掉吧，暂时不对代理开放集货拼柜的功能，
 * 对应的映射那些也一起关掉，就是余额，价格设置那些。但是后端暂时保留一下，以后可能会用。」
 *
 * 所以：
 *   · 关掉的是**前端入口**（菜单 + 分区渲染 + 首页那几张集货卡片）；
 *   · 组件（AgentWhr / AgentWallet / AgentClients / AgentMe）和后端接口（/agent/whr*、/agent/wallet*、
 *     /agent/clients*、/agent/me）**一律留着**，以后要开回来就把下面这个开关改成 true；
 *   · 关的时候连请求都不许发（关了还去拉数据，等于白占后端）。
 *
 * ⚠️ 这个开关只管代理端。湘泰自己的客户端集货余额、超管/员工的集货拼柜都不受它影响。
 */
export const AGENT_WHR_FEATURES_ENABLED = false;

/** 跟着上面这个开关一起关的分区 id（跟 menu-config.ts 的 # 和 /agent 页面的分区一一对应） */
export const AGENT_DISABLED_SECTIONS = ["whr", "clients", "wallet", "me"] as const;

/** 这个分区现在开着吗 */
export function isAgentSectionEnabled(section: string): boolean {
  if (AGENT_WHR_FEATURES_ENABLED) return true;
  return !(AGENT_DISABLED_SECTIONS as readonly string[]).includes(section);
}
