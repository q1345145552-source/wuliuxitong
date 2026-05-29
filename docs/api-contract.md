# 湘泰国际物流 - API 契约

## 1. 基础约定
- Base URL: /api/v1
- Auth: Authorization: Bearer <token>
- Content-Type: application/json
- 时间格式：ISO 8601（例如 2026-02-18T08:00:00.000Z）

## 2. 统一成功响应格式
{
  "code": "OK",
  "message": "success",
  "data": {},
  "requestId": "req_xxx",
  "timestamp": "2026-02-18T08:00:00.000Z"
}

## 3. 统一失败响应格式
{
  "code": "FORBIDDEN",
  "message": "no permission",
  "errors": [
    {
      "field": "status",
      "reason": "invalid transition"
    }
  ],
  "requestId": "req_xxx",
  "timestamp": "2026-02-18T08:00:00.000Z"
}

## 4. 分页规范
请求参数：
- page: number（从 1 开始）
- pageSize: number（建议 1-100）
- sortBy?: string
- sortOrder?: "asc" | "desc"

分页返回 data 示例：
{
  "items": [],
  "page": 1,
  "pageSize": 20,
  "total": 100
}

## 5. 最小接口（先做这 4 个）

### 5.1 POST /auth/login
请求：
{
  "account": "demo",
  "password": "123456"
}

响应 data：
{
  "token": "jwt_token",
  "user": {
    "id": "u_001",
    "name": "Tom",
    "role": "staff"
  },
  "permissions": ["shipment.read", "shipment.updateStatus"]
}

### 5.2 GET /shipments
用途：运单列表（支持分页与筛选）

### 5.3 GET /shipments/:id
用途：运单详情

### 5.4 PATCH /shipments/:id/status
请求：
{
  "fromStatus": "inTransit",
  "toStatus": "customsTH",
  "remark": "arrived thailand customs"
}

规则：
- 必须校验状态流转是否合法
- 必须记录操作日志（谁在什么时间改了什么状态）

## 6. 错误码约定
- OK
- BAD_REQUEST
- UNAUTHORIZED
- FORBIDDEN
- NOT_FOUND
- VALIDATION_ERROR
- INTERNAL_ERROR

## 7. 一致性要求
1. 三个端都使用本文件定义的接口和字段名。
2. 新增接口先改本文件，再开发代码。
3. 破坏性改动必须升级版本（例如 /api/v2）。

## 8. Client V1 接口补充

### 8.1 POST /client/prealerts
用途：创建物流预报单

请求：
{
  "itemName": "手机壳",
  "packageCount": 2,
  "productQuantity": 200,
  "domesticTrackingNo": "SF12345678",
  "transportMode": "sea",
  "receiverNameTh": "Somchai",
  "receiverPhoneTh": "0812345678",
  "receiverAddressTh": "Bangkok ..."
}

响应 data：
{
  "prealertId": "pa_001",
  "createdAt": "2026-02-18T08:00:00.000Z"
}

### 8.2 GET /client/shipments/search
用途：客户端运单查询（多条件）

查询参数：
- trackingNo?
- domesticTrackingNo?
- itemName?
- dateFrom?
- dateTo?
- transportMode? (sea | land)
- page
- pageSize

### 8.3 GET /client/orders
用途：我的订单列表（未完成/已完成）

查询参数：
- statusGroup? (unfinished | completed)
- itemName?
- dateFrom?
- dateTo?
- transportMode? (sea | land)
- trackingNo?
- domesticTrackingNo?
- page
- pageSize

返回补充字段：
- paymentStatus: "unpaid" | "paid" （付款状态，由员工确认）
- paidAt?: string （确认付款时间）
- paidBy?: string （确认付款的员工ID）

## 9. Staff V1 接口补充（状态操作与仓库范围）

### 9.1 GET /staff/shipments
用途：员工运单查询（可跨仓只读）

查询参数：
- trackingNo?
- domesticTrackingNo?
- itemName?
- dateFrom?
- dateTo?
- transportMode? (sea | land)
- warehouseId?
- page
- pageSize

返回补充字段：
- canEdit: boolean （当前员工是否有该单修改权限）

### 9.2 PATCH /staff/shipments/:id/status
用途：员工修改运单状态（仅授权仓库可改）

请求：
{
  "fromStatus": "inTransit",
  "toStatus": "customsTH",
  "remark": "arrived thailand customs"
}

后端校验：
1. 状态流转是否合法（必须遵循状态机）
2. 订单/运单是否属于员工授权仓库

成功响应 data：
{
  "shipmentId": "s_001",
  "fromStatus": "inTransit",
  "toStatus": "customsTH",
  "auditLogId": "al_001",
  "changedAt": "2026-02-18T08:00:00.000Z"
}

失败示例：
- 越权修改：FORBIDDEN
- 非法流转：VALIDATION_ERROR

## 10. Staff V1 接口补充（订单创建与物流信息补录）

### 10.1 POST /staff/orders
用途：员工创建订单

请求：
{
  "itemName": "手机壳",
  "packageCount": 2,
  "packageUnit": "box",
  "productQuantity": 200,
  "transportMode": "sea",
  "receiverNameTh": "Somchai",
  "receiverPhoneTh": "0812345678",
  "receiverAddressTh": "Bangkok ..."
}

响应 data：
{
  "orderId": "o_001",
  "createdBy": "staff_001",
  "createdAt": "2026-02-18T08:00:00.000Z"
}

### 10.2 PATCH /staff/orders/:id/logistics-info
用途：员工补录或更新物流关键字段

请求：
{
  "trackingNo": "THCN0001",
  "domesticTrackingNo": "SF12345678",
  "weightKg": 120.5,
  "volumeM3": 1.28,
  "packageCount": 12,
  "packageUnit": "bag"
}

权限：
- staff/admin: allow
- client: deny（返回 FORBIDDEN）

响应 data：
{
  "orderId": "o_001",
  "trackingNo": "THCN0001",
  "domesticTrackingNo": "SF12345678",
  "updatedAt": "2026-02-18T08:00:00.000Z"
}

### 10.4 POST /staff/orders/set-receivable
用途：员工/管理员为已审核订单补录或修正"最终应收金额"

请求：
{
  "orderId": "o_1771783226942",
  "receivableAmountCny": 1234.56,
  "receivableCurrency": "CNY"
}

### 10.5 POST /staff/orders/set-payment
用途：员工/管理员确认订单账单付款状态（客户端据此展示"待付款/已付款"）

请求：
{
  "orderId": "o_1771783226942",
  "paymentStatus": "paid",
  "proofFileName": "流水单.png",
  "proofMime": "image/png",
  "proofBase64": "<base64-contents>"
}

### 10.3 GET /client/orders 与 GET /client/shipments/search 返回字段补充
客户端返回中需包含：
- trackingNo
- domesticTrackingNo
- weightKg
- volumeM3
- packageCount
- packageUnit
- receivableAmountCny （最终应收金额，员工审核时录入/确认）
- receivableCurrency （币种，默认 CNY）

## 11. Admin V1 接口补充

### 11.1 GET /admin/dashboard/overview
用途：管理员运营看板总览

响应 data：
{
  "staffAccountCount": 25,
  "clientAccountCount": 680,
  "newOrderCountToday": 120,
  "inTransitOrderCount": 430,
  "receivedVolumeM3Today": 98.6
}

### 11.2 GET /admin/users
用途：获取员工/客户账号列表

查询参数：
- role? (staff | client)
- keyword?
- page
- pageSize

### 11.3 POST /admin/staff-users
用途：创建员工账号

请求：
{
  "name": "Alice",
  "phone": "13800000000",
  "warehouseIds": ["wh_bkk_01"]
}

### 11.4 PATCH /admin/staff-users/:id/warehouses
用途：更新员工仓库授权

请求：
{
  "warehouseIds": ["wh_bkk_01", "wh_bkk_02"]
}

### 11.5 PATCH /admin/dictionaries/status
用途：维护状态字典（新增/启停/排序）

### 11.6 PATCH /admin/system/transport-modes
用途：维护运输方式（sea / land 等）

### 11.7 PATCH /admin/shipments/:id/status
用途：管理员修改运单状态（需审计）

请求：
{
  "fromStatus": "customsTH",
  "toStatus": "outForDelivery",
  "remark": "manual correction by admin"
}

### 11.8 GET /admin/audit-logs
用途：查询管理员操作日志

查询参数：
- operatorId?
- operationType?
- targetType?
- dateFrom?
- dateTo?
- page
- pageSize

## 12. Client V1 AI 接口补充（DeepSeek）

### 12.1 POST /client/ai/chat
用途：客户 AI 对话（订单进度 / 发货汇总）

请求：
{
  "message": "我的单号 THCN0001 到哪了？",
  "sessionId": "sess_001"
}

后端流程：
1. 鉴权并识别公司ID
2. 按公司范围读取业务数据
3. 组装结构化上下文并调用 DeepSeek
4. 返回答案与证据摘要
5. 写入 AI 查询审计日志

响应 data：
{
  "sessionId": "sess_001",
  "answer": "单号 THCN0001 当前状态为 inTransit，最近节点为 Bangkok Hub。",
  "evidence": {
    "shipmentIds": ["s_001"],
    "orderIds": ["o_001"],
    "updatedAt": "2026-02-18T08:00:00.000Z"
  }
}

### 12.2 GET /client/ai/suggestions
用途：返回常用提问模板

响应 data：
{
  "suggestions": [
    "我的单号 THCN0001 到哪了？",
    "我这个月一共发了多少货？",
    "最近7天在途订单有多少？"
  ]
}

### 12.3 AI 安全约束
- DeepSeek API Key 仅保存在后端。
- 同公司范围内可查询，跨公司必须返回 FORBIDDEN。
- AI 响应必须包含 `evidence.updatedAt`，确保结果可核对。

## 13. 万能查快递接口补充（快递100代理）

### 13.1 GET /client/express/universal
用途：客户端/员工/管理员通过后端代理查询第三方快递轨迹（万能查快递）。

查询参数：
- trackingNo（必填）
- companyCode?（可选，快递公司编码，例如 shunfeng）

响应 data：
{
  "trackingNo": "SF1234567890",
  "companyCode": "shunfeng",
  "statusCode": "3",
  "statusText": "已签收",
  "events": [
    {
      "time": "2026-03-27 13:28:02",
      "content": "【深圳市】快件已签收，签收人：本人"
    }
  ]
}

后端配置：
- KUAIDI100_CUSTOMER（必填）
- KUAIDI100_KEY（必填）
- KUAIDI100_QUERY_URL（可选，默认 `https://poll.kuaidi100.com/poll/query.do`）

## 14. 汇率实时同步规则（CNY/THB）

- 钱包接口 `GET /client/wallet/overview` 返回 `exchangeRate` 时，会优先读取当日汇率缓存。
- 若距离上次汇率更新时间超过 2 小时，后端会调用外部行情接口拉取 `CNY -> THB` 并写入 `client_exchange_rates`。
- 服务启动后会自动执行一次汇率刷新，并每 2 小时执行一次定时刷新。

后端配置：
- `EXCHANGE_RATE_API_URL`（可选，默认 `https://open.er-api.com/v6/latest/CNY`）