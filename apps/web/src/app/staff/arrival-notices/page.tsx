"use client";

/**
 * 到货通知（2026-10-06）。员工和超管共用这一页（超管菜单也指到这里，跟「装柜管理」「客户消息」一样借员工端的页面）。
 * 页面内容在 modules/arrival-notice/ArrivalNoticesView.tsx。
 */
import ArrivalNoticesView from "../../../modules/arrival-notice/ArrivalNoticesView";

export default function StaffArrivalNoticesPage() {
  return <ArrivalNoticesView />;
}
