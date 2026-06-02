import type { MockRole } from "../../auth/mock-session";

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

export const roleMenus: Record<MockRole, MenuItem[]> = {
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

export const roleFunctionMenus: Record<MockRole, RoleFunctionMenuItem[]> = {
  admin: [
    { id: "admin-func-overview", label: "运营看板", href: "/admin#overview" },
    { id: "admin-func-staff", label: "员工管理", href: "/admin#staff" },
    { id: "admin-func-clients", label: "客户管理", href: "/admin#clients" },
    { id: "admin-func-orders", label: "订单管理", href: "/admin#orders" },
    { id: "admin-func-lmp", label: "渠道与价格管理", href: "/admin/lmp" },
    { id: "admin-func-customs", label: "关务监控", href: "/admin/customs" },
    { id: "admin-func-lastmile", label: "海外仓/末端集成", href: "/admin/lastmile" },
    { id: "admin-func-settlement", label: "财务结算与利润", href: "/admin/settlement" },
    { id: "admin-func-ai-memory", label: "AI会话记忆", href: "/admin#ai-memory" },
    { id: "admin-func-ai-gap", label: "AI待补知识", href: "/admin#ai-knowledge-gaps" },
    { id: "admin-func-ai-feed", label: "AI知识投喂", href: "/admin#knowledge-feed" },
    { id: "admin-func-ai-list", label: "知识列表", href: "/admin#knowledge-list" },
  ],
  staff: [
    { id: "staff-func-billing", label: "账单管理", href: "/staff#staff-billing" },
    { id: "staff-func-prealert", label: "预报单审核", href: "/staff#staff-prealert-review" },
    { id: "staff-func-order-shipment", label: "运单管理", href: "/staff#staff-order-shipment" },
    { id: "staff-func-ops-tools", label: "入库与标签工具", href: "/staff#staff-ops-tools" },
    { id: "staff-func-status", label: "状态更新", href: "/staff#staff-status-update" },
    { id: "staff-func-container-loading", label: "装柜管理", href: "/staff/container-loading" },
    { id: "staff-func-lastmile", label: "尾端派送", href: "/staff#staff-lastmile" },
  ],
  client: [
    { id: "client-func-main", label: "主页与AI", href: "/client#client-main" },
    { id: "client-func-query", label: "我的运单查询", href: "/client#client-query" },
    { id: "client-func-prealert", label: "预报单", href: "/client#client-prealert" },
    { id: "client-func-imports", label: "批量下单", href: "/client/imports" },
    { id: "client-func-quote", label: "智能算费", href: "/client#client-main" },
    { id: "client-func-track", label: "免登录轨迹查询", href: "/client/track" },
    { id: "client-func-docs", label: "清关资料上传", href: "/client/documents" },
    { id: "client-func-wallet", label: "多币种账户", href: "/client/wallet" },
    { id: "client-func-address", label: "常用地址库", href: "/client/address-book" },
    { id: "client-func-bills", label: "账单页面", href: "/client/bills" },
  ],
};
