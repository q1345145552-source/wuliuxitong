"use client";

import { useState } from "react";
import {
  createAdminAgent,
  updateAdminAgent,
  type AdminAgentItem,
  type AgentLogoUpload,
} from "../../../services/agents-admin-api";
import { Modal, ErrorBar, btnCancel, btnConfirm, btnSmall, fi, fl, hint, readLogoFile } from "./agent-ui";

/**
 * 开代理 / 编辑代理弹窗（2026-09-16，B2；确认单 2.1 / 2.8 / 2.9 / 4.2 / 5.5 / 6.1）。
 * 开代理时多填登录账号和密码；编辑时不改账号密码（重置密码单独一个按钮）。
 * 校验以后端为准，这里只挡「一眼就知道不对」的，免得白点一次。
 */
export default function AgentFormModal(props: {
  mode: "create" | "edit";
  agent?: AdminAgentItem | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const { mode, agent, onClose, onSaved } = props;
  const [name, setName] = useState(agent?.name ?? "");
  const [slug, setSlug] = useState(agent?.slug ?? "");
  const [customDomain, setCustomDomain] = useState(agent?.customDomain ?? "");
  const [priceNormal, setPriceNormal] = useState(agent ? String(agent.prices.normal) : "");
  const [priceInspection, setPriceInspection] = useState(agent ? String(agent.prices.inspection) : "");
  const [priceSensitive, setPriceSensitive] = useState(agent ? String(agent.prices.sensitive) : "");
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [logo, setLogo] = useState<AgentLogoUpload | null>(null);
  const [logoPreview, setLogoPreview] = useState<string>(agent?.logoUrl ?? "");
  const [removeLogo, setRemoveLogo] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const slugPreview = slug.trim().toLowerCase();
  // 跟后端 normalizeAgentDomain 同一口径：去空格、转小写、去掉手抄时带上的 http(s):// 和结尾的 /
  const domainPreview = customDomain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const pricesRaised = agent != null && (
    Number(priceNormal) > agent.prices.normal || Number(priceInspection) > agent.prices.inspection || Number(priceSensitive) > agent.prices.sensitive
  );

  const handleLogo = async (file: File | undefined) => {
    if (!file) return;
    try {
      const r = await readLogoFile(file);
      setLogo({ mime: r.mime, base64: r.base64 });
      setLogoPreview(r.previewUrl);
      setRemoveLogo(false);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "logo 读取失败");
    }
  };

  const submit = async () => {
    if (!name.trim()) { setError("请填代理名字"); return; }
    const prices = { normal: Number(priceNormal), inspection: Number(priceInspection), sensitive: Number(priceSensitive) };
    if ([priceNormal, priceInspection, priceSensitive].some((v) => v.trim() === "") || Object.values(prices).some((v) => !Number.isFinite(v) || v <= 0)) {
      setError("三档代理价都要填，而且要大于 0");
      return;
    }
    if (mode === "create") {
      if (!loginId.trim()) { setError("请填登录账号"); return; }
      if (!password) { setError("请填登录密码"); return; }
    }
    setSaving(true);
    setError("");
    try {
      if (mode === "create") {
        const r = await createAdminAgent({
          name: name.trim(), slug, customDomain, prices, loginId: loginId.trim(), password, phone: phone.trim(), logo,
        });
        onSaved(`代理已开好，登录账号 ${r.loginId}`);
      } else if (agent) {
        await updateAdminAgent({ id: agent.id, name: name.trim(), slug, customDomain, prices, logo, removeLogo: removeLogo && !logo });
        onSaved("代理信息已保存");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <h3 style={{ marginTop: 0 }}>{mode === "create" ? "开代理" : `编辑代理：${agent?.name ?? ""}`}</h3>
      <ErrorBar message={error} />

      <div style={{ display: "grid", gap: 12 }}>
        <div>
          <label style={fl}>代理名字</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="登录页、标签页、左上角显示这个名字" style={fi} maxLength={50} />
        </div>

        <div>
          <label style={fl}>logo（选填）</label>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {logoPreview && !removeLogo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoPreview} alt="logo 预览" style={{ width: 48, height: 48, objectFit: "contain", border: "1px solid var(--l-soft)", borderRadius: 6, background: "var(--white)" }} />
            ) : (
              <span style={{ fontSize: 12, color: "var(--t-faint)" }}>没有 logo</span>
            )}
            <input aria-label="上传代理 logo" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => void handleLogo(e.target.files?.[0])} style={{ fontSize: 12 }} />
            {mode === "edit" && agent?.logoUrl && !logo && (
              <button type="button" onClick={() => setRemoveLogo((v) => !v)} style={btnSmall}>{removeLogo ? "不删了" : "删掉 logo"}</button>
            )}
          </div>
          <div style={hint}>PNG / JPG / WEBP / GIF，最大 2MB。登录前就会显示，别放不能公开的图。</div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
          <div>
            <label style={fl}>后缀（选填）</label>
            <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="例如 bkk-wuliu" style={fi} maxLength={31} />
            <div style={hint}>
              加在网址末尾的一小段（小写字母、数字、横杠）。{slugPreview ? <>客户登录链接：<span style={{ fontFamily: "monospace" }}>{origin}/{slugPreview}</span></> : "不填就没有专属链接"}
              {mode === "edit" && agent?.slug && slugPreview !== agent.slug ? "（改了以后旧链接打不开）" : ""}
            </div>
          </div>
          <div>
            <label style={fl}>专属域名（选填）</label>
            <input value={customDomain} onChange={(e) => setCustomDomain(e.target.value)} placeholder="例如 wuliu.example.com" style={fi} />
            <div style={hint}>
              {domainPreview ? <>客户登录网址：<span style={{ fontFamily: "monospace" }}>https://{domainPreview}</span></> : "只填域名本身。填了还要在服务器上另外配好才能用。"}
              {mode === "edit" && agent?.customDomain && domainPreview !== agent.customDomain ? "（改了以后旧域名打不开）" : ""}
            </div>
          </div>
        </div>

        <div>
          <label style={fl}>湘泰给代理的价（元/方）</label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
            {([
              ["普货", priceNormal, setPriceNormal],
              ["商检货", priceInspection, setPriceInspection],
              ["敏感货", priceSensitive, setPriceSensitive],
            ] as const).map(([label, value, set]) => (
              <div key={label}>
                <div style={{ fontSize: 12, color: "var(--t-muted)", marginBottom: 2 }}>{label}</div>
                <input type="number" min="0" step="0.01" inputMode="decimal" value={value} onChange={(e) => set(e.target.value)} style={fi} />
              </div>
            ))}
          </div>
          {pricesRaised && (
            <div style={{ ...hint, color: "var(--c-amber-deep)" }}>调高了代理价：名下有客户的价比新价低的话保存不了，要先让代理把客户价调上去。</div>
          )}
        </div>

        {mode === "create" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
            <div>
              <label style={fl}>代理登录账号</label>
              <input value={loginId} onChange={(e) => setLoginId(e.target.value)} placeholder="代理登录时填的账号" style={fi} autoComplete="off" maxLength={40} />
            </div>
            <div>
              <label style={fl}>登录密码（代理提供）</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={fi} autoComplete="new-password" />
              <div style={hint}>至少 8 位，不能全是数字，不能跟账号一样</div>
            </div>
            <div>
              <label style={fl}>电话（选填）</label>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} style={fi} maxLength={40} />
            </div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <button type="button" onClick={onClose} style={btnCancel}>取消</button>
        <button type="button" onClick={() => void submit()} disabled={saving} style={{ ...btnConfirm, opacity: saving ? 0.6 : 1 }}>
          {saving ? "保存中…" : mode === "create" ? "开代理" : "保存"}
        </button>
      </div>
    </Modal>
  );
}
