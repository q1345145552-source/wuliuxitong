"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

// 详情之间可能叠加打开；只有最上层接管键盘，最后一个关闭后才恢复页面滚动。
const openPanels: HTMLDivElement[] = [];
let previousBodyOverflow = "";

function focusableElements(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") && !element.closest('[inert]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
}

/**
 * 全屏详情弹窗。
 *
 * 关闭动画必须由组件自己管：CSS 动画只在元素挂载时会播，
 * 一旦 React 把节点摘掉就没机会播退场动画了。
 * 所以这里点关闭时先切到 closing 状态放动画，等动画放完再真正调 onClose。
 */
export default function DetailModal(props: {
  title: string;
  /** 标题下方的小字，一般放运单号 */
  subtitle?: string | null;
  onClose: () => void;
  /** 表单类弹窗传 false：填表时误按 ESC 会丢掉已输入的内容 */
  closeOnEsc?: boolean;
  /**
   * 点 ✕ / 按 ESC 关之前先问一句，返回 false 就不关（比如还有照片没传上）。
   * 必须在这里问、不能放进 onClose 里问：onClose 是关闭动画放完才调的，那时弹窗已经在消失了。
   */
  confirmClose?: () => boolean;
  children: ReactNode;
}) {
  const { title, subtitle, onClose, closeOnEsc = true, confirmClose, children } = props;
  const [closing, setClosing] = useState(false);
  const titleId = useId();
  const subtitleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closedRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);

  const requestClose = useCallback(() => {
    if (closedRef.current) return;
    if (confirmClose && !confirmClose()) return;
    closedRef.current = true;
    setClosing(true);
    // 必须和 globals.css 里 pageTurnOut / overlayFadeOut 的时长一致，
    // 短了会在动画放完前就把节点摘掉，看起来像"闪一下没了"
    closeTimerRef.current = window.setTimeout(onClose, 200);
  }, [onClose, confirmClose]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const returnTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // 登记成「开着的弹窗」：最上层那个接管键盘（Tab / Esc），有弹窗开着页面就不让滚
    const register = () => {
      if (openPanels.length === 0) previousBodyOverflow = document.body.style.overflow;
      openPanels.push(panel);
      document.body.style.overflow = "hidden";
    };
    const unregister = () => {
      const index = openPanels.indexOf(panel);
      if (index === -1) return;
      openPanels.splice(index, 1);
      if (openPanels.length === 0) document.body.style.overflow = previousBodyOverflow;
    };
    register();
    const focusFrame = window.requestAnimationFrame(() => {
      if (openPanels[openPanels.length - 1] === panel) {
        (focusableElements(panel)[0] ?? panel).focus({ preventScroll: true });
      }
    });
    /* 弹窗所在那一页被藏起来时（页面按 # 切分区，切走的那页是 display:none；浏览器后退 / 手机返回也会切走），
       弹窗没卸掉、只是看不见 —— 原来照样占着键盘和滚动锁：别的页滚不动、Tab 不好使（2026-10-18 老板选 A，
       超管 / 员工「运单管理」、客户「运单查询」的详情都会碰上）。藏起来就让出来，切回来再接上、焦点放回弹窗里。
       藏起来时弹窗的大小变成 0，ResizeObserver 会通知；没有 ResizeObserver 的老浏览器照旧（不让出） */
    let hidden = false;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      const nowHidden = panel.getClientRects().length === 0;
      if (nowHidden === hidden) return;
      hidden = nowHidden;
      if (hidden) {
        unregister();
        return;
      }
      register();
      if (openPanels[openPanels.length - 1] === panel && !panel.contains(document.activeElement)) {
        (focusableElements(panel)[0] ?? panel).focus({ preventScroll: true });
      }
    });
    observer?.observe(panel);
    return () => {
      observer?.disconnect();
      window.cancelAnimationFrame(focusFrame);
      const wasTop = openPanels[openPanels.length - 1] === panel;
      unregister();
      if (wasTop) {
        if (returnTarget?.isConnected && returnTarget.getClientRects().length > 0) {
          returnTarget.focus({ preventScroll: true });
        } else {
          const nextPanel = openPanels[openPanels.length - 1];
          if (nextPanel) (focusableElements(nextPanel)[0] ?? nextPanel).focus({ preventScroll: true });
        }
      }
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel || openPanels[openPanels.length - 1] !== panel || event.defaultPrevented) return;
      if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229) {
        // 填表类 closeOnEsc=false 仍然保留输入，不让 Escape 落到下层窗口。
        event.stopImmediatePropagation();
        if (closeOnEsc) {
          event.preventDefault();
          requestClose();
        }
      }
      if (event.key !== "Tab") return;
      const controls = focusableElements(panel);
      const first = controls[0];
      const last = controls[controls.length - 1];
      const active = document.activeElement;
      if (!first || !last) {
        event.preventDefault();
        panel.focus({ preventScroll: true });
      } else if (event.shiftKey && (active === first || active === panel || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || active === panel || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeOnEsc, requestClose]);

  // 【审查问题 8】关闭动画的定时器原来没人清：
  // 弹窗还在放动画时列表刚好自动刷新把节点摘掉，这个 onClose 会晚 200ms 空放一次，
  // 有可能把用户刚打开的下一个弹窗关掉。组件卸载时一并清掉。
  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, []);

  return (
    <div className={`detail-overlay${closing ? " is-closing" : ""}`}>
      <div
        ref={panelRef}
        className="detail-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        tabIndex={-1}
      >
        <div className="detail-head">
          <div>
            <div id={titleId} className="detail-title">{title}</div>
            {subtitle ? <div id={subtitleId} className="detail-sub">{subtitle}</div> : null}
          </div>
          <button type="button" className="detail-close" onClick={requestClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="detail-body">{children}</div>
      </div>
    </div>
  );
}
