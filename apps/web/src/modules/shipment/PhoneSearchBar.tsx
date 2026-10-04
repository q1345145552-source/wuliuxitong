"use client";

/**
 * 手机上运单列表顶上的查询条（2026-10-05 手机排版）。员工、管理员共用（客户端那块是自己的写法，规矩一样）。
 * 运单号那一格常驻 —— 查询框不藏（8-11 老板定的，客户端原来的「折叠」就是因此删的）；
 * 其余条件收进「更多条件」，有填了的就在旁边显示个数。
 */
export default function PhoneSearchBar({ trackingNo, onTrackingNo, onEnter, open, onToggle, moreCount }: {
  trackingNo: string;
  onTrackingNo: (value: string) => void;
  onEnter: () => void;
  open: boolean;
  onToggle: () => void;
  /** 运单号以外填了几个条件 */
  moreCount: number;
}) {
  return (
    <div className="phone-filter-bar">
      {!open ? (
        <input
          className="phone-quick-search"
          type="search"
          value={trackingNo}
          onChange={(e) => onTrackingNo(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onEnter(); }}
          placeholder="搜运单号"
          aria-label="搜运单号"
        />
      ) : null}
      <button type="button" className="phone-filter-toggle" aria-expanded={open} onClick={onToggle}>
        {open ? "收起条件" : "更多条件"}
        {!open && moreCount > 0 ? <span className="phone-filter-count">{moreCount}</span> : null}
      </button>
    </div>
  );
}
