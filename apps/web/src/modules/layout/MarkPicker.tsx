"use client";

/**
 * 唛头选择框（2026-10-08 老板：到货通知的唛头「换个方式显示，太丑了」）。
 *
 * 原来是 <input list> + <datalist>：下拉是浏览器自己画的，窄、字小、样式改不了，手机上还各家长得不一样。
 * 这里自己画：跟输入框一样宽、一行一个唛头、边打字边筛、匹配的字加粗，↑↓ 选、回车定、Esc 收起。
 * 只显示唛头、不带客户名字（老板 2026-09-19「显示唛头就行了」，test:mark-display 管着）。
 *
 * 不截断：全部客户都能翻到（同 F15，教训 21）；筛选逻辑在 mark-options.ts 的 filterMarkOptions，方便测。
 * 值就是输入框里的字：没选下拉也能手输（列表没拿到时照样能填），有没有这个唛头由调用方判断、提示。
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { filterMarkOptions, type MarkOption } from "./mark-options";

export type { MarkOption };

/** 把匹配的那一段单独拿出来加粗；没匹配就整段原样 */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}

export default function MarkPicker(props: {
  value: string;
  onChange: (value: string) => void;
  options: MarkOption[];
  disabled?: boolean;
  placeholder?: string;
  /** 列表没拿到（接口失败）时的空状态说明 */
  loadFailed?: boolean;
  /** 各页面原来输入框的样式（边框、圆角、字号），换成这个下拉后长相不变；右边留给 × 和箭头的位置这里补上 */
  inputStyle?: CSSProperties;
}) {
  const { value, onChange, options, disabled, placeholder, loadFailed, inputStyle } = props;
  const listId = useId();
  const [open, setOpen] = useState(false);
  /** 列表显示全部（点箭头 / 点进已选好唛头的框）还是按输入的字筛。打字一律按字筛：
   *  打到「XPP-0015」正好是短账号时，「XPP-0015 XHH-6698」也得留在眼前（前缀账号，老板 09 月立过规矩；审查 10-08 #1） */
  const [showAll, setShowAll] = useState(false);
  /** 用上下键挪到的那个唛头（按唛头记、不按第几行记）；null = 没挪过。鼠标悬停只是 CSS 变色，不算 */
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  /** 用上下键挪过才算「明确选了这一行」：只有这时回车才换值。
   *  不然打完 / 粘贴完一个唛头顺手按回车，会被换成列表里第一个人（审查 10-08 #0 #2）；Safari 输入法上屏字母的回车也一样 */
  const [explicit, setExplicit] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** 下拉放不下时：列表缩短到放得下的高度；下面太挤、上面更宽就往上弹（第二轮审查 10-08 #1：弹窗 overflow 会把下半截裁掉） */
  const [fit, setFit] = useState<{ up: boolean; listMax: number } | null>(null);

  const exact = options.some((o) => o.id === value);
  const query = showAll ? "" : value;
  const shown = useMemo(() => filterMarkOptions(options, query), [options, query]);

  // 高亮哪一行：上下键挪过就是挪到的那个唛头；没挪过就跟着「现在框里的唛头」（列表晚到也跟得上），没有就不高亮。
  // ⚠️ 按唛头算、不按下标存：超管页每 10 秒自动刷新、整柜询价推送，调用方每次都传一个新数组，
  //    按下标存的话一刷新键盘选的就作废，回车变成只收起（第二轮审查 10-08 #0）
  const highlightKey = explicit ? pickedKey : (exact ? value : null);
  const active = highlightKey === null ? -1 : shown.findIndex((o) => o.id === highlightKey);
  // 换了筛选词 / 框里的字变了：键盘选择作废（列表内容只是重新拉了一遍不算）
  useEffect(() => {
    setExplicit(false);
    setPickedKey(null);
  }, [query, value]);
  useLayoutEffect(() => {
    if (!open) { setFit(null); return; }
    const el = rootRef.current;
    if (typeof window === "undefined" || !el || typeof el.getBoundingClientRect !== "function") return;
    const r = el.getBoundingClientRect();
    // 能显示的范围 = 窗口，再被最近一层会裁内容的容器（弹窗的 overflow: auto / hidden）收窄
    let top = 0;
    let bottom = window.innerHeight;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (/(auto|scroll|hidden)/.test(window.getComputedStyle(p).overflowY)) {
        const pr = p.getBoundingClientRect();
        top = Math.max(top, pr.top);
        bottom = Math.min(bottom, pr.bottom);
        break;
      }
    }
    const HEADER = 40; // 「共 N 个客户」那一行 + 上下边距
    const below = bottom - r.bottom - 8;
    const above = r.top - top - 8;
    const up = below < 200 && above > below;
    setFit({ up, listMax: Math.max(96, Math.min(264, (up ? above : below) - HEADER)) });
  }, [open]);
  useEffect(() => {
    if (!open || active < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  /** all = 列全部（只在框里已经是一个完整唛头、想换别的时才有意义） */
  const openList = (all: boolean) => {
    setShowAll(all);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setShowAll(false);
  };
  const pick = (id: string) => {
    onChange(id);
    close();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // 中文输入法选字时的回车 / 方向键不算；Safari 是先 compositionend、后 keydown（isComposing 已经是 false、keyCode 229）
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { openList(exact); return; }
      if (shown.length === 0) return;
      const n = shown.length;
      const next = e.key === "ArrowDown" ? (active < 0 ? 0 : (active + 1) % n) : (active < 0 ? n - 1 : (active - 1 + n) % n);
      setPickedKey(shown[next].id);
      setExplicit(true);
    } else if (e.key === "Enter") {
      if (!open) return;
      e.preventDefault();
      if (explicit && active >= 0 && shown[active]) pick(shown[active].id);
      else close(); // 没用上下键选过：回车只收起，框里的字原样不动
    } else if (e.key === "Escape") {
      if (open) { e.stopPropagation(); close(); }
    }
  };

  const activeId = open && active >= 0 && shown[active] ? `${listId}-opt-${active}` : undefined;
  // 右边留给 × 和箭头：有字（有 ×）留 60，没字只留箭头 34 —— 窄格子里长唛头能多露几个字（审查 10-08 #4）
  const padRight = value && !disabled ? 60 : 34;
  const { margin, marginTop, marginRight, marginBottom, marginLeft, ...ownInputStyle } = inputStyle ?? {};
  const wrapperStyle: CSSProperties | undefined = inputStyle ? { margin, marginTop, marginRight, marginBottom, marginLeft } : undefined;

  return (
    <div ref={rootRef} className={`mark-picker${open ? " is-open" : ""}${disabled ? " is-disabled" : ""}`} style={wrapperStyle}>
      <div className="mark-picker-control">
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          disabled={disabled}
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          style={inputStyle ? { ...ownInputStyle, width: "100%", paddingRight: padRight } : { paddingRight: padRight }}
          onChange={(e) => { onChange(e.target.value); setShowAll(false); setOpen(true); }}
          onFocus={() => { if (!open) openList(exact); }}
          onClick={() => { if (!open) openList(exact); }}
          onBlur={close}
          onKeyDown={onKeyDown}
        />
        {value && !disabled ? (
          <button type="button" className="mark-picker-clear" aria-label="清空唛头" tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { inputRef.current?.focus(); onChange(""); openList(false); }}>×</button>
        ) : null}
        <button type="button" className="mark-picker-toggle" aria-label={open ? "收起唛头列表" : "展开唛头列表"} tabIndex={-1} disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const wasOpen = open;
            inputRef.current?.focus(); // 先聚焦（会触发 onFocus），再定开关，后定的说了算
            if (wasOpen) close(); else openList(true);
          }}>
          <span aria-hidden="true" />
        </button>
      </div>
      {open && !disabled ? (
        <div className={`mark-picker-panel${fit?.up ? " is-up" : ""}`} onMouseDown={(e) => e.preventDefault()}>
          <div className="mark-picker-count">
            {options.length === 0
              ? (loadFailed ? "客户列表没拿到，可以直接输入唛头" : "还没有客户")
              : query ? `匹配 ${shown.length} 个，共 ${options.length} 个客户` : `共 ${options.length} 个客户`}
          </div>
          {shown.length > 0 ? (
            <ul id={listId} ref={listRef} role="listbox" className="mark-picker-list" style={fit ? { maxHeight: fit.listMax } : undefined}>
              {shown.map((o, i) => (
                <li
                  key={o.id}
                  id={`${listId}-opt-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={o.id === value}
                  className={`mark-picker-option${i === active ? " is-active" : ""}${o.id === value ? " is-selected" : ""}`}
                  onClick={() => pick(o.id)}
                >
                  <span className="mark-picker-id"><Highlight text={o.id} query={query} /></span>
                </li>
              ))}
            </ul>
          ) : options.length > 0 ? (
            <div className="mark-picker-empty">没有匹配「{query.trim()}」的唛头</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
