"use client";

import { CLIENT_STATUS_GROUP_ZH, type ShipmentListFilter } from "../../../../../packages/shared-types/shipment-status";

export type ShipmentGroupFilter = ShipmentListFilter;

/** 分组选项：列表顶上那排按钮和导出弹窗里的「运单分组」共用同一份（2026-09-23） */
export const SHIPMENT_GROUP_OPTIONS: { value: ShipmentGroupFilter; label: string }[] = [
  { value: "all", label: "全部订单" },
  { value: "pending", label: CLIENT_STATUS_GROUP_ZH.pending },
  { value: "transit", label: CLIENT_STATUS_GROUP_ZH.transit },
  { value: "arrived", label: CLIENT_STATUS_GROUP_ZH.arrived },
  { value: "delivered", label: CLIENT_STATUS_GROUP_ZH.delivered },
  { value: "attention", label: "异常" },
];

export default function ShipmentStatusGroups({ value, onChange }: {
  value: ShipmentGroupFilter | null;
  onChange: (value: ShipmentGroupFilter) => void;
}) {
  return (
    <div className="shipment-classification">
      <div className="client-status-groups shipment-status-groups" role="group" aria-label="订单状态分组">
        {SHIPMENT_GROUP_OPTIONS.map((group) => (
          <button
            key={group.value}
            type="button"
            className="workbench-button shipment-status-group"
            aria-label={group.label}
            aria-pressed={value === group.value}
            onFocus={(event) => event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" })}
            onClick={() => onChange(group.value)}
          >
            {group.label}
          </button>
        ))}
      </div>
    </div>
  );
}
