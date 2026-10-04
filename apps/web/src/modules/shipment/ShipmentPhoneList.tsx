"use client";

import type React from "react";
import { productNamesLabel } from "../../../../../packages/shared-types/product-names";
import { ATTENTION_STATUSES, classifyStatusGroup, type ShipmentStatus } from "../../../../../packages/shared-types/shipment-status";

/**
 * 运单列表在手机上的样子（2026-10-05 老板拍板「1a」：一单一块）。员工、客户、管理员三端共用这一份。
 * 电脑上那张十几列的宽表在手机上要左右拖着看；手机上改成一单一块：
 * 第一行运单号 + 状态，第二行唛头（客户自己看就不显示）+ 品名，第三行箱数 / 方数 / 重量 / 运输方式，第四行仓库和日期。
 * 点一下打开跟电脑上同一个「运单详情」；右下角放几个文字按钮（物流轨迹、编辑……），各端自己给。
 *
 * 外观照系统现有那套（A3）：颜色只用 globals.css 里的令牌；状态用小圆点 + 中文、不用彩色胶囊；
 * 数字等宽；细线分隔，不加阴影、渐变、图标。
 */

export interface PhoneShipmentRow {
  id: string;
  number: string;
  /** 唛头：客户端不传（自己的单不用再看自己的唛头） */
  mark?: string;
  products?: Array<{ itemName?: string | null }> | null;
  itemName?: string | null;
  status?: string | null;
  statusText: string;
  packageCount: number | null;
  /** 箱 / 袋 */
  packageUnit: string;
  volume: number | null;
  weight: number | null;
  transport: string;
  /** 第四行灰字（仓库 · 到仓日期之类），没有就不显示 */
  meta?: string;
}

type Tone = "pending" | "transit" | "arrived" | "delivered" | "attention" | "closed";

function toneOf(status: string | null | undefined): Tone {
  if (status && ATTENTION_STATUSES.includes(status as ShipmentStatus)) return "attention";
  return classifyStatusGroup(status);
}

function num(value: number | null, digits: number): string {
  return value == null ? "—" : value.toFixed(digits);
}

export interface PhoneRowAction {
  label: string;
  onClick: (id: string) => void;
  /** 删除这类：红字 */
  danger?: boolean;
}

export default function ShipmentPhoneList({ rows, onOpen, actions = [] }: {
  rows: PhoneShipmentRow[];
  onOpen: (id: string) => void;
  /** 每块右下角的文字按钮（物流轨迹、编辑……），各端自己给 */
  actions?: PhoneRowAction[];
}) {
  return (
    <ul className="ship-phone-list" aria-label="运单列表">
      {rows.map((row) => (
        <li key={row.id} className="ship-phone-item" style={{ "--ship-actions": actions.length } as React.CSSProperties}>
          <button type="button" className="ship-phone-row" onClick={() => onOpen(row.id)} aria-label={`运单 ${row.number}，${row.statusText}，打开详情`}>
            <span className="ship-phone-top">
              <span className="ship-phone-no">{row.number}</span>
              <span className={`ship-phone-status ship-phone-status--${toneOf(row.status)}`}>{row.statusText}</span>
            </span>
            <span className="ship-phone-who">
              {row.mark ? <span className="ship-phone-mark">{row.mark}</span> : null}
              <span className="ship-phone-goods">{productNamesLabel(row.products ?? undefined, row.itemName ?? undefined) || "—"}</span>
            </span>
            <span className="ship-phone-metrics">
              <span><b>{row.packageCount ?? "—"}</b> {row.packageUnit}</span>
              <span><b>{num(row.volume, 3)}</b> m³</span>
              <span><b>{num(row.weight, 2)}</b> kg</span>
              <span className="ship-phone-mode">{row.transport}</span>
            </span>
            {row.meta ? <span className="ship-phone-meta">{row.meta}</span> : null}
          </button>
          {actions.length > 0 ? (
            <span className="ship-phone-actions">
              {actions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  className={action.danger ? "ship-phone-action ship-phone-action--danger" : "ship-phone-action"}
                  onClick={() => action.onClick(row.id)}
                  aria-label={`运单 ${row.number}：${action.label}`}
                >
                  {action.label}
                </button>
              ))}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
