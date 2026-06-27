c = open('apps/web/src/app/client/page.tsx').read()

# Find the card section: from '<div style={{ display: "grid", gap: 8 }}>' to the matching ')}' that closes .map and ternary
# The section starts with the grid div and ends with the </div> + )}

old_pattern = '<div style={{ display: "grid", gap: 8 }}>'
idx = c.index(old_pattern)
print(f'Grid div at {idx}')

# From here, find the matching closing
# Count <div> - </div> pairs
span_start = idx
tag_depth = 1
i = span_start + len(old_pattern)
while tag_depth > 0 and i < len(c):
    # Look for next <div or </div>
    next_open = c.find('<div', i)
    next_close = c.find('</div>', i)
    
    if next_open >= 0 and (next_close < 0 or next_open < next_close):
        tag_depth += 1
        i = next_open + 4
    elif next_close >= 0:
        tag_depth -= 1
        i = next_close + 6
    else:
        break

div_end = i  # position after </div>
print(f'Grid div ends at {div_end}')

# After the grid closing </div>, there should be ")}" closing the .map and ternary
# Find )}
after = c.find(')}', div_end)
if after >= 0:
    section_end = after + 2
    print(f'Section ends at {section_end}')
    
    table = '''<div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left", background: "#f8fafc" }}>
              <th style={{ padding: "6px 8px", fontWeight: 600 }}>唛头</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>预报单号</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>品名</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>件</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>运输</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>状态</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>操作</th>
            </tr></thead>
            <tbody>
              {(pageData.length === 0 ? dataItems : pageData).map((item) => {
                const isShipped = item.approvalStatus === "shipped";
                const isReceived = item.approvalStatus === "received";
                const sLabel = isReceived ? "已收货" : "已发货";
                const sColor = isReceived ? "#16a34a" : "#0369a1";
                const sBg = isReceived ? "#dcfce7" : "#e0f2fe";
                return (<tr key={item.id} style={{ borderBottom: "1px solid #e5e7eb" }}>''' + """
                  <td style={{ padding: "6px 8px", fontFamily: "monospace", color: "#6b21a8", fontSize: 12 }}>{item.clientId || "—"}</td>
                  <td style={{ padding: "6px 8px", fontFamily: "monospace", fontSize: 11 }}>{item.orderNo || item.id}<br /><span style={{ fontSize: 10, color: "#6b7280" }}>{item.trackingNo || ""}</span></td>
                  <td style={{ padding: "6px 8px" }}>{item.itemName}</td>
                  <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{item.packageCount} {item.packageUnit === "box" ? "箱" : "袋"}</td>
                  <td style={{ padding: "6px 8px" }}>{item.transportMode === "sea" ? "🚢海运" : "🚚陆运"}</td>
                  <td style={{ padding: "6px 8px" }}><span style={{ fontSize: 11, fontWeight: 500, color: sColor, background: sBg, padding: "2px 6px", borderRadius: 4 }}>{sLabel}</span></td>
                  <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
                    <button onClick={() => openShipmentTrack(item.trackingNo || item.id)} style={{ border: "1px solid #2563eb", borderRadius: 4, padding: "2px 8px", fontSize: 11, background: "#eff6ff", color: "#2563eb", cursor: "pointer" }}>物流轨迹</button>
                  </td>
                </tr>);
              })}
            </tbody>
          </table>
        </div>
''' + '''

'''
    
    c = c[:idx] + table + c[section_end:]
    open('apps/web/src/app/client/page.tsx', 'w').write(c)
    print('Replaced section')
else:
    print('Could not find )} after grid')
