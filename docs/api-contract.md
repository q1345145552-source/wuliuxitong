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
  "clientId": "CLIENT_MARK",
  "trackingNo": "YW0000001",
  "warehouseId": "wh_yiwu_01",
  "arrivedAt": "2026-08-27",
  "itemName": "手机壳",
  "packageCount": 2,
  "packageUnit": "box",
  "productQuantity": 200,
  "transportMode": "sea",
  "products": [
    {
      "itemName": "手机壳-A款",
      "packageCount": 1,
      "lengthCm": 60,
      "widthCm": 40,
      "heightCm": 30,
      "productQuantity": 100,
      "weightKg": 12
    },
    {
      "itemName": "手机壳-B款",
      "packageCount": 1,
      "lengthCm": 50,
      "widthCm": 35,
      "heightCm": 25,
      "productQuantity": 100,
      "weightKg": 10
    }
  ]
}

`products[]` 中的 `weightKg` 是单箱重量。传入产品明细时，后端以明细为事实源重新汇总
`packageCount`、`productQuantity`、`weightKg` 和 `volumeM3`；批量导入会先按 `trackingNo`
把 Excel 多行合并成一次请求。

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

限制（2026-08-28 新增，按**账号**计数，不按 IP）：

| 限制 | 默认值 | 超了返回 | 可用环境变量改 |
|---|---|---|---|
| 每分钟条数 | 10 | `429` + `code: BAD_REQUEST` | `AI_CHAT_MAX_PER_MINUTE` |
| 每天条数 | 200 | `429` + `code: BAD_REQUEST` | `AI_CHAT_MAX_PER_DAY` |
| `message` 长度 | 500 字 | `400` + `code: BAD_REQUEST` | `AI_CHAT_MAX_MESSAGE_CHARS` |
| `sessionId` 长度 | 100 字 | `400` + `code: BAD_REQUEST` | 无（写死） |

- 日上限按**北京日历日**分桶，到北京 0 点换新桶。
- ⚠️ 计数存在 API 进程内存里，**重启就清零**；多进程部署时各算各的。
- 环境变量填了非正整数会被忽略、退回默认值，并在日志里留一条 WARN。
- 前端输入框也写死了 `maxLength=500`（`AiChatWidget.tsx`），改上限要两边一起改。
- ⚠️ 前端 `apiRequest` 遇到 429 会自动重试 2 次（`core-api.ts`），重试也会计数，
  但不会再往后走、不花钱，窗口也不会被延长。

后端流程：
1. 鉴权并识别公司ID
2. 四道闸：每分钟 → 每天 → message 长度 → sessionId 长度
3. 按公司范围读取业务数据
4. 组装结构化上下文并调用 DeepSeek（一条消息固定两次：猜意图 + 润色答复）
5. **校验模型有没有改数字**，改了就丢弃润色稿、发原始草稿
6. 返回答案与证据摘要
7. 写入 AI 查询审计日志（存的是校验后、真正发出去的那一句）

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

## 15. 尾端派送导出数据接口

> 两个接口都返回第 2 节定义的 JSON 成功包装，由 Web 端把 `data` 填入已确认的 XLSX 模板；接口本身不直接返回 Excel 文件。

### 15.1 GET /staff/loading-manifests/export-data

用途：从「装柜管理」按整个柜子取尾端拆柜仓清单数据。不生成 WD，也不依赖司机或车辆。

权限：
- Bearer 鉴权必填。
- `staff` 和 `admin` 可访问；`client` 禁止访问。
- 只能读取当前登录用户 `companyId` 下的柜子；柜子不存在或跨公司均返回 `NOT_FOUND`。

查询参数：
- `id`（必填）：装柜管理中的 `Container.id`，不是柜号文本。

返回要点：
- `scope` 固定为 `"container"`，包含 `containerId`、`containerNo`、`containerType` 和客户/运单明细。
- 每条实际装柜记录对应一条运单明细；件数与方数使用该柜实际装入值。
- 数据用于内部拆柜仓模板，因此允许包含柜号。
- ⚠️ **`weightKg` 可能为 `null`**（这票货和它所属订单都没填重量）。
  **消费方必须判空，不要当成 0** —— 导出的是给客户签字的单据，印「0 kg」等于说这箱货没有重量。
- `volumeM3` **始终是数字**：它取自 `shipment_container_items.loaded_volume_m3`，
  该列在数据库里是非空的（schema + 初始迁移 + 实际数据均已确认）。

错误：
- 缺少 `id`：`BAD_REQUEST`。
- 空柜：`VALIDATION_ERROR`。
- 柜子不存在或不属于当前公司：`NOT_FOUND`。

### 15.2 GET /admin/lastmile/customer-export-data

用途：WD 派送单创建后，只取其中一个客户的派送/签收单数据。一张 WD 可包含多客户、多地址和多运单。

权限：
- Bearer 鉴权必填。
- 尽管路径位于 `/admin`，`staff` 和 `admin` 都可访问；`client` 禁止访问。
- 先按当前用户 `companyId + deliveryNo` 限定 WD，再用 `clientId` 精确限定客户。

查询参数：
- `deliveryNo`（必填）：WD 开头的派送单号。
- `clientId`（必填）：该 WD 中要导出的客户唛头，必须精确匹配。

返回与隐私契约：
- `scope` 固定为 `"customer"`，`customerCount` 固定为 `1`，`customers` 只能包含所选 `clientId`。
- 不得查询或返回实际柜号。为兼容共用数据结构，`containerId`、`containerNo`、`containerType` 必须为空字符串，顶层和运单明细内的 `containerNos` 必须为空数组。
- 不得返回同一 WD 中其它客户的姓名、电话、地址或运单。
- ⚠️ **`weightKg` 和 `volumeM3` 都可能为 `null`**（这票货和它所属订单都没填）。
  **消费方必须判空，不要 `?? 0`。**
  2026-08-26 修过一次：接口原来写 `weightKg ?? 0`，把「没填」抹成了 0，
  客户签收单上就印成「0 m³ / 0 kg」。生成器本来就会把 `null` 写成空格子，
  问题一直卡在接口这一层。

错误：
- 缺少 `deliveryNo` 或 `clientId`：`BAD_REQUEST`。
- WD 不存在或不属于当前公司：`NOT_FOUND`。
- 所选客户不在该 WD 内：`NOT_FOUND`。

## 16. 整柜询价接口补充（2026-09-01 Codex 复核收尾补记）

> 2026-08-31 Codex 二轮把询价列表改成了真分页 + 大字段按需取，这里把契约补齐。

### 16.1 GET /client/fcl-inquiries（列表）

用途：整柜询价列表。表格只需要小字段，所以**列表不再返回 `certFileBase64` 和 `productImages`**（原来整包下发，纯浪费流量）；要看大字段走 16.2 的详情接口。

权限：
- Bearer 鉴权必填；`client` / `staff` / `admin` 均可访问。
- `client` 只能看到自己的询价（`clientId` = 本人）；`staff` / `admin` 看本公司全部。

查询参数（分页，2026-09-01 起严格校验）：
- `page?`（默认 1）：必须是正的安全整数，否则 `BAD_REQUEST`「页码不合法」。
  ⚠️ 不再是「非法就当 1」——原来 `page=1e400` 会算出 Infinity 的 skip，Prisma 直接 500。
- `pageSize?`（默认 50，上限 200）：必须是正的安全整数，否则 `BAD_REQUEST`「每页条数不合法」；超过 200 按 200 处理。

响应 data（第 4 节分页包装）：
{
  "items": [
    {
      "id": "...", "clientId": "...", "productName": "...",
      "cargoValue": "...", "cargoWeight": "...", "address": "...",
      "containerType": "1*40HQ", "serviceType": "清提派",
      "loadingDate": "...", "certFileName": "...",
      "status": "pending", "remark": "...",
      "createdByRole": "client", "createdAt": "ISO 8601"
    }
  ],
  "page": 1, "pageSize": 50, "total": 123
}

字段说明：
- `remark` 是管理员内部备注（可能写着利润）：**`client` 角色一律不返回该字段**，只有 staff/admin 能看到。
- `certFileBase64`、`productImages`：列表**不返回**（连库都不读），只在 16.2 详情里给。

### 16.2 GET /client/fcl-inquiries/detail（详情，2026-08-31 新增）

用途：按 id 取单条询价详情，认证文件 Base64 和产品图片这两个大字段只在这里下发。

权限：
- Bearer 鉴权必填；`client` / `staff` / `admin` 均可访问。
- `client` 只能看自己的那条（查询自带 `clientId` = 本人过滤）；跨公司一律查不到。

查询参数：
- `id`（必填）：询价单 id。缺少时 `BAD_REQUEST`「缺少询价单 id」。

响应 data：列表字段全集，另加
- `certFileBase64`：认证文件内容（可能为 null）。
- `productImages`：**一定是数组**（2026-09-01 终验收尾在接口出口做了规整）。
  存库是任意 JSON 字符串（创建接口不校验形状），正常前端写入的是
  `[{ "fileName": "...", "base64": "..." }]` 数组；历史数据/直连 API 可能存着 JSON 对象，
  出口规则：数组原样给；单个对象包成单元素数组；标量、解析失败、空值一律给 `[]`。
  消费方可以放心 `.map()`，不用再判断类型。
- `remark`：同列表——**`client` 角色不返回**。

错误：
- 缺少 `id`：`BAD_REQUEST`。
- 记录不存在 / 不属于本公司 / 客户看别人的：一律 `NOT_FOUND`「询价记录不存在」。

## 17. 集货余额流水接口补充（2026-09-01 终验收尾补记）

### 17.1 GET /client/wallet/ledger（流水列表）

用途：客户端集货余额流水对账。充值到账、集货付款、管理员撤销退款，每一笔都在这里。

权限：
- Bearer 鉴权必填；仅 `client` 可访问，只能看自己的流水（`companyId` + `clientId` = 本人）。

查询参数（分页，2026-09-01 起严格校验，规则与 16.1 整柜询价列表相同）：
- `page?`（默认 1）：必须是正的安全整数，否则 `BAD_REQUEST`「页码不合法」。
  ⚠️ 不再是「非法就夹紧到 1」——与 16.1 同一套严格校验（没传/空串才用默认值）。
- `pageSize?`（默认 50，上限 500）：必须是正的安全整数，否则 `BAD_REQUEST`「每页条数不合法」；超过 500 按 500 处理。
  ⚠️ 上限是 500，不是 16.1 的 200——流水是对账场景，单页允许多拿一些。

排序规则：
- 固定按 `createdAt` 倒序（最新一笔在最前）；`createdAt` 相同再按 `id` 倒序兜底
  （同一秒多笔不会跨页重复/漏行）。不支持 `sortBy` / `sortOrder`。

响应 data（第 4 节分页包装）：
{
  "items": [
    {
      "id": "...",
      "type": "recharge",
      "typeLabel": "充值到账",
      "amount": 100.5,
      "balanceAfter": 1200.5,
      "source": "充值单",
      "refNo": "...",
      "remark": "",
      "createdAt": "ISO 8601"
    }
  ],
  "page": 1, "pageSize": 50, "total": 321
}

字段说明：
- `type` / `typeLabel`：`recharge`=充值到账、`pay`=集货付款、`refund`=撤销退款；
  未知类型 `typeLabel` 原样回显 `type`。
- `amount`：数字，**正数进账、负数出账**。
- `balanceAfter`：该笔发生后的余额快照，数字。
- `source`：关联单据类型的中文名（`whr`=仓库版集货、`normal`=普通版集货、`recharge`=充值单）；
  无关联时为空字符串。
- `refNo` / `remark`：无值时为空字符串（不是 null）。
- `total`：过滤后的**真实总数**（2026-09-01 起，不再是「本次返回了几条」），前端按它翻页。

## 18. 轨迹删除与货型校验补充（2026-09-12）

### 18.1 GET /client/shipments/track

- 调用方明确传 `trackingNo` 或 `shipmentId`；单号再长也不应按长度猜成内部 ID。两者都传时，现有后端优先 `shipmentId`。
- `timeline[]` 及 `children[].timeline[]` 增加 `canDelete: boolean`。员工/管理员的普通轨迹为 `true`；客户、派送业务自动生成的轨迹、显示当前状态的最后一条为 `false`。
- （2026-09-17）员工/管理员的每条轨迹再带 `isCurrentStatus: boolean`：该条 `toStatus` 等于**它所属运单**的当前状态，且那票运单只剩这一条是这个状态时为 `true`（父单页签里的子单记录按子单自己的状态算）。客户不下发此字段。
- 客户的日志 `id`、操作人继续隐藏。既有品名、件数、状态和父子单合并逻辑不变。

### 18.2 POST /staff/shipments/track/delete-log

- 仅员工/管理员，请求 `{ logId: string }`，仍按本公司校验。
- 派送业务生成的轨迹（创建、改派、签收、撤销签收、删除派送单）返回 HTTP `409` / `VALIDATION_ERROR`，请从尾端派送处理业务，不单独回退日志。
- 运单加锁后重读日志；已被处理则 HTTP `404`，不继续写入。
- ~~普通轨迹保留原删除/回退能力~~ → **2026-09-17 起只删记录，不改任何运单 / 父单的状态**（原来按剩下的最后一条重算，记录时间是补的，9-15 把 12 张父单改成了「已创建」）。
- 显示当前状态的最后一条（同 18.1 `isCurrentStatus`，锁内重读状态和条数判断）返回 HTTP `409` / `VALIDATION_ERROR`，提示到「装柜管理」撤销；同一状态还有别的记录时可以删。
- 成功返回 `{ deleted: true, trackingNo, currentStatus }`，`currentStatus` 是没变的当前状态（原来的 `hasLogsLeft` 去掉，前端没用过）。
- 不按用户备注里是否出现“派送”二字判定来源。
- 本次不清理历史记录，也不修改签收图片或件数、体积、重量。

### 18.5 推进账本（2026-09-17 老板定，替代 18.2 / 18.4 的做法）

- **新表**（迁移 `20260917_container_push_ledger`，只增不删）：`container_push_batches`（每推一次柜子状态一笔：seq、柜子推之前/推之后的状态、推之前的 statusDates / 开船日期 / 到港日期）、`container_push_entries`（这一笔里每票货推之前/推之后的状态、这一步写的轨迹 id，kind=`push` / `late_add`）。
- **POST /admin/containers/status**：记一笔账。退回/取消的货、比这一步靠后的预约派送/派送中/已签收的货跳过不挡整柜（派送三步单独排先后：这一步不是派送三步就一律跳过，陆运也一样），列在 `skippedShipments: [{ trackingNo, status }]`；推进被挡的提示给运单号。
- **POST /staff/loading-manifests/transport-mode**：选的跟现在一样直接返回、不做任何事。除了当前状态，柜子**走过的**步骤里有目标运输方式没有的也不许改（提示先撤销回这些步骤之前）。没标运输方式的柜子标成海运直接放行（本来就按海运走）。走过的步骤只看柜子自己身上的：时间表的键、推进账本每一笔的前后状态、开船日期（=运输中）/ 到港日期（=已到港，两个日期只在柜子现在已经走到那一步或更后面时才算）；「目标流程没有的」按两条真流程算。**不看**柜里货的推进记录（`sl_ctn_` 上没记是哪个柜推的），老柜子只剩这种证据时放行，由整柜撤销那一刻核对。柜里的货**现在**停在另一种运输方式才有的状态上（比如撤销后退回「已到港」）也不许改；例外是上面那条「没标运输方式 → 标成海运」，它不换流程，整段检查都跳过。
- **POST /staff/loading-manifests/add-shipment**：柜子已经推过（不在装柜中）且有账本时，先单独写一条「装入柜子 柜号」（loaded→loaded），每一步都写「随柜补记」；并记进每一笔账（`late_add`，起点按第一笔之前柜子的状态），撤销时这票货也跟着退、补记一起删，「装入柜子」不删。没有账本的老柜子照上线前的写法（最后一步那条当「装入柜子」）。
- **GET /admin/containers/status/undo-preview?id=**（员工/管理员）：`{ mode: "ledger"|"legacy", currentStatus, prevStatus, revertCount, keep: [{ trackingNo, reason }] }`，跟真撤销同一份判断，只读。
- **POST /admin/containers/status/undo** `{ id, expectStatus? }`：
  - `expectStatus` 跟柜子现在的状态对不上 → `409`（页面没刷新连点两下不会多撤一步）。
  - 柜子要退到的状态、柜里要跟着退的货要退回的状态，有一个是柜子**现在的运输方式**流程里没有、另一种运输方式才有的 → `409`，提示先把运输方式改回去，什么都不动（有账本 / 没账本两条路都核；撤销预览同样 `409`）。柜子现在的状态本身不在自己流程里的乱数据照原来不拦。
  - 有账本：撤最近一笔。柜子恢复成那笔记的「推之前」；还在柜里、还停在这一步的货回到记的状态，只删这些货这一步的轨迹；不在柜里 / 已经走到别的状态的不动、轨迹不删，列在 `skippedShipments: [{ trackingNo, reason }]`。账本最后一笔跟柜子状态对不上（锁内确认）→ `409` 请联系技术；被别人抢先 → 「刚刚被别人改过，请刷新」。柜里这批货的父单都重算。写 `audit_logs`（action=UNDO，`beforeJson.undoneLogIds` = 这一步撤掉的全部记录 id，含员工之前删掉的）。
  - 没有账本（上线前推的步骤）：沿用 18.4，但上一步按流程顺序找（时间表里混着另一条流程状态时才按日期）；状态没变的不算进 `affectedShipmentCount`；也写 UNDO 日志（`undoneLogIds` 含这次推进写的、员工之前删掉的同一批记录）。
  - 两条路：货退回的那一步轨迹里一条记录都没有时，从删除存底里把「装入柜子 <本柜号>」（整号匹配）原样放回，写 RESTORE 日志；返回 `restoredLogs`。
- **POST /staff/shipments/track/delete-log**：在 18.2 基础上，柜子推进（`sl_ctn_`）/ 随柜补记（`sl_mnf_`）里改了状态的记录 → `409`（提示去装柜管理撤销）；删之前把原记录整条写进 `audit_logs`（action=DELETE、resourceType=StatusLog、remark=`删除物流轨迹 <单号>`）。
- **GET /client/shipments/track**：员工/管理员每条轨迹多 `deleteBlockedReason: "lastmile" | "containerPush" | "currentStatus" | null`，跟删除接口同一份判断（`deleteBlockedReasonOf`）；客户不下发。`partialAhead` 按 `shipment.transportMode ?? order.transportMode`（代理端 `/agent/shipments/track` 同）。
- **GET /admin/shipments/track/deleted-logs?trackingNo=**（仅管理员）：这票货和它子单删过的记录（按运单 id 找存底，改过号也查得到；同一条只列最近一次；全部列出不截断）`{ total, items: [{ auditId, deletedBy, deletedByName, deletedAt, restored, log }] }`。整柜撤销自动放回、老柜子撤销找员工删过的推进记录也按运单 id 找。
- **POST /admin/shipments/track/restore-log** `{ auditId }`（仅管理员，员工 403）：原样放回，不改状态；海运、陆运两条流程里任一条记录的状态排在货现在的状态后面（那一步已经撤了）→ `409`；两条流程都比不出先后且不是同一个状态 → `409`；记录 id 在某次整柜撤销的 `undoneLogIds` 里（状态没变的重复记录，比如「已封柜」）→ `409`；已经恢复过 → `409`；存底读不出来 → `404`。

### 18.4 POST /admin/containers/status/undo（2026-09-17）

- 柜里的运单退回「这次推进之前的状态」，取这次推进写的那条轨迹（`sl_ctn_`，`changedAt` + `toStatus` 匹配）里的 `fromStatus`；同一票有多条匹配取最早写的。
- 只退**锁内重读后仍停在这次推进状态**的运单；之后单独往前走了的、没有这次推进记录的（后装进柜的）不动。原来「按剩下的最后一条轨迹重算」在卸柜重装、补推过去日期的柜子上会把运单退成「已装柜」。
- `affectedShipmentCount` 改为真正退回的运单数。

### 18.3 POST /admin/orders/update

- `cargoType` 与各 `products[].cargoType` 共用建单校验：有效值为 `normal` / `inspection` / `sensitive`，非法值返回 HTTP `400` / `VALIDATION_ERROR`；兼容缺省/空值为普货。
- 提交非空产品列表时，保存后按锁内完整产品集合的最严货型同步整票；旧行省略货型时保留原值，新行省略则普货。
- 已有产品行时，仅修改整票货型若与产品最严值不一致，返回 `400`，提示在产品行修改；不偷偷覆盖明细。
- 不涉及货型的编辑不重新分类历史数据；没有产品行的老单仍可直接修改有效整票货型。

## 19. 返现单「已返 / 撤回已返」与操作流水（2026-09-18 老板拍板）

老板原话：「能撤回，但是能看到记录。应该有流水的」。**不加新表**，流水存在已有的 `audit_logs` 里。

- **POST /admin/agents/rebates/mark-paid** `{ id }`（仅管理员）：不变 —— 只改状态、已返时间、操作人，金额和明细一个字不动；重复点返回 `{ alreadyPaid: true }` 且**不写流水**。现在改成**先锁这行（`FOR UPDATE`）→ 锁后重读 → 真要改才写**，改完在**同一个事务**里记一条流水。
- **POST /admin/agents/rebates/undo-paid** `{ id, reason }`（仅管理员）：撤回「已返」。
  - `reason` 必填，去掉两头空格后 1～200 字，否则 `400`；别家公司的单 `404`。
  - 成功：`status` 回到 `unpaid`，`paidAt` / `paidBy` 清空，**金额、方数、明细不动**（还是「出了单就不改」）。返回 `{ id, status: "unpaid", alreadyUnpaid: false }`。
  - 已经是未返（别人刚撤过）：`{ alreadyUnpaid: true }`，不报错、也不写第二条流水。
  - 代理端 `/agent/rebates`、`/agent/rebates/detail` 跟着显示回「未返」（代理本来就看得到状态）；**流水不给代理**。
- **流水**（`audit_logs`）：`action=STATUS_CHANGE`、`resourceType=AgentRebateStatement`、`resourceId=返现单 id`；`beforeJson` / `afterJson` 记「状态 + 已返时间 + 操作人」，`afterJson` 另带 `month` / `agentId` / `totalRebate`；`remark` 记撤回原因（点「已返」是空串）。动作从 before/after 的状态推出来，不另存字段。
- **GET /admin/agents/rebates/detail?id=** 多返回 `history: [{ at, actorName, actorRole, action: "paid"|"undoPaid"|"other", reason, amount }]`，最近的在最前面，最多 50 条；按 `companyId` 过滤。操作人名字只在这个**只给超管**的接口里给（`operator-visibility.ts` 的规矩）。

## 20. 仓库版集货定价改回「每个柜当场填」＋代理端集货相关分区暂时关闭（2026-09-18 老板拍板）

老板原话：「那个集货拼柜的功能，我搞错了。得修一下，不要去设置价格，之前的逻辑是正确的，每次柜价格都不一样的。所以所有人都不需要设置价格，包括代理。代理的话直接把这个功能的前端页面先屏蔽掉吧……但是后端暂时保留一下，以后可能会用。」

### 20.1 定价：回到 9-16 之前那套

- **POST /admin/whr-consolidation/plans**（建柜，仅超管）：`customers[]` 重新**收三档单价** `unitPriceNormal` / `unitPriceInspection` / `unitPriceSensitive`，每档必填、`requireUnitPrice`（> 0、最多 2 位小数），缺档或不合法 `400`，整柜不建。**不再读客户长期价**，所以也不再拿「客户价排队锁」；没配过长期价的客户照样能建柜。
- **POST /admin/whr-consolidation/customers/add**（加客户，超管 + 员工）：同样**当场填三档价**，缺档 / 不合法 `400`。照旧锁计划行、锁后重判计划状态和重复客户。
- **POST /admin/whr-consolidation/customers/price**（改单价，仅超管）：**恢复**（9-16 到 9-18 之间是 410）。只改传上来的那几档（留空不改）、一档都没传 `400`；事务里先 `lockPlanAliveById`（已取消的柜不许改），改完这位客户**没付款**的单按新价重算（`recalcUnpaidPrealertFees` + `recalcCustomerTotals`，跟长期价那条路同一份口径），已付款的金额不动。
- **GET /client/whr-consolidation/plans**：不再下发 `hasLongTermPrice`（客户端页顶那句「暂未配对价格，请联系管理员」跟着去掉）；柜里那行的 `myUnitPrice*` 照旧给。
- **保留但前端没有入口**：`client_whr_prices` 表、`long-term-price.ts`、`POST /admin/clients/whr-price`、`GET /admin/whr-consolidation/client-prices`、代理端那套长期价接口。**以后要重新开这个功能时注意**：`setClientWhrPrice` 会连带改「计划中/收货中/装柜中」柜里这位客户的单价并重算没付款的单 —— 现在没人能调它，重开之前要先想清楚跟「每柜当场填」怎么共存。

### 20.2 代理工作台：集货相关分区暂时关闭

- 前端开关 `apps/web/src/modules/agent/agent-features.ts` 的 `AGENT_WHR_FEATURES_ENABLED = false`：菜单和分区里去掉**仓库版集货、客户和价格、集货余额、我的价格**；旧链接（`/agent#whr` 等）回首页；首页那三张集货催单卡片换成一句话，**关着时不发 `/agent/home` 请求**。保留**首页、运单、返现单**。
- **后端一个接口都没删**（`/agent/whr*`、`/agent/wallet*`、`/agent/clients*`、`/agent/me`），改开关就能整套回来。
- 湘泰自己的客户端集货余额、超管/员工的集货拼柜都不受影响。
