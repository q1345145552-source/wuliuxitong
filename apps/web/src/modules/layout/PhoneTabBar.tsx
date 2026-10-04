"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import type { MenuItem } from "./menu-config";
import { isSamePageHashLink, navigateToHash } from "./navigate-to-hash";

/**
 * 手机底部那排常用入口（2026-10-05 老板拍板「2a」）。只在手机宽度渲染（外壳用 useIsPhone 判断）。
 *
 * 外观照 A3：白底、上面一条细线、只有字没有图标；当前页的那个字变黑加粗、上面压一条短横线
 * （跟左边菜单「当前页用一条竖线、不用色块」同一个意思）。未读消息用跟左边菜单一样的红色小圆数字。
 * 一个入口对应好几页时（两个版本的集货、三种账号），点了从底部弹出一小块让人选。
 */

export interface PhoneTabView {
  key: string;
  label: string;
  /** 这个入口能去的页面（已经按品牌藏过、改过名） */
  items: Array<MenuItem & { shownLabel: string }>;
  more: boolean;
  active: boolean;
  badge: number;
}

function TabLink({ item, className, children, onDone }: { item: MenuItem; className: string; children: ReactNode; onDone?: () => void }) {
  return (
    <Link
      href={item.href}
      className={className}
      onClick={onDone}
      onNavigate={(event) => {
        // 同一页只换 #：照左边菜单的规矩走 navigateToHash（Link 自己不发 hashchange，页面切不了分区）
        if (!isSamePageHashLink(item.href)) return;
        event.preventDefault();
        navigateToHash(item.href);
      }}
    >
      {children}
    </Link>
  );
}

function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return <span className="phone-tab-badge" aria-label={`${count} 条未读消息`}>{count > 99 ? "99+" : count}</span>;
}

export default function PhoneTabBar({ tabs, onMore }: { tabs: PhoneTabView[]; onMore: () => void }) {
  const [sheetKey, setSheetKey] = useState<string | null>(null);
  const sheet = tabs.find((t) => t.key === sheetKey) ?? null;

  // 弹出来的那一小块：按返回键 / Esc 收起
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSheetKey(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet]);

  return (
    <>
      {sheet ? (
        <>
          <div className="phone-tab-sheet-backdrop" onClick={() => setSheetKey(null)} aria-hidden="true" />
          <div className="phone-tab-sheet" role="dialog" aria-label={`${sheet.label}：选一个`}>
            <div className="phone-tab-sheet-title">{sheet.label}</div>
            {sheet.items.map((item) => (
              <TabLink key={item.id} item={item} className="phone-tab-sheet-link" onDone={() => setSheetKey(null)}>
                {item.shownLabel}
              </TabLink>
            ))}
          </div>
        </>
      ) : null}
      <nav className="phone-tabbar" aria-label="常用入口">
        {tabs.map((tab) => {
          const className = `phone-tab${tab.active ? " phone-tab--active" : ""}`;
          if (tab.more) {
            return (
              <button key={tab.key} type="button" className={className} onClick={() => { setSheetKey(null); onMore(); }}>
                {tab.label}
              </button>
            );
          }
          if (tab.items.length === 1) {
            return (
              <TabLink key={tab.key} item={tab.items[0]} className={className} onDone={() => setSheetKey(null)}>
                <span aria-current={tab.active ? "page" : undefined}>{tab.label}</span>
                <Badge count={tab.badge} />
              </TabLink>
            );
          }
          return (
            <button
              key={tab.key}
              type="button"
              className={className}
              aria-expanded={sheetKey === tab.key}
              onClick={() => setSheetKey((cur) => (cur === tab.key ? null : tab.key))}
            >
              {tab.label}
              <Badge count={tab.badge} />
            </button>
          );
        })}
      </nav>
    </>
  );
}
