"use client";

/**
 * 「编辑运单」弹窗（超管「运单管理」和员工「运单管理」共用一个，2026-10-19 从 admin/page.tsx 原样搬出来）。
 *
 * 为什么搬：老板拍板「给员工加权限」—— 员工也能改运单。员工端原来只有只读的「运单详情」，
 * 要改就得用超管这一个编辑框；两边各写一份，以后修一边漏一边（CLAUDE.md 教训 20），所以抽成一个，两页都挂它。
 * 后端都走 /admin/orders/update（员工 2026-10-19 起放开）。
 *
 * 行为跟搬之前一样（这些都是前面多轮审查定下的）：
 * - 打开那一刻记下表单、产品行和订单版本（orderUpdatedAt）；保存只发改过的项，每次都带版本，后端锁里核对，别人先存了就 409；
 * - 存完不关，「打开时的样子」换成刚存的这一份 + 返回的新版本；
 * - 第几次打开 / 关上由页面管（sessionRef：打开、取消、点 ✕、离开那一页都 +1）；存的过程中关了 / 换了别的单，
 *   报错不写进弹窗、走提示条「之前那张单没存上」，成功也说「之前那张单：」；
 * - 页面切到别的栏目时弹窗不挂（visible=false 时不画），但这个组件还在，填的内容留着，回来照样在。
 */
import { useMemo, useState, type MutableRefObject } from "react";
import DetailModal from "../layout/DetailModal";
import MarkPicker from "../layout/MarkPicker";
import { activeMarkOptions, bannedChangeHint, bannedClientIds, withCurrentMark } from "../shared/client-ban";
import { decideEditTotals } from "./edit-totals";
import { validateProductRows, packageCountForPayload } from "./productRowGuard";
import { CARGO_TYPES, CARGO_TYPE_ZH } from "../../../../../packages/shared-types/cargo-type";
import { apiBaseUrl } from "../../services/core-api";
import { updateAdminOrder } from "../../services/business-api";
import { waybillEditStateOf, type WaybillEditForm, type WaybillEditProduct, type WaybillEditSnapshot, type WaybillEditSource } from "./waybill-edit-state";

export { waybillEditStateOf };
export type { WaybillEditForm, WaybillEditProduct, WaybillEditSnapshot, WaybillEditSource };

const field = { border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" } as const;
const cell = { border: "1px solid var(--l-strong)", borderRadius: 4, padding: "4px 6px", fontSize: 12 } as const;

export default function WaybillEditDialog(props: {
  /** 打开时点的那一行（表单只在挂上那一刻按它建一次） */
  initial: WaybillEditSource;
  /** 列表里这张最新的（标题、产品图跟着变；列表里找不到了页面传打开时那份） */
  current: WaybillEditSource;
  /** 页面切到别的栏目时 false：不画弹窗，但组件留着、填的内容留着 */
  visible: boolean;
  clientList: Array<{ id: string; status?: string | null }>;
  /** 第几次打开 / 关上（页面管：打开、取消、点 ✕、离开那一页都 +1） */
  sessionRef: MutableRefObject<number>;
  /** 页面的「忙」：保存期间别的按钮也灰着（搬之前用的就是页面的 loading） */
  busy: boolean;
  setBusy: (busy: boolean) => void;
  /** 关弹窗（取消、✕ 的关闭动画放完） */
  onClose: () => void;
  /** 点 ✕ 那一刻（关闭动画放之前）：页面给 sessionRef +1、记下「已经点了 ✕」，返回 true 照常关 */
  confirmClose: () => boolean;
  /** 页面底下的提示条 */
  onToast: (text: string) => void;
  /** 刷新列表（失败要抛出来） */
  reloadList: () => Promise<unknown>;
}) {
  const { initial, current, visible, clientList, sessionRef, busy, setBusy, onClose, confirmClose, onToast, reloadList } = props;
  const [opened] = useState(() => waybillEditStateOf(initial));
  const [form, setForm] = useState<WaybillEditForm>(opened.form);
  const [products, setProducts] = useState<WaybillEditProduct[]>(opened.products);
  const [snapshot, setSnapshot] = useState<WaybillEditSnapshot | null>(opened.snapshot);
  const [message, setMessage] = useState("");
  /* 编辑弹窗里实时提示「总重量/总体积保存时听谁的」（2026-08-31，排查报告第22条）。
     跟保存用的是同一个 decideEditTotals，界面上说的和实际存的不会两张皮。 */
  const totalsPreview = useMemo(() => decideEditTotals(products, form.weightKg, form.volumeM3), [products, form.weightKg, form.volumeM3]);

  /** 保存（原 admin/page.tsx 的 submitOrderEdit） */
  const submit = async () => {
    if (busy) return;
    const saveOrderId = initial.orderId ?? initial.id;
    if (!saveOrderId) {
      setMessage("请先选择要编辑的订单。");
      return;
    }
    if (!form.trackingNo.trim()) {
      setMessage("请填写运单号。");
      return;
    }
    // 从产品行计算总数
    const activeProducts = products;
    // ⚠️ 先把产品行卡住再算合计（2026-08-29 补）。箱数是三个合计的乘数，
    // 原来 `Number(p.packageCount) || 1` 会把「没填」和「填 0」悄悄当成 1 箱。
    {
      const rowIssue = validateProductRows(activeProducts);
      if (rowIssue) { setMessage(rowIssue); return; }
    }
    const totalPackageCount = activeProducts.reduce((s, p) => s + Number(String(p.packageCount).trim()), 0);
    // ⚠️ 产品行上的「数量」口径是**单箱几个**（这一页的表头就写着「单箱数量」），
    // 所以总数必须乘箱数。2026-08-28 复核实测：这里原来直接相加，跟批量导入犯的是同一个错。
    // 口径见 apps/api/src/modules/orders/routes.ts:833 的注释。
    const totalProductQuantity = activeProducts.reduce(
      (s, p) => s + (Number(p.productQuantity) || 0) * Number(String(p.packageCount).trim()),
      0,
    );
    const primaryItemName = activeProducts[0]?.itemName.trim() || form.itemName.trim();
    if (!primaryItemName) {
      setMessage("请填写品名。");
      return;
    }
    if (activeProducts.length === 0) {
      setMessage("请至少添加一个产品行。");
      return;
    }
    // 总体积/总重量「自动算 vs 手填」的裁决统一走 decideEditTotals
    // （2026-08-31，排查报告第22条：原来任何一行填了尺寸就静默扔掉手填值）
    const { finalVolume, finalWeight, notes: totalsNotes } = decideEditTotals(activeProducts, form.weightKg, form.volumeM3);

    const sessionAtSubmit = sessionRef.current;

    setBusy(true);
    setMessage("");
    try {
      const payloadProducts = activeProducts.map((p) => ({
        id: p.id,
        itemName: p.itemName.trim(),
        packageCount: packageCountForPayload(p.packageCount),
        lengthCm: p.lengthCm ? Number(p.lengthCm) : undefined,
        widthCm: p.widthCm ? Number(p.widthCm) : undefined,
        heightCm: p.heightCm ? Number(p.heightCm) : undefined,
        productQuantity: p.productQuantity ? Number(p.productQuantity) : undefined,
        cargoType: p.cargoType || "normal",
        domesticTrackingNo: p.domesticTrackingNo.trim() || "货拉拉",
        weightKg: p.weightKg ? Number(p.weightKg) : undefined,
      }));

      // 只把「打开弹窗之后被改动过的项」发出去。没改的不发，
      // 后端就不会去动它 —— 这样两个人改不同字段不会互相覆盖。
      const snap = snapshot?.form;
      const changed = (key: string, value: string) => !snap || snap[key] !== value;
      const productsChanged = !snapshot || snapshot.productsJson !== JSON.stringify(activeProducts);
      // 只改了手填的总重量/总体积、没动产品明细时也要保存（2026-08-31，排查报告第22条：
      // 原来这两个数只跟着产品行一起发，单独改手填框等于白填）
      const manualTotalsChanged = changed("weightKg", form.weightKg) || changed("volumeM3", form.volumeM3);

      /* 每次保存都带上「打开时（或上次存完时）」的订单版本（2026-10-18 全系统审查第一档第 6 条；Codex / dsh 第 2 轮改成每次都带）：
         后端锁里核对，别人这期间存过就 409、什么都不写。
         ⚠️ 不能只在改产品行 / 合计时才带：只改备注那次不核对的话，别人刚改的产品行我这边看不见，存完基线却换成了新版本，
         接着再改产品行时带着新版本一核对就放行 —— 旧产品行把别人加的行删掉、改的盖回去。代价是两人同时改不同的单项时后存的也要重开一次 */
      // 这次发出去的是哪一份（存完拿它当新的「打开时的样子」；await 回来时 state 可能已经是用户接着输的新内容）
      const snapAtSubmit = snapshot;
      const submittedForm = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v == null ? "" : String(v)])) as Record<string, string>;
      const submittedProductsJson = JSON.stringify(activeProducts);
      const saved = await updateAdminOrder({
        orderId: saveOrderId,
        ...(snapshot?.orderUpdatedAt ? { expectedOrderUpdatedAt: snapshot.orderUpdatedAt } : {}),
        ...(changed("clientId", form.clientId) ? { clientId: form.clientId.trim() || "" } : {}),
        ...(changed("itemName", form.itemName) || productsChanged ? { itemName: primaryItemName } : {}),
        ...(changed("trackingNo", form.trackingNo) ? { trackingNo: form.trackingNo.trim() || "" } : {}),
        ...(changed("batchNo", form.batchNo) ? { batchNo: form.batchNo.trim() || "" } : {}),
        ...(changed("warehouseId", form.warehouseId) ? { warehouseId: form.warehouseId } : {}),
        ...(changed("transportMode", form.transportMode) ? { transportMode: form.transportMode } : {}),
        ...(changed("domesticTrackingNo", form.domesticTrackingNo) ? { domesticTrackingNo: form.domesticTrackingNo.trim() || "" } : {}),
        ...(changed("receiverAddressTh", form.receiverAddressTh) ? { receiverAddressTh: form.receiverAddressTh.trim() } : {}),
        ...(changed("containerNo", form.containerNo) ? { containerNo: form.containerNo.trim() || "" } : {}),
        ...(changed("packageUnit", form.packageUnit) ? { packageUnit: form.packageUnit } : {}),
        ...(changed("cargoType", form.cargoType) ? { cargoType: form.cargoType } : {}),
        ...(changed("shipDate", form.shipDate) ? { shipDate: form.shipDate.trim() } : {}),
        ...(changed("remark", form.remark ?? "") ? { remark: form.remark?.trim() || null } : {}),
        // 件数/数量是按产品行算出来的，产品行没动就不发
        ...(productsChanged ? {
          productQuantity: totalProductQuantity,
          packageCount: totalPackageCount,
          products: payloadProducts,
        } : {}),
        // 重量/体积单独判断：产品行或手填框任一动过就发（见上面 manualTotalsChanged 的注释）
        ...(productsChanged || manualTotalsChanged ? {
          weightKg: finalWeight,
          volumeM3: finalVolume,
        } : {}),
      });
      /* 弹窗存完不关：「打开时的样子」整个换成刚存进去的这一份 + 返回的新版本（2026-10-18 Codex / dsh 第 1 轮）。
         只换版本不换基线的话，接着改别的再存，第一次存过的字段会按旧基线又发一遍（不带版本，因为没动产品行），
         别人这期间改的同一字段被盖回去；产品行也一直算「改过」、每次整组发。
         只在还是同一个弹窗时换（存的过程中关掉又开了别的单，那边已经有自己的基线） */
      setSnapshot((prev) => (prev && prev === snapAtSubmit ? { form: submittedForm, productsJson: submittedProductsJson, orderUpdatedAt: saved.updatedAt } : prev));
      // 手填值和自动计算冲突时明说哪边生效了，不再静默（排查报告第22条）
      // 存的过程中已经关了 / 换了别的单：提示里写明是之前那张（Codex 第 3、4 轮）
      const whose = sessionRef.current === sessionAtSubmit ? "" : "之前那张单：";
      const savedText = `${whose}${totalsNotes.length > 0 ? `订单信息已更新。${totalsNotes.join("；")}` : "订单信息已更新"}`;
      onToast(savedText);
      // 已经存上了：接着刷新列表失败不能落进下面的「保存失败」（dsh 第 5 轮）；10 秒后会自动再刷。合计听谁的那句照样留着（dsh 第 6 轮）
      await reloadList().catch(() => onToast(`${savedText}（列表这次没刷新上，稍后会自动刷新）`));
    } catch (error) {
      const text = error instanceof Error ? error.message : "保存失败";
      // 还是同一次打开的弹窗才写进弹窗；已经关了 / 换了别的单，用提示条说「之前那张没存上」（Codex 第 3、4 轮）
      if (sessionRef.current === sessionAtSubmit) setMessage(`保存失败：${text}`);
      else onToast(`之前那张单没存上：${text}`);
      // 被别人抢先存了：顺手把列表刷新，关掉重开就是最新的（不等 10 秒那次自动刷新）
      if (/刚刚被别人改过/.test(text)) reloadList().catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  if (!visible) return null;
  const setProduct = (i: number, key: keyof WaybillEditProduct, value: string) => {
    const n = [...products];
    n[i] = { ...n[i], [key]: value };
    setProducts(n);
  };
  return (
    <DetailModal
      title="编辑运单"
      subtitle={current.trackingNo ?? current.orderNo ?? "—"}
      onClose={onClose}
      confirmClose={confirmClose}
      closeOnEsc={false}
    >
      <div style={{ display: "grid", gap: 8 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
          {/* 唛头用自己画的下拉（2026-10-08，替掉浏览器自带的 datalist）；只显示唛头。
              封禁的唛头不进下拉（2026-10-17，modules/shared/client-ban.ts）：换成它后端会拦，提示在这一排格子下面；
              原来就挂在封禁唛头名下的单照常改、不提示，那个唛头留在下拉里（不然一点开就是「匹配 0 个」） */}
          <MarkPicker value={form.clientId} onChange={(v) => setForm((f) => ({ ...f, clientId: v }))} options={withCurrentMark(activeMarkOptions(clientList), snapshot?.form.clientId)} placeholder="唛头" inputStyle={field} />
          <input value={form.trackingNo} onChange={(e) => setForm((v) => ({ ...v, trackingNo: e.target.value.toUpperCase() }))} placeholder="运单号" style={field} />
          <input value={form.batchNo} onChange={(e) => setForm((v) => ({ ...v, batchNo: e.target.value }))} placeholder="柜号" style={field} />
          <select value={form.warehouseId} onChange={(e) => setForm((v) => ({ ...v, warehouseId: e.target.value }))} style={field}><option value="wh_yiwu_01">义乌仓</option><option value="wh_guangzhou_01">广州仓</option><option value="wh_dongguan_01">东莞仓</option><option value="wh_shenzhen_01">深圳仓</option></select>
          <select value={form.transportMode} onChange={(e) => setForm((v) => ({ ...v, transportMode: e.target.value as "sea" | "land" }))} style={field}><option value="sea">海运</option><option value="land">陆运</option></select>
          <input value={form.domesticTrackingNo} onChange={(e) => setForm((v) => ({ ...v, domesticTrackingNo: e.target.value }))} placeholder="货拉拉" style={field} />
          <input value={form.receiverAddressTh} onChange={(e) => setForm((v) => ({ ...v, receiverAddressTh: e.target.value }))} placeholder="收货地址" style={field} />
          <input value={form.containerNo} onChange={(e) => setForm((v) => ({ ...v, containerNo: e.target.value }))} placeholder="装柜号" style={field} />
          <select value={form.packageUnit} onChange={(e) => setForm((v) => ({ ...v, packageUnit: e.target.value as "bag" | "box" }))} style={field}><option value="box">箱</option><option value="bag">袋</option></select>
          <input value={form.weightKg} onChange={(e) => setForm((v) => ({ ...v, weightKg: e.target.value }))} placeholder="重量(kg)" style={field} />
          <input value={form.volumeM3} onChange={(e) => setForm((v) => ({ ...v, volumeM3: e.target.value }))} placeholder="体积(m³)" style={field} />
          <input type="date" value={form.shipDate} onChange={(e) => setForm((v) => ({ ...v, shipDate: e.target.value }))} style={field} />
        </div>
        {/* 换成封禁的唛头时的提示（放在格子外面，不把那一排撑高） */}
        {(() => {
          const hint = bannedChangeHint(form.clientId, snapshot?.form.clientId, bannedClientIds(clientList));
          return hint ? <div style={{ color: "var(--c-red-deep)", fontSize: 12 }}>{hint}</div> : null;
        })()}
        {/* 手填总重量/总体积和产品行自动计算冲突时，当场说清保存后哪边生效
            （2026-08-31，排查报告第22条：原来静默扔掉手填值，没人察觉） */}
        {totalsPreview.notes.length > 0 && (
          <div style={{ fontSize: 12, color: "var(--c-red-deep)", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "6px 10px" }}>
            {totalsPreview.notes.map((n, i) => (<div key={i}>{n}</div>))}
          </div>
        )}
        <div style={{ border: "1px solid var(--l-soft)", borderRadius: 8, padding: 10, background: "var(--s-alt)", marginTop: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: "var(--t-strong)" }}>产品行编辑</div>
          {products.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--t-faint)", padding: "4px 0" }}>无产品行，点击下方按钮添加</div>
          )}
          {products.map((p, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "2fr 0.4fr 0.3fr 0.3fr 0.3fr 0.4fr 0.45fr 0.8fr 1fr auto", gap: 4, marginBottom: 4, alignItems: "center" }}>
              <input value={p.itemName} onChange={(e) => setProduct(i, "itemName", e.target.value)} placeholder="品名" style={cell} />
              <input type="number" value={p.packageCount} onChange={(e) => setProduct(i, "packageCount", e.target.value)} placeholder="箱数" style={cell} />
              <input type="number" step="0.01" value={p.lengthCm} onChange={(e) => setProduct(i, "lengthCm", e.target.value)} placeholder="长cm" style={cell} />
              <input type="number" step="0.01" value={p.widthCm} onChange={(e) => setProduct(i, "widthCm", e.target.value)} placeholder="宽cm" style={cell} />
              <input type="number" step="0.01" value={p.heightCm} onChange={(e) => setProduct(i, "heightCm", e.target.value)} placeholder="高cm" style={cell} />
              <input type="number" value={p.productQuantity} onChange={(e) => setProduct(i, "productQuantity", e.target.value)} placeholder="单箱数量" style={cell} />
              <input type="number" step="0.01" value={p.weightKg} onChange={(e) => setProduct(i, "weightKg", e.target.value)} placeholder="单箱重kg" style={cell} />
              <select value={(p.cargoType || "normal").toLowerCase()} onChange={(e) => setProduct(i, "cargoType", e.target.value)} style={{ ...cell, background: "var(--white)" }}>
                {CARGO_TYPES.map((c) => <option key={c} value={c}>{CARGO_TYPE_ZH[c]}</option>)}
              </select>
              <input value={p.domesticTrackingNo || ""} onChange={(e) => setProduct(i, "domesticTrackingNo", e.target.value)} placeholder="货拉拉" style={cell} />
              <button type="button" onClick={() => setProducts((v) => v.filter((_, j) => j !== i))} style={{ border: "1px solid #fca5a5", borderRadius: 4, padding: "4px 6px", fontSize: 11, background: "var(--white)", color: "var(--c-red-2)", cursor: "pointer" }}>X</button>
            </div>
          ))}
          <button type="button" onClick={() => setProducts((v) => [...v, { itemName: "", packageCount: "", lengthCm: "", widthCm: "", heightCm: "", productQuantity: "", weightKg: "", cargoType: "normal", domesticTrackingNo: "" }])} style={{ border: "1px dashed var(--c-blue)", borderRadius: 4, padding: "4px 10px", fontSize: 12, background: "var(--white)", color: "var(--c-blue)", cursor: "pointer", marginTop: 4 }}>+ 添加产品</button>
        </div>
        {(current.productImages?.length ?? 0) > 0 && (
          <div style={{ marginTop: 8, padding: 10, background: "var(--s-cool)", borderRadius: 8, border: "1px solid var(--l-cool)" }}>
            <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13, color: "var(--t-strong)" }}>产品图</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {current.productImages!.map((img) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={img.id} src={img.imageUrl ? `${apiBaseUrl()}${img.imageUrl}` : ""} alt={img.fileName} style={{ width: 88, height: 88, objectFit: "cover", borderRadius: 8, border: "1px solid var(--l-soft)" }} />
              ))}
            </div>
          </div>
        )}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: "var(--t-strong)", marginBottom: 4 }}>备注</div>
          <input value={form.remark} onChange={(e) => setForm((v) => ({ ...v, remark: e.target.value }))} placeholder="备注（可选）" style={{ ...field, width: "100%", fontSize: 13 }} />
        </div>

        {/* 保存失败 / 没填全的提示原来只写在页面最底下，被这个全屏弹窗挡住，点保存像没反应。
            拆过柜的单填了比已装走还少的数会被后端拒绝（2026-09-28 审查修复 #1），那句话必须让人看见 */}
        {message ? (
          <p role="alert" style={{ margin: "0 0 8px", color: "var(--c-red-deep)" /* 这里只会是没填全 / 保存失败（成功走提示条），一律红字；原来只认「失败」，「请填写运单号。」成了绿字（dsh 第 9 轮） */ }}>{message}</p>
        ) : null}
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={() => void submit()} disabled={busy} style={{ border: "none", borderRadius: 6, padding: "9px 18px", color: "var(--white)", background: "var(--c-navy)", cursor: "pointer", fontWeight: 600 }}>保存</button>
          <button type="button" onClick={onClose} style={{ border: "1px solid #d8d6d1", borderRadius: 6, padding: "9px 18px", background: "var(--white)", cursor: "pointer", color: "#14171D" }}>取消</button>
        </div>
      </div>
    </DetailModal>
  );
}
