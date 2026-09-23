import type { AuthRole } from "../../auth/auth-session";
import { AGENT_WHR_FEATURES_ENABLED } from "../agent/agent-features";

export interface MenuItem {
  id: string;
  label: string;
  href: string;
}

export interface RoleFunctionMenuItem {
  id: string;
  label: string;
  href: string;
}

/** 分组菜单 */
export interface MenuGroup {
  groupLabel: string;
  items: RoleFunctionMenuItem[];
}

export const roleMenus: Record<AuthRole, MenuItem[]> = {
  client: [
    { id: "client-home", label: "客户端工作台", href: "/client" },
  ],
  staff: [
    { id: "staff-home", label: "员工工作台", href: "/staff" },
  ],
  admin: [
    { id: "admin-home", label: "管理员工作台", href: "/admin" },
  ],
  agent: [
    { id: "agent-home", label: "代理工作台", href: "/agent" },
  ],
};

export const globalMenus: MenuItem[] = [];

/** 分组菜单：运单相关 vs 其他业务分明 */
export const roleFunctionGroups: Record<AuthRole, MenuGroup[]> = {
  admin: [
    {
      groupLabel: "运营看板",
      items: [
        { id: "admin-func-overview", label: "运营看板", href: "/admin#overview" },
      ],
    },
    {
      groupLabel: "运单管理",
      items: [
        { id: "admin-func-orders", label: "运单管理", href: "/admin#orders" },
        { id: "admin-func-prealerts", label: "预报单管理", href: "/admin/prealerts" },
        { id: "admin-func-container", label: "装柜管理", href: "/staff/container-loading" },
        { id: "admin-func-fcl", label: "整柜询价", href: "/staff#staff-fcl" },
        { id: "admin-func-fcl-containers", label: "整柜管理", href: "/admin/fcl-containers" },
        { id: "admin-func-consolidation", label: "集货拼柜", href: "/admin/consolidation" },
        { id: "admin-func-whr-consolidation", label: "集货拼柜(仓库版)", href: "/admin/whr-consolidation" },
      ],
    },
    {
      groupLabel: "账号管理",
      items: [
        { id: "admin-func-staff", label: "员工管理", href: "/admin#staff" },
        { id: "admin-func-clients", label: "客户管理", href: "/admin#clients" },
        { id: "admin-func-agents", label: "代理管理", href: "/admin/agents" },
      ],
    },
    {
      groupLabel: "尾端运营",
      items: [
        { id: "admin-func-lastmile", label: "尾端派送", href: "/admin#lastmile" },
        { id: "admin-func-address", label: "尾端地址", href: "/admin#lastmile-address" },
      ],
    },
    {
      groupLabel: "财务",
      items: [
        { id: "admin-func-finance", label: "财务管理", href: "/admin/finance" },
        { id: "admin-func-settlement", label: "柜子收款", href: "/admin/settlement" },
        { id: "admin-func-wallet-recharges", label: "充值审核", href: "/admin#wallet-recharges" },
      ],
    },
    {
      groupLabel: "系统配置",
      items: [
        { id: "admin-func-shipping", label: "运费配置", href: "/admin#shipping-config" },
        { id: "admin-func-lmp", label: "渠道与价格管理", href: "/admin/lmp" },
        { id: "admin-func-customs", label: "关务监控", href: "/admin/customs" },
      ],
    },
    {
      groupLabel: "AI 知识库",
      items: [
        { id: "admin-func-ai-feed", label: "AI知识投喂", href: "/admin#knowledge-feed" },
        { id: "admin-func-ai-list", label: "知识列表", href: "/admin#knowledge-list" },
        { id: "admin-func-ai-memory", label: "AI会话记忆", href: "/admin#ai-memory" },
        { id: "admin-func-ai-gap", label: "AI待补知识", href: "/admin#ai-knowledge-gaps" },
      ],
    },
  ],
  staff: [
    {
      groupLabel: "运单管理",
      items: [
        { id: "staff-func-order-shipment", label: "运单管理", href: "/staff#staff-order-shipment" },
        { id: "staff-func-prealert", label: "预报单审核", href: "/staff#staff-prealert-review" },
        { id: "staff-func-consolidation", label: "集货拼柜", href: "/staff/consolidation" },
          { id: "staff-func-whr-consolidation", label: "集货拼柜(仓库版)", href: "/staff/whr-consolidation" },
        { id: "staff-func-container-loading", label: "装柜管理", href: "/staff/container-loading" },
        { id: "staff-func-fcl", label: "整柜询价", href: "/staff#staff-fcl" },
        { id: "staff-func-fcl-containers", label: "整柜管理", href: "/staff/fcl-containers" },
        { id: "staff-func-ops-tools", label: "入库与标签工具", href: "/staff#staff-ops-tools" },
      ],
    },
    {
      groupLabel: "尾端运营",
      items: [
        { id: "staff-func-lastmile", label: "尾端派送", href: "/staff#staff-lastmile" },
        { id: "staff-func-address", label: "尾端地址", href: "/staff#staff-address" },
      ],
    },
    {
      groupLabel: "财务",
      items: [
        { id: "staff-func-wallet", label: "客户集货余额", href: "/staff#staff-wallet" },
      ],
    },
  ],
  client: [
    {
      groupLabel: "我的运单",
      items: [
        { id: "client-func-query", label: "运单查询", href: "/client#client-query" },
        { id: "client-func-prealert", label: "预报单", href: "/client#client-prealert" },
        { id: "client-func-consolidation", label: "集货拼柜", href: "/client/consolidation" },
          { id: "client-func-whr-consolidation", label: "集货拼柜(仓库版)", href: "/client/whr-consolidation" },
        { id: "client-func-fcl", label: "整柜询价", href: "/client#client-fcl" },
        { id: "client-func-fcl-containers", label: "我的整柜", href: "/client/fcl-containers" },
        { id: "client-func-imports", label: "批量下单", href: "/client/imports" },
        // 这一页是跳快递100查国内快递，不是查湘泰运单 —— 按实际功能命名（2026-08-11）
        { id: "client-func-track", label: "查国内快递", href: "/client/track" },
      ],
    },
    {
      groupLabel: "其他",
      items: [
        { id: "client-func-main", label: "主页与AI", href: "/client#client-main" },
        { id: "client-func-wallet", label: "集货余额", href: "/client/wallet" },
        { id: "client-func-address", label: "地址库", href: "/client/address-book" },
      ],
    },
  ],
  // 代理工作台只有 /agent 一页，分区用 #（/agent/xxx 全留给接口转发，见 next.config.ts）
  agent: [
    {
      groupLabel: "我的客户",
      items: [
        { id: "agent-func-home", label: "首页", href: "/agent#home" },
        { id: "agent-func-shipments", label: "运单", href: "/agent#shipments" },
        // 仓库版集货 / 客户和价格 / 集货余额 / 我的价格 —— 2026-09-18 老板拍板暂时不对代理开放，
        // 开关在 modules/agent/agent-features.ts（改成 true 就全回来，菜单和分区一起）
        ...(AGENT_WHR_FEATURES_ENABLED
          ? [
              { id: "agent-func-whr", label: "仓库版集货", href: "/agent#whr" },
              { id: "agent-func-clients", label: "客户和价格", href: "/agent#clients" },
              { id: "agent-func-wallet", label: "集货余额", href: "/agent#wallet" },
            ]
          : []),
        { id: "agent-func-rebates", label: "返现单", href: "/agent#rebates" },
        ...(AGENT_WHR_FEATURES_ENABLED ? [{ id: "agent-func-me", label: "我的价格", href: "/agent#me" }] : []),
      ],
    },
  ],
};
