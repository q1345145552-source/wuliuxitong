"use client";

/**
 * 代理工作台（2026-09-16）。需求：确认单第 3 节；做法：技术设计第 6 节。
 *
 * 只有这一页，分区用 #（/agent/xxx 全留给接口转发，见 next.config.ts）。
 * 外壳（左边菜单、登录核验、角色闸）由根布局的 WorkbenchFrame 统一套上 —— 这里**不许**再包 RoleShell。
 *
 * ⚠️ 切分区照管理端大页的做法：初始分区直接读 window.location.hash（页面在外壳闸之后才挂载，一定在浏览器里），
 *    之后监听 hashchange。页面里要改 # 一律用 navigateToHash，**不许** `location.hash = x`
 *    （那种历史记录 Next 后退时不认，见 modules/layout/navigate-to-hash.ts）。
 * ⚠️ 不放顶部数字条（老板没点头，记忆：顶部数字要先问他）。
 */
import { useCallback, useEffect, useState } from "react";
import { navigateToHash } from "../../modules/layout/navigate-to-hash";
import { AGENT_WHR_FEATURES_ENABLED, isAgentSectionEnabled } from "../../modules/agent/agent-features";
import AgentHome from "../../components/agent/AgentHome";
import AgentShipments from "../../components/agent/AgentShipments";
import AgentWhr from "../../components/agent/AgentWhr";
import AgentClients from "../../components/agent/AgentClients";
import AgentWallet from "../../components/agent/AgentWallet";
import AgentRebates from "../../components/agent/AgentRebates";
import AgentMe from "../../components/agent/AgentMe";

/** 跟 menu-config.ts 里 agent 那组菜单的 # 一一对应 */
const SECTION_IDS = ["home", "shipments", "whr", "clients", "wallet", "rebates", "me"] as const;
type SectionId = (typeof SECTION_IDS)[number];

function isSectionId(v: string): v is SectionId {
  return (SECTION_IDS as readonly string[]).includes(v);
}

function sectionFromHash(): SectionId {
  if (typeof window === "undefined") return "home";
  const id = window.location.hash.replace(/^#/, "");
  // 暂时关掉的分区（集货、余额、客户和价格、我的价格）就算有人存了旧链接也回首页，
  // 别渲染一个半截页面（开关在 modules/agent/agent-features.ts）
  return isSectionId(id) && isAgentSectionEnabled(id) ? id : "home";
}

export default function AgentWorkbenchPage() {
  const [section, setSection] = useState<SectionId>(sectionFromHash);
  const [focusPlanId, setFocusPlanId] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => setSection(sectionFromHash());
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  // 首页「看明细」→ 跳到仓库版集货分区并直接打开那个柜
  const openPlan = useCallback((planId: string) => {
    setFocusPlanId(planId);
    setSection("whr");
    navigateToHash(`${window.location.pathname}${window.location.search}#whr`);
  }, []);
  const clearFocus = useCallback(() => setFocusPlanId(null), []);

  return (
    <div style={{ padding: "4px 0 24px" }}>
      {section === "home" ? <AgentHome onOpenPlan={openPlan} /> : null}
      {section === "shipments" ? <AgentShipments /> : null}
      {AGENT_WHR_FEATURES_ENABLED && section === "whr" ? <AgentWhr focusPlanId={focusPlanId} onFocusHandled={clearFocus} /> : null}
      {AGENT_WHR_FEATURES_ENABLED && section === "clients" ? <AgentClients /> : null}
      {AGENT_WHR_FEATURES_ENABLED && section === "wallet" ? <AgentWallet /> : null}
      {section === "rebates" ? <AgentRebates /> : null}
      {AGENT_WHR_FEATURES_ENABLED && section === "me" ? <AgentMe /> : null}
    </div>
  );
}
