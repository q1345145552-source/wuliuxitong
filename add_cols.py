s = open('apps/web/src/app/client/page.tsx').read()

chunk = '''            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead><tr style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left", background: "#f8fafc" }}>
                  <th style={{ padding: "6px 8px", fontWeight: 600 }}>唛头</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>预报单号</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>品名</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>尺寸(cm)</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>体积(m³)</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>重量(kg)</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>件</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>运输</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>状态</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>操作</th>
                </tr></thead>
                <tbody>
                  {prealerts.filter((item) => {
                    const q = prealertSearch.trim().toLowerCase();
                    if (!q) return true;
                    return item.id.toLowerCase().includes(q) || (item.itemName ?? "").toLowerCase().includes(q);
                  }).slice(0, pageSize).map((item) => {
                    const isShipped = item.approvalStatus === "shipped";
                    const isReceived = item.approvalStatus === "received";
                    const sLabel = isReceived ? "已收货" : "已发货";
                    const sColor = isReceived ? "#16a34a" : "#0369a1";
                    const sBg = isReceived ? "#dcfce7" : "#e0f2fe";
                    const dims = (item.products ?? []).map((p: any) => (p.lengthCm && p.widthCm && p.heightCm ? p.lengthCm + "×" + p.widthCm + "×" + p.heightCm : null)).filter(Boolean).join(", ");
                    return (
                      <tr key={item.id} style={{ borderBottom: "1px solid #e5e7eb" }}>
                        <td style={{ padding: "6px 8px", fontFamily: "monospace", color: "#6b21a8", fontSize: 12 }}>{item.clientId || "—"}</td>
                        <td style={{ padding: "6px 8px", fontFamily: "monospace", fontSize: 11 }}>{item.orderNo || item.id}<br /><span style={{ fontSize: 10, color: "#6b7280" }}>{item.trackingNo || ""}</span></td>
                        <td style={{ padding: "6px 8px" }}>{item.itemName}</td>
                        <td style={{ padding: "6px 8px", fontSize: 11, whiteSpace: "nowrap" }}>{dims || "—"}</td>
                        <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{item.volumeM3 != null ? Number(item.volumeM3).toFixed(3) : "—"}</td>
                        <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{item.weightKg != null ? Number(item.weightKg).toFixed(2) : "—"}</td>
                        <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{item.packageCount} {item.packageUnit === "box" ? "箱" : "袋"}</td>
                        <td style={{ padding: "6px 8px" }}>{item.transportMode === "sea" ? "🚢海运" : "🚚陆运"}</td>
                        <td style={{ padding: "6px 8px" }}><span style={{ fontSize: 11, fontWeight: 500, color: sColor, background: sBg, padding: "2px 6px", borderRadius: 4 }}>{sLabel}</span></td>
                        <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
                          <button type="button" onClick={() => openShipmentTrack(item.trackingNo || item.id)} style={{ border: "1px solid #2563eb", borderRadius: 4, padding: "2px 8px", fontSize: 11, background: "#eff6ff", color: "#2563eb", cursor: "pointer" }}>物流轨迹</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
'''

def replace_section(text, start_pattern):
    idx = text.index(start_pattern)
    depth = 1
    i = idx + len(start_pattern)
    while depth > 0 and i < len(text):
        no = text.find('<div', i)
        nc = text.find('</div>', i)
        if no >= 0 and (nc < 0 or no < nc):
            depth += 1
            i = no + 4
        elif nc >= 0:
            depth -= 1
            i = nc + 6
        else:
            break
    after = text.find(')}', i)
    return text[:idx] + chunk + '\n          )}\n' + text[after + 2:]

pattern = '<div style={{ display: "grid", gap: 8 }}>'
s = replace_section(s, pattern)
s = replace_section(s, pattern)

open('apps/web/src/app/client/page.tsx', 'w').write(s)
print('Updated table with dimensions')
