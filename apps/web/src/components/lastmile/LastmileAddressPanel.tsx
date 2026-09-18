"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiBaseUrl, authHeaders, parseApiResponse, fetchWithSession as fetch } from "../../services/core-api";
import { fetchClientNotes } from "../../services/business-api";

/* ==========================================================================
   尾端地址面板（员工端 / 管理员端共用）
   --------------------------------------------------------------------------
   2026-08-29 抽出来的。原因：这块**只有员工端有**，管理员端那个「尾端地址」
   页面从头到尾只有一个标题加一句话 —— 0 个按钮、0 个输入框、0 个表格
   （实测过，不是读代码猜的）。老板要求两端都要有。

   ⚠️ 为什么抽成组件而不是复制一份到管理员端：
      CLAUDE.md 第 20 条就是这么栽的 —— 尾端派送在两端各写各的，
      修了员工端那份，管理员端那份写死只显示 20 条、不点搜索框就一直空白，
      老板打开管理员端发现「没数据」。同一个功能两份实现，改一个必然漏另一个。
      ShipmentOverviewStrip 当初也是为了这个抽出来的。

   ⚠️ 顺带修掉搬过来时发现的三个老毛病（都是实测出来的）：
      ① 进这一页**不会自动加载**，员工得手动点一下「重置」才看得到客户列表
      ② 客户备注**从来没在进页面时加载过**（loadClientNotesData 只在保存备注后调），
         所以「备注」那一栏永远显示「暂无备注」，哪怕库里真有
      ③ 加完 / 删完地址刷的是 lastmileItems —— 那份数据全文件没有任何 JSX 用它，
         页面上根本不变（这条 2026-08-29 已在员工端修过，这里一并带过来）
   ========================================================================== */

interface AddressRow {
  id: string;
  contactName: string;
  contactPhone: string;
  addressDetail: string;
  isDefault: number;
}

interface ClientRow {
  id: string;
  name: string;
  phone: string;
  addresses: AddressRow[];
}

export interface LastmileAddressPanelProps {
  /** 有全局 toast 的页面传进来；没传就用面板自己那条提示 */
  onToast?: (message: string) => void;
}

export function LastmileAddressPanel({ onToast }: LastmileAddressPanelProps) {
  const [keyword, setKeyword] = useState("");
  const [items, setItems] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [notes, setNotes] = useState<Record<string, { content: string; updatedAt: string }>>({});
  const [editingNote, setEditingNote] = useState<{ clientId: string; content: string } | null>(null);
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [addForm, setAddForm] = useState({ contactName: "", contactPhone: "", addressDetail: "", label: "" });
  const [editingAddr, setEditingAddr] = useState<{ id: string; contactName: string; contactPhone: string; addressDetail: string } | null>(null);
  /** 没有全局 toast 时，提示就显示在面板里，不能让操作结果无声无息 */
  const [inlineMessage, setInlineMessage] = useState("");
  /** 当前 items 是按哪个词搜回来的 —— 用来判断「把搜索词删短」时本地名单还够不够筛 */
  const [loadedKeyword, setLoadedKeyword] = useState("");

  const say = useCallback((message: string) => {
    if (onToast) onToast(message);
    else setInlineMessage(message);
  }, [onToast]);

  /** 面板自己那条提示 4 秒后收起来，别一直挂在那当噪音 */
  useEffect(() => {
    if (!inlineMessage) return;
    const timer = setTimeout(() => setInlineMessage(""), 4000);
    return () => clearTimeout(timer);
  }, [inlineMessage]);

  /** 请求序号（2026-08-31 排查条目28）：只让「最后一次发出去的请求」的结果落地 */
  const loadSeqRef = useRef(0);

  /** 2026-09-01 竞态全扫：保存/删除地址后的刷新，原来用的是**点保存那一刻**的搜索词。
      保存请求飞着的几秒里用户把搜索词改成了 B，刷新还按旧词 A 去查、又领的是新号，
      会「合法」盖掉用户改搜 B 的结果。所以刷新一律从这个 ref 取「此刻输入框里的词」。
      每次渲染同步一次最新值。 */
  const keywordRef = useRef("");
  keywordRef.current = keyword;

  const loadAddresses = useCallback(async (kw: string) => {
    /* ⚠️ 快速连删（「ABC」→「AB」→「A」）会连发两个请求，网络上谁先回没有保证。
       若「AB」的响应比「A」的后到，items 和 loadedKeyword 会停在 AB 那份小名单上、
       而输入框里是「A」—— 本地筛又开始缺人。所以每次发请求领一个自增序号，
       响应回来时序号已经不是最新的就整个丢弃（数据、报错、loading 都不动，
       全交给最后那个请求收尾）。 */
    const seq = ++loadSeqRef.current;
    setLoading(true);
    try {
      const resp = await fetch(`${apiBaseUrl()}/staff/lastmile/addresses?keyword=${encodeURIComponent(kw)}`, {
        headers: authHeaders(),
      });
      // 走 parseApiResponse：401 会自动跳登录页；失败也给提示，不再静默空白
      const json = await parseApiResponse<{ items: ClientRow[] }>(resp);
      if (seq !== loadSeqRef.current) return; // 旧响应后到，丢弃
      setItems(json.items ?? []);
      setLoadedKeyword(kw);
    } catch (e) {
      if (seq !== loadSeqRef.current) return; // 过期请求的报错也不弹，免得盖住新请求的结果
      say(`地址库加载失败：${e instanceof Error ? e.message : "未知错误"}`);
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [say]);

  const loadNotes = useCallback(async () => {
    try { setNotes(await fetchClientNotes()); } catch { /* 备注加载失败不挡主流程 */ }
  }, []);

  /**
   * ⚠️ 进来就加载（2026-08-29 加）。
   * 原来两个都没有：客户列表要手动点「重置」才出来，
   * 备注则**只在保存备注之后**才加载，所以「备注」那栏永远显示「暂无备注」。
   */
  useEffect(() => {
    void loadAddresses("");
    void loadNotes();
  }, [loadAddresses, loadNotes]);

  const saveNote = async (clientId: string, content: string) => {
    try {
      // 不看返回就弹「已保存」是老毛病，失败也照弹 —— 必须先 parseApiResponse
      const res = await fetch(`${apiBaseUrl()}/admin/shipping/notes`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, content }),
      });
      await parseApiResponse(res);
      say("备注已保存");
      setEditingNote(null);
      await loadNotes();
    } catch (e) { say(e instanceof Error ? e.message : "保存失败，请重试"); }
  };

  const saveNewAddress = async (clientId: string) => {
    if (!addForm.contactName.trim() || !addForm.contactPhone.trim() || !addForm.addressDetail.trim()) {
      say("请填写完整地址信息"); return;
    }
    try {
      const res = await fetch(`${apiBaseUrl()}/staff/client-addresses`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, ...addForm }),
      });
      await parseApiResponse(res);
      say("地址已添加");
      setAddingFor(null);
      setAddForm({ contactName: "", contactPhone: "", addressDetail: "", label: "" });
      // 2026-09-01 竞态全扫：用「此刻输入框里的词」刷新，不用点保存那一刻的旧词
      await loadAddresses(keywordRef.current);
    } catch (e) { say(e instanceof Error ? e.message : "保存失败，请重试"); }
  };

  const saveEditedAddress = async () => {
    if (!editingAddr) return;
    if (!editingAddr.contactName.trim() || !editingAddr.contactPhone.trim() || !editingAddr.addressDetail.trim()) {
      say("请填写完整地址信息"); return;
    }
    try {
      const res = await fetch(`${apiBaseUrl()}/staff/client-addresses/update`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editingAddr.id,
          contactName: editingAddr.contactName,
          contactPhone: editingAddr.contactPhone,
          addressDetail: editingAddr.addressDetail,
        }),
      });
      await parseApiResponse(res);
      say("地址已修改");
      setEditingAddr(null);
      // 2026-09-01 竞态全扫：用「此刻输入框里的词」刷新，不用点保存那一刻的旧词
      await loadAddresses(keywordRef.current);
    } catch (e) { say(e instanceof Error ? e.message : "保存失败，请重试"); }
  };

  const removeAddress = async (addrId: string) => {
    try {
      const resp = await fetch(`${apiBaseUrl()}/staff/lastmile/addresses?id=${encodeURIComponent(addrId)}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      await parseApiResponse(resp);
      say("地址已删除");
      // 2026-09-01 竞态全扫：用「此刻输入框里的词」刷新，不用点删除那一刻的旧词
      await loadAddresses(keywordRef.current);
    } catch (e) { say(`删除失败：${e instanceof Error ? e.message : "网络错误"}`); }
  };

  const visible = items.filter((c) =>
    !keyword || c.id.toLowerCase().includes(keyword.toLowerCase()) || c.name.toLowerCase().includes(keyword.toLowerCase()));

  return (
    <>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          value={keyword}
          onChange={(e) => {
            const value = e.target.value;
            setKeyword(value);
            if (!value) { void loadAddresses(""); return; }
            /* 按回车搜过「ABC」之后，items 只剩符合 ABC 的小名单。这时把词删短成「AB」，
               在小名单里本地筛怎么筛都缺人 —— 本该出现的客户不显示，看着像没注册。
               判断标准：新词不再包含搜回这份名单的旧词，就得按新词重新向服务器查一次。
               （新词包含旧词 = 在收窄，本地筛不缺人，不用发请求，正常打字不受影响） */
            if (!value.toLowerCase().includes(loadedKeyword.toLowerCase())) void loadAddresses(value);
          }}
          onKeyDown={(e) => { if (e.key === "Enter") void loadAddresses(keyword); }}
          placeholder="搜索唛头或客户名"
          style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", fontSize: 13, flex: 1 }}
        />
        <button type="button" onClick={() => { setKeyword(""); void loadAddresses(""); }}
          style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 12px", fontSize: 13, background: "var(--white)", color: "var(--t-strong)", cursor: "pointer" }}>重置</button>
      </div>
      {inlineMessage ? (
        <div style={{ marginBottom: 10, fontSize: 12, color: "var(--t-strong)", background: "var(--s-cool)", border: "1px solid var(--s-cool-2)", borderRadius: 6, padding: "6px 8px" }}>
          {inlineMessage}
        </div>
      ) : null}
      {loading ? <div style={{ color: "var(--t-strong)", fontSize: 13, padding: "20px 0", textAlign: "center" }}>加载中…</div>
      : visible.length === 0 ? <div style={{ color: "var(--t-strong)", fontSize: 13, padding: "20px 0", textAlign: "center" }}>暂无客户数据</div>
      : (
        <div style={{ display: "grid", gap: 10 }}>
          {visible.map((client) => (
            <div key={client.id} style={{ border: "1px solid var(--l-cool)", borderRadius: 8, padding: 12, background: "var(--white)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div>
                  {/* 只显示唛头，不带客户名字（2026-09-19）；按名字照样能搜 */}
                  <span style={{ fontWeight: 700, fontSize: 15, color: "#14171D", fontFamily: "monospace" }}>{client.id}</span>
                </div>
                <span style={{ fontSize: 12, color: "var(--t-strong)" }}>{client.phone}</span>
              </div>

              {client.addresses.length === 0
                ? <div style={{ fontSize: 12, color: "var(--t-strong)" }}>暂无地址</div>
                : client.addresses.map((addr) => (
                  <div key={addr.id} style={{ padding: "6px 8px", background: "var(--s-cool)", borderRadius: 6, marginBottom: 4, border: addr.isDefault ? "1px solid #bbf7d0" : "1px solid var(--s-cool-2)" }}>
                    {editingAddr?.id === addr.id ? (
                      /* 编辑态：就地改。原来只有「删除」—— 电话打错一位就得整条删掉重加，
                         客户的默认地址标记也跟着没了。 */
                      <div style={{ display: "grid", gap: 4 }}>
                        <input value={editingAddr.contactName} onChange={(e) => setEditingAddr((v) => v ? { ...v, contactName: e.target.value } : null)} placeholder="联系人姓名" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "4px 6px", fontSize: 11 }} />
                        <input value={editingAddr.contactPhone} onChange={(e) => setEditingAddr((v) => v ? { ...v, contactPhone: e.target.value } : null)} placeholder="联系电话" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "4px 6px", fontSize: 11 }} />
                        <textarea value={editingAddr.addressDetail} onChange={(e) => setEditingAddr((v) => v ? { ...v, addressDetail: e.target.value } : null)} rows={2} placeholder="详细地址" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "4px 6px", fontSize: 11, width: "100%", resize: "vertical" }} />
                        <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                          <button type="button" onClick={() => setEditingAddr(null)} style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "3px 8px", fontSize: 11, background: "var(--white)", cursor: "pointer" }}>取消</button>
                          <button type="button" onClick={() => void saveEditedAddress()} style={{ border: "none", borderRadius: 4, padding: "3px 8px", fontSize: 11, background: "var(--c-blue)", color: "var(--white)", cursor: "pointer" }}>保存</button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12, color: "var(--t-strong)" }}>
                            {addr.isDefault ? <span style={{ color: "var(--c-green-3)", fontWeight: 600 }}>[默认]</span> : null}
                            {addr.contactName} | {addr.contactPhone}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--t-strong)", marginTop: 2 }}>{addr.addressDetail}</div>
                        </div>
                        <div style={{ display: "flex", gap: 4, marginLeft: 8 }}>
                          <button type="button"
                            onClick={() => { setAddingFor(null); setEditingAddr({ id: addr.id, contactName: addr.contactName, contactPhone: addr.contactPhone, addressDetail: addr.addressDetail }); }}
                            style={{ border: "1px solid var(--c-blue)", borderRadius: 4, padding: "2px 5px", fontSize: 10, background: "var(--white)", color: "var(--c-blue)", cursor: "pointer", whiteSpace: "nowrap" }}>编辑</button>
                          <button type="button"
                            onClick={() => { if (!confirm("确定删除该地址？")) return; void removeAddress(addr.id); }}
                            style={{ border: "1px solid #fca5a5", borderRadius: 4, padding: "2px 5px", fontSize: 10, background: "var(--white)", color: "var(--c-red-2)", cursor: "pointer", whiteSpace: "nowrap" }}>删除</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}

              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <button type="button"
                  onClick={() => { setEditingAddr(null); setAddingFor(client.id); setAddForm({ contactName: "", contactPhone: "", addressDetail: "", label: "" }); }}
                  style={{ border: "1px solid var(--c-blue)", borderRadius: 4, padding: "4px 8px", fontSize: 11, background: "var(--c-blue-bg)", color: "var(--c-blue)", cursor: "pointer" }}>添加地址</button>
                <button type="button"
                  onClick={() => setEditingNote({ clientId: client.id, content: notes[client.id]?.content ?? "" })}
                  style={{ border: "1px solid #1e3a8a", borderRadius: 4, padding: "4px 8px", fontSize: 11, background: "#EEF2FB", color: "#1e3a8a", cursor: "pointer" }}>编辑备注</button>
              </div>

              {addingFor === client.id && (
                <div style={{ marginTop: 6, padding: 8, background: "#EEF2FB", borderRadius: 6, border: "1px solid #E4E6EC" }}>
                  <div style={{ display: "grid", gap: 4 }}>
                    <input value={addForm.contactName} onChange={(e) => setAddForm((v) => ({ ...v, contactName: e.target.value }))} placeholder="联系人姓名" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "4px 6px", fontSize: 11 }} />
                    <input value={addForm.contactPhone} onChange={(e) => setAddForm((v) => ({ ...v, contactPhone: e.target.value }))} placeholder="联系电话" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "4px 6px", fontSize: 11 }} />
                    <input value={addForm.addressDetail} onChange={(e) => setAddForm((v) => ({ ...v, addressDetail: e.target.value }))} placeholder="详细地址" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "4px 6px", fontSize: 11 }} />
                    <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                      <button type="button" onClick={() => setAddingFor(null)} style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "3px 8px", fontSize: 11, background: "var(--white)", cursor: "pointer" }}>取消</button>
                      <button type="button" onClick={() => void saveNewAddress(client.id)} style={{ border: "none", borderRadius: 4, padding: "3px 8px", fontSize: 11, background: "var(--c-blue)", color: "var(--white)", cursor: "pointer" }}>保存</button>
                    </div>
                  </div>
                </div>
              )}

              {editingNote?.clientId === client.id && (
                <div style={{ marginTop: 6, padding: 8, background: "#EEF2FB", borderRadius: 6, border: "1px solid #E4E6EC" }}>
                  <textarea value={editingNote.content} onChange={(e) => setEditingNote((v) => v ? { ...v, content: e.target.value } : null)} rows={3} placeholder="输入备注..." style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "4px 6px", fontSize: 11, width: "100%", resize: "vertical" }} />
                  <div style={{ display: "flex", gap: 4, justifyContent: "flex-end", marginTop: 4 }}>
                    <button type="button" onClick={() => setEditingNote(null)} style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "3px 8px", fontSize: 11, background: "var(--white)", cursor: "pointer" }}>取消</button>
                    <button type="button" onClick={() => void saveNote(client.id, editingNote.content)} style={{ border: "none", borderRadius: 4, padding: "3px 8px", fontSize: 11, background: "#1e3a8a", color: "var(--white)", cursor: "pointer" }}>保存</button>
                  </div>
                </div>
              )}

              <div style={{ marginTop: 8, borderTop: "1px solid var(--l-soft)", paddingTop: 8 }}>
                <div style={{ fontSize: 11, color: "var(--t-muted)", marginBottom: 4 }}>备注</div>
                <div style={{ fontSize: 12, color: notes[client.id]?.content ? "var(--t-strong)" : "var(--t-faint)", whiteSpace: "pre-wrap" }}>
                  {notes[client.id]?.content || "暂无备注"}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export default LastmileAddressPanel;
