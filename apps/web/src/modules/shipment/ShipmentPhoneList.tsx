"use client";

import type React from "react";
import { productNamesLabel } from "../../../../../packages/shared-types/product-names";
import { ATTENTION_STATUSES, classifyStatusGroup, type ShipmentStatus } from "../../../../../packages/shared-types/shipment-status";

/**
 * 运单列表在手机上的样子（2026-10-05 老板拍板「1a」：一单一块）。员工、客户、管理员三端共用这一份。
 * 电脑上那张十几列的宽表在手机上要左右拖着看；手机上改成一单一块：
 * 第一行运单号 + 状态，第二行唛头（客户自己看就不显示）+ 品名，第三行箱数 / 方数 / 重量 / 运输方式，第四行仓库和日期。
 * 点一下打开跟电脑上同一个「运单详情」；右下角放几个文字按钮（物流轨迹、编辑……），各端自己给；
 * 电脑那一行能做的事（勾选、打印、删除）手机上都要有，一样不能少。
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

/**
 * 勾选（员工、管理员端：电脑宽表第一列那个勾选框，勾了「导出」只导勾的那些）。
 * 手机上照样给，不然换成一单一块以后手机上就没法按勾选导出了（dsh 10-05 复审）。
 */
export interface PhoneSelection {
  isSelected: (id: string) => boolean;
  onToggle: (id: string) => void;
  /** 「选择全部筛选结果（包含其他页）」：跟电脑表头那个勾选框同一个意思 */
  all: { checked: boolean; partial: boolean; total: number; onToggle: () => void };
}

/** 按钮超过这个数就单独占一行，不再挤在灰字那行右边 */
const INLINE_ACTIONS_MAX = 2;

export default function ShipmentPhoneList({ rows, onOpen, actions = [], selection }: {
  rows: PhoneShipmentRow[];
  onOpen: (id: string) => void;
  /** 每块右下角的文字按钮（物流轨迹、编辑……），各端自己给 */
  actions?: PhoneRowAction[];
  selection?: PhoneSelection;
}) {
  const itemClass = [
    "ship-phone-item",
    actions.length > INLINE_ACTIONS_MAX ? "ship-phone-item--actions-row" : actions.length > 0 ? "ship-phone-item--actions" : "",
    selection ? "ship-phone-item--selectable" : "",
  ].filter(Boolean).join(" ");
  return (
    <>
    {selection ? (
      <label className="ship-phone-select-all">
        <input
          type="checkbox"
          ref={(node) => { if (node) node.indeterminate = selection.all.partial && !selection.all.checked; }}
          checked={selection.all.checked}
          onChange={selection.all.onToggle}
        />
        选择全部筛选结果（{selection.all.total} 条，包含其他页）
      </label>
    ) : null}
    <ul className="ship-phone-list" aria-label="运单列表">
      {rows.map((row) => (
        <li key={row.id} className={itemClass} style={{ "--ship-actions": actions.length } as React.CSSProperties}>
          {selection ? (
            <label className="ship-phone-check">
              <input type="checkbox" aria-label={`选择运单 ${row.number}`} checked={selection.isSelected(row.id)} onChange={() => selection.onToggle(row.id)} />
            </label>
          ) : null}
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
    </>
  );
}
