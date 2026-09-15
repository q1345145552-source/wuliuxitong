"use client";

import { useMemo, useState } from "react";

const KUAIDI100_WEB_URL = "https://www.kuaidi100.com/";

/**
 * 在新标签页打开快递100；单号与公司编码可选，未填则打开官网首页（可再手动输入）。
 */
function openKuaidi100Track(tracking: string, companyCode: string) {
  const query = new URLSearchParams();
  if (tracking) query.set("nu", tracking.trim());
  if (companyCode.trim()) query.set("com", companyCode.trim());
  const suffix = query.toString();
  window.open(`${KUAIDI100_WEB_URL}${suffix ? `?${suffix}` : ""}`, "_blank", "noopener,noreferrer");
}

type ExpressCompanyOption = {
  code: string;
  name: string;
  pinyin: string;
  initials: string;
  keywords: string[];
};

const EXPRESS_COMPANY_OPTIONS: readonly ExpressCompanyOption[] = [
  { code: "shunfeng", name: "顺丰速运", pinyin: "shunfengsuyun", initials: "sfsy", keywords: ["顺丰", "sf"] },
  { code: "jd", name: "京东快递", pinyin: "jingdongkuaidi", initials: "jdkd", keywords: ["京东"] },
  { code: "debangwuliu", name: "德邦快递", pinyin: "debangkuaidi", initials: "dbkd", keywords: ["德邦"] },
  { code: "ems", name: "EMS", pinyin: "ems", initials: "ems", keywords: ["邮政", "ems"] },
  { code: "zhongtong", name: "中通快递", pinyin: "zhongtongkuaidi", initials: "ztkd", keywords: ["中通"] },
  { code: "yuantong", name: "圆通速递", pinyin: "yuantongsudi", initials: "ytsd", keywords: ["圆通"] },
  { code: "yunda", name: "韵达快递", pinyin: "yundakuaidi", initials: "ydkd", keywords: ["韵达"] },
  { code: "shentong", name: "申通快递", pinyin: "shentongkuaidi", initials: "stkd", keywords: ["申通"] },
  { code: "jtexpress", name: "极兔速递", pinyin: "jitusudi", initials: "jtsd", keywords: ["极兔", "jt"] },
  { code: "huitongkuaidi", name: "百世快递", pinyin: "baishikuaidi", initials: "bskd", keywords: ["百世", "汇通"] },
  { code: "annengwuliu", name: "安能物流", pinyin: "annengwuliu", initials: "anwl", keywords: ["安能"] },
  { code: "zhaijisong", name: "宅急送", pinyin: "zhaijisong", initials: "zjs", keywords: ["宅急送"] },
  { code: "youzhengguonei", name: "邮政快递包裹", pinyin: "youzhengkuaidibaoguo", initials: "yzkdbg", keywords: ["邮政", "包裹"] },
  { code: "youxiwuliu", name: "优速快递", pinyin: "yousukuaidi", initials: "yskd", keywords: ["优速"] },
  { code: "tiantian", name: "天天快递", pinyin: "tiantiankuaidi", initials: "ttkd", keywords: ["天天"] },
  { code: "suer", name: "速尔快递", pinyin: "suerkuaidi", initials: "sekd", keywords: ["速尔"] },
  { code: "guotongkuaidi", name: "国通快递", pinyin: "guotongkuaidi", initials: "gtkd", keywords: ["国通"] },
  { code: "quanfengkuaidi", name: "全峰快递", pinyin: "quanfengkuaidi", initials: "qfkd", keywords: ["全峰"] },
  { code: "kuayue", name: "跨越速运", pinyin: "kuayuesuyun", initials: "kysy", keywords: ["跨越"] },
  { code: "yimidida", name: "壹米滴答", pinyin: "yimidida", initials: "ymdd", keywords: ["壹米滴答"] },
  { code: "lianhaowuliu", name: "联昊通", pinyin: "lianhaotong", initials: "lht", keywords: ["联昊通"] },
  { code: "xinfengwuliu", name: "信丰物流", pinyin: "xinfengwuliu", initials: "xfwl", keywords: ["信丰"] },
  { code: "yuanchengwuliu", name: "远成物流", pinyin: "yuanchengwuliu", initials: "ycwl", keywords: ["远成"] },
  { code: "tiandihuayu", name: "天地华宇", pinyin: "tiandihuayu", initials: "tdhy", keywords: ["华宇", "天地华宇"] },
];

/**
 * 判断快递公司是否匹配搜索关键词（中文/拼音/首字母/编码）。
 */
function matchExpressCompany(option: ExpressCompanyOption, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  if (option.name.toLowerCase().includes(normalized)) return true;
  if (option.code.toLowerCase().includes(normalized)) return true;
  if (option.pinyin.toLowerCase().includes(normalized)) return true;
  if (option.initials.toLowerCase().includes(normalized)) return true;
  return option.keywords.some((keyword) => keyword.toLowerCase().includes(normalized));
}

/**
 * 客户端免登录轨迹查询页面（跳转快递100）。
 */
export default function ClientTrackPage() {
  const [trackingNo, setTrackingNo] = useState("");
  const [companySearch, setCompanySearch] = useState("");
  const [companyCodePreset, setCompanyCodePreset] = useState("");
  const [companyCode, setCompanyCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [infoMessage, setInfoMessage] = useState("");
  const filteredCompanyOptions = useMemo(
    () => EXPRESS_COMPANY_OPTIONS.filter((item) => matchExpressCompany(item, companySearch)),
    [companySearch],
  );

  // 2026-08-11 改名：这一页查的是**国内快递**（跳转快递100），不是湘泰自己的运单轨迹。
  // 原来叫「物流追踪看板 / Track & Trace（免登录查询）」，客户以为能查自己的湘泰运单，
  // 点进来发现是查顺丰中通的，容易懵。按实际功能直说，顺带去掉英文（全中文红线）。
  return (
    <>
      <section style={{ border: "1px solid var(--l-soft)", borderRadius: 12, padding: 16, background: "var(--white)" }}>
        <h2 style={{ marginTop: 0 }}>查国内快递</h2>
        <p style={{ color: "var(--t-strong)", marginTop: 0 }}>
          查顺丰、中通这类<strong>国内快递</strong>的走件情况。点按钮会<strong>跳到快递100</strong>；
          先填单号和快递公司的话，跳过去会自动带上。
          <br />
          <span style={{ color: "var(--t-muted)", fontSize: 13 }}>
            要查自己的湘泰运单，请用左边的「运单查询」。
          </span>
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 8 }}>
          <input
            value={trackingNo}
            onChange={(e) => setTrackingNo(e.target.value)}
            placeholder="运单号 / 快递单号（可选）"
            style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }}
          />
          <input
            value={companySearch}
            onChange={(e) => setCompanySearch(e.target.value)}
            placeholder="搜索快递公司（中文/拼音/首字母/编码）"
            style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }}
          />
          <select
            value={companyCodePreset}
            onChange={(e) => setCompanyCodePreset(e.target.value)}
            style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }}
          >
            <option value="">快递公司编码（请选择）</option>
            {filteredCompanyOptions.map((item) => (
              <option key={item.code} value={item.code}>
                {item.name}（{item.code}）
              </option>
            ))}
          </select>
          <input
            value={companyCode}
            onChange={(e) => setCompanyCode(e.target.value)}
            placeholder="或手动输入公司编码（例如 shunfeng）"
            style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }}
          />
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              setLoading(true);
              setInfoMessage("");
              const tracking = trackingNo.trim();
              const company = (companyCodePreset || companyCode).trim();
              try {
                openKuaidi100Track(tracking, company);
                setInfoMessage(
                  tracking
                    ? "已在新标签页打开快递100，请在新页面查看物流信息。"
                    : "已在新标签页打开快递100官网，可在页面内输入单号查询。",
                );
              } finally {
                setLoading(false);
              }
            }}
            style={{ border: "none", borderRadius: 8, padding: "8px 12px", background: "var(--c-blue)", color: "var(--white)" }}
          >
            {loading ? "处理中..." : "跳转快递100查单"}
          </button>
        </div>

        {infoMessage ? (
          <p style={{ marginTop: 14, color: "#15803D", fontSize: 13 }}>
            {infoMessage}
          </p>
        ) : null}
      </section>
    </>
  );
}
