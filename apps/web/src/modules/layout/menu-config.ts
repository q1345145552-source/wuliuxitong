import type { AuthRole } from "../../auth/auth-session";

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
    { id: "client-orders", label: "我的订单", href: "/client" },
    { id: "client-bills", label: "账单", href: "/client/bills" },
  ],
  staff: [
    { id: "staff-home", label: "员工工作台", href: "/staff" },
    { id: "staff-shipments", label: "运单处理", href: "/staff" },
  ],
  admin: [
    { id: "admin-home", label: "管理员工作台", href: "/admin" },
    { id: "admin-config", label: "配置与看板", href: "/admin" },
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
      ],
    },
    {
      groupLabel: "账号管理",
      items: [
        { id: "admin-func-staff", label: "员工管理", href: "/admin#staff" },
        { id: "admin-func-clients", label: "客户管理", href: "/admin#clients" },
        { id: "admin-func-accounts", label: "账号管理", href: "/admin/accounts" },
      ],
    },
    {
      groupLabel: "尾端运营",
      items: [
        { id: "admin-func-lastmile", label: "尾端派送", href: "/admin#lastmile" },
        { id: "admin-func-address", label: "尾端地址", href: "/admin#lastmile-address" },
        { id: "admin-func-offline-payments", label: "付款审核", href: "/admin#offline-payments" },
      ],
    },
    {
      groupLabel: "财务",
      items: [
        { id: "admin-func-finance", label: "财务管理", href: "/admin/finance" },
        { id: "admin-func-settlement", label: "财务结算与利润", href: "/admin/settlement" },
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
        { id: "staff-func-container-loading", label: "装柜管理", href: "/staff/container-loading" },
        { id: "staff-func-fcl", label: "整柜询价", href: "/staff#staff-fcl" },
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
        { id: "staff-func-billing", label: "账单管理", href: "/staff#staff-billing" },
        { id: "staff-func-wallet", label: "客户余额", href: "/staff#staff-wallet" },
        { id: "staff-func-prices", label: "客户价格查询", href: "/staff/prices" },
      ],
    },
  ],
  client: [
    {
      groupLabel: "我的运单",
      items: [
        { id: "client-func-query", label: "运单查询", href: "/client#client-query" },
        { id: "client-func-prealert", label: "预报单", href: "/client#client-prealert" },
        { id: "client-func-fcl", label: "整柜询价", href: "/client#client-fcl" },
        { id: "client-func-imports", label: "批量下单", href: "/client/imports" },
        { id: "client-func-track", label: "免登录查轨迹", href: "/client/track" },
      ],
    },
    {
      groupLabel: "其他",
      items: [
        { id: "client-func-main", label: "主页与AI", href: "/client#client-main" },
        { id: "client-func-quote", label: "智能算费", href: "/client#client-main" },
        { id: "client-func-bills", label: "账单", href: "/client/bills" },
        { id: "client-func-wallet", label: "余额", href: "/client/wallet" },
        { id: "client-func-address", label: "地址库", href: "/client/address-book" },
      ],
    },
  ],
};
