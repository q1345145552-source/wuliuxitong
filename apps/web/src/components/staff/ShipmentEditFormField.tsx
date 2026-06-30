"use client";

import type { ShipmentEditFormFieldProps } from "../../modules/staff/types";

/**
 * 运单编辑展开区单字段：白底卡片、标签与必填星号。
 */
export default function ShipmentEditFormField(props: ShipmentEditFormFieldProps) {
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 12px", background: "#ffffff" }}>
      <div style={{ fontSize: 12, color: "#000000", marginBottom: 6 }}>
        {props.label}
        {props.required ? <span style={{ color: "#dc2626", marginLeft: 2 }}>*</span> : null}
      </div>
      {props.children}
    </div>
  );
}
