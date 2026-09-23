"use client";

/**
 * 导出弹窗里的筛选条件（2026-09-23）。
 *
 * 老板原话：「管理员端的导出也不能光选择日期，还要拥有那些搜索、筛选应该有的条件」。
 * 常用的几项直接摆出来，其余收进「更多条件」；打开弹窗时由各端把列表上已经筛好的条件带进来（可以改、可以清空）。
 * 四个端（超管 / 员工 / 代理 / 客户）共用这一个组件，条件清单各端自己传。
 */
import type { ReactNode } from "react";

export type ExportFieldDef =
  | { key: string; label: string; type: "text"; placeholder?: string }
  | { key: string; label: string; type: "date" }
  | { key: string; label: string; type: "select"; options: ReadonlyArray<{ value: string; label: string }> };

export default function ExportConditionFields<T extends Record<string, string>>({
  value,
  onChange,
  common,
  more = [],
  onClear,
  hint,
}: {
  value: T;
  onChange: (key: string, next: string) => void;
  common: ReadonlyArray<ExportFieldDef>;
  more?: ReadonlyArray<ExportFieldDef>;
  onClear: () => void;
  /** 条件下面那行说明（各端自己写，比如「勾了单子就只导勾的那些」） */
  hint?: ReactNode;
}) {
  /** 「全部」那种下拉（值是空串或 all）不算设了条件 */
  const isSet = (field: ExportFieldDef) => {
    const v = String(value[field.key] ?? "").trim();
    return v !== "" && v !== "all";
  };
  const activeCount = [...common, ...more].filter(isSet).length;
  const moreActiveCount = more.filter(isSet).length;

  const renderField = (field: ExportFieldDef) => (
    <label key={field.key} className="shipment-export-field">
      <span>{field.label}</span>
      {field.type === "select" ? (
        <select value={value[field.key] ?? ""} onChange={(e) => onChange(field.key, e.target.value)}>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      ) : (
        <input
          type={field.type === "date" ? "date" : "text"}
          value={value[field.key] ?? ""}
          placeholder={field.type === "text" ? field.placeholder : undefined}
          onChange={(e) => onChange(field.key, e.target.value)}
        />
      )}
    </label>
  );

  return (
    <div className="shipment-export-conditions">
      <div className="shipment-export-grid">{common.map(renderField)}</div>
      {more.length > 0 && (
        /* 默认收起：常用的六项摆外面，其余点开才显示。带着条件打开弹窗时自动展开，免得看不见自己筛了什么 */
        <details className="shipment-export-more" open={moreActiveCount > 0}>
          <summary>更多条件{moreActiveCount > 0 ? `（已设 ${moreActiveCount} 项）` : ""}</summary>
          <div className="shipment-export-grid">{more.map(renderField)}</div>
        </details>
      )}
      <div className="shipment-export-conditions-foot">
        <span>{activeCount > 0 ? `已设 ${activeCount} 个条件` : "没有设条件：导出全部"}</span>
        <button type="button" className="workbench-button" onClick={onClear} disabled={activeCount === 0}>清空条件</button>
      </div>
      {hint ? <p className="shipment-export-note">{hint}</p> : null}
    </div>
  );
}
