/**
 * 批量创建测试运单（员工端 API）
 * 用法: npx tsx scripts/batch-create-test-orders.ts
 * 
 * 会创建 10 条测试运单，品名带 [测试] 前缀，方便后续批量删除
 */
const API = "http://127.0.0.1:3001";

async function main() {
  // 1. 员工登录
  const loginRes = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account: "u_staff_001", password: "123456" }),
  });
  const loginData = (await loginRes.json()) as { data: { token: string } };
  const token = loginData.data.token;
  console.log("✅ 员工登录成功");

  // 2. 批量创建
  const testOrders = [
    { clientId: "u_client_001", warehouseId: "wh_yiwu_01", itemName: "[测试] 手机壳", packageCount: 10, packageUnit: "box", weightKg: 50, volumeM3: 0.5, arrivedAt: "2026-06-05", transportMode: "sea" },
    { clientId: "u_client_001", warehouseId: "wh_yiwu_01", itemName: "[测试] 数据线", packageCount: 20, packageUnit: "box", weightKg: 30, volumeM3: 0.3, arrivedAt: "2026-06-05", transportMode: "land" },
    { clientId: "u_client_001", warehouseId: "wh_guangzhou_01", itemName: "[测试] 蓝牙耳机", packageCount: 15, packageUnit: "box", weightKg: 25, volumeM3: 0.4, arrivedAt: "2026-06-05", transportMode: "sea" },
    { clientId: "u_client_001", warehouseId: "wh_guangzhou_01", itemName: "[测试] 充电宝", packageCount: 8, packageUnit: "box", weightKg: 40, volumeM3: 0.6, arrivedAt: "2026-06-06", transportMode: "land" },
    { clientId: "u_client_001", warehouseId: "wh_dongguan_01", itemName: "[测试] 保护膜", packageCount: 50, packageUnit: "bag", weightKg: 10, volumeM3: 0.2, arrivedAt: "2026-06-06", transportMode: "sea" },
    { clientId: "u_client_001", warehouseId: "wh_yiwu_01", itemName: "[测试] 手表", packageCount: 6, packageUnit: "box", weightKg: 15, volumeM3: 0.15, arrivedAt: "2026-06-06", transportMode: "land" },
    { clientId: "u_client_001", warehouseId: "wh_guangzhou_01", itemName: "[测试] 化妆品", packageCount: 12, packageUnit: "box", weightKg: 35, volumeM3: 0.45, arrivedAt: "2026-06-07", transportMode: "sea" },
    { clientId: "u_client_001", warehouseId: "wh_dongguan_01", itemName: "[测试] 玩具", packageCount: 30, packageUnit: "bag", weightKg: 60, volumeM3: 1.2, arrivedAt: "2026-06-07", transportMode: "land" },
    { clientId: "u_client_001", warehouseId: "wh_yiwu_01", itemName: "[测试] 服装", packageCount: 25, packageUnit: "bag", weightKg: 80, volumeM3: 1.5, arrivedAt: "2026-06-07", transportMode: "sea" },
    { clientId: "u_client_001", warehouseId: "wh_guangzhou_01", itemName: "[测试] 食品", packageCount: 18, packageUnit: "box", weightKg: 45, volumeM3: 0.8, arrivedAt: "2026-06-08", transportMode: "land" },
  ];

  let success = 0;
  let fail = 0;
  for (const order of testOrders) {
    try {
      const res = await fetch(`${API}/staff/orders`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(order),
      });
      const data = (await res.json()) as { code: string; data?: { orderId: string } };
      if (data.code === "OK") {
        console.log(`  ✅ ${order.itemName} → ${data.data?.orderId}`);
        success++;
      } else {
        console.log(`  ❌ ${order.itemName} → ${(data as any).message}`);
        fail++;
      }
    } catch (e) {
      console.log(`  ❌ ${order.itemName} → ${e}`);
      fail++;
    }
  }
  console.log(`\n完成: ✅ ${success} 成功 / ❌ ${fail} 失败`);
}

main().catch(console.error);
