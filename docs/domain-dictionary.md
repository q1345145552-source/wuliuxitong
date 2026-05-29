# 湘泰国际物流 - 业务字典（Domain Dictionary）

## 1. 文档目的
统一管理员端、员工端、客户端的业务语义、字段定义、状态流转，避免同名不同义。

## 2. 角色定义
- admin: 管理员
- staff: 一般员工
- client: 客户端用户

## 3. 核心实体

### 3.1 User
- id: string
- role: "admin" | "staff" | "client"
- name: string
- phone: string
- status: "active" | "inactive"

### 3.2 Order
- id: string
- clientId: string
- pickupAddressCn: string
- deliveryAddressTh: string
- receiverName: string
- receiverPhone: string
- serviceType: "standard" | "express"

### 3.3 Shipment
- id: string
- orderId: string
- trackingNo: string
- currentStatus: ShipmentStatus
- currentLocation?: string
- createdAt: string
- updatedAt: string

## 4. 运单状态（唯一标准）
created -> pickedUp -> inWarehouseCN -> customsPending -> inTransit -> customsTH -> outForDelivery -> delivered

异常分支：
- exception
- returned
- cancelled

## 5. 一致性规则
1. 新增状态必须先改本文件，再改代码。
2. 三个端显示的状态中文名必须一致。
3. 禁止每个端单独维护状态枚举。

## 6. 客户端 V1 - 物流预报单字段
- itemName: 品名（必填）
- packageCount: 箱数/袋数（必填，整数）
- productQuantity: 产品数量（必填，整数）
- domesticTrackingNo: 国内快递单号（必填）
- transportMode: 运输方式（必填）"sea" | "land"
- receiverNameTh: 收件人姓名（泰国，必填）
- receiverPhoneTh: 收件电话（泰国，必填）
- receiverAddressTh: 收件地址（泰国，必填）

## 7. 客户端 V1 - 订单完成规则
- 已完成（completed）：delivered、returned、cancelled
- 未完成（unfinished）：除上述以外的所有状态

## 8. 客户端 V1 - 查询与筛选维度
- trackingNo（运单号）
- domesticTrackingNo（国内快递单号）
- itemName（品名）
- dateFrom / dateTo（日期范围）
- transportMode（运输方式：sea / land）

## 9. 员工端 V1 - 状态操作与仓库范围规则

### 9.1 状态变更规则
- 员工可以执行状态变更，但必须遵循系统状态流转规则。
- 不允许任意状态跳转（例如 created 直接改为 delivered）。
- 非法流转必须被后端拒绝并返回错误码。

### 9.2 查询与修改的数据范围
- 员工可跨仓进行只读查询。
- 员工仅可修改其授权仓库内的订单/运单。
- 若订单不属于员工授权仓库，修改操作必须返回 403。

### 9.3 审计日志（状态变更必留痕）
每次状态变更必须记录以下字段：
- operatorId: string
- operatorName: string
- operatorWarehouseId: string
- fromStatus: ShipmentStatus
- toStatus: ShipmentStatus
- changedAt: string (ISO datetime)
- remark?: string

## 10. 员工端 V1 - 订单创建与物流字段补录规则

### 10.1 员工创建订单
- 员工具有订单创建权限。
- 员工创建后可补录物流关键字段，客户端可见。

### 10.2 字段统一命名（全系统唯一）
- trackingNo: 运单号
- domesticTrackingNo: 国内快递单号（注意：与"国内订单号"为同一字段语义）
- weightKg: 重量（kg）
- volumeM3: 体积（m³）
- packageCount: 袋数/箱数数量
- packageUnit: 计数单位（bag | box）

### 10.3 字段可见与可改规则
- client: 可见但只读
- staff: 可见可改
- admin: 可见可改

### 10.4 一致性要求
- 禁止再新增"国内订单号"同义字段，统一使用 domesticTrackingNo。
- 以上字段在 staff 录入后，client 端必须展示一致值。

## 11. 管理员端 V1 - 业务范围定义

### 11.1 管理员能力
- 可创建员工账号
- 可分配员工仓库权限
- 可维护状态字典与系统字典
- 可修改订单/运单状态（需记录审计日志）
- 可维护运输方式与仓库信息

### 11.2 运营看板指标定义
- staffAccountCount: 员工账号总数
- clientAccountCount: 客户账号总数
- newOrderCountToday: 当日新增订单数
- inTransitOrderCount: 运输中订单数
- receivedVolumeM3Today: 当日收货总方数（m³）

### 11.3 操作日志字段（管理员操作必留痕）
- operatorId: string
- operatorRole: "admin"
- operationType: string
- targetType: string
- targetId: string
- beforeValue?: object
- afterValue?: object
- operatedAt: string (ISO datetime)

### 11.4 状态修改规则
- 管理员可修改状态，但仍建议遵循状态流转规则。
- 若执行越级修正，必须填写 remark 并写入操作日志。

## 12. 收件人字段语义统一说明
- receiverName / receiverPhone：
  通用收件人字段（历史兼容字段，适用于通用订单语义）。
- receiverNameTh / receiverPhoneTh / receiverAddressTh：
  泰国侧收件信息字段（V1 主用字段）。

规则：
1. V1 新增或新页面优先使用 receiverNameTh / receiverPhoneTh / receiverAddressTh。
2. 若存在历史数据仅有 receiverName / receiverPhone，展示层可做兼容映射。
3. 禁止再新增同义字段，避免收件人信息分叉。

## 13. Client V1 - AI 对话能力（DeepSeek）

### 13.1 业务目标
- 客户可通过自然语言查询订单进度与发货汇总。
- AI 回答必须基于业务数据，不允许编造结果。

### 13.2 数据范围
- AI 查询范围限定为"同一客户公司下全部账号数据"。
- 不允许访问其他公司数据。

### 13.3 支持问题类型（V1）
- 单票进度查询：例如"我的单号 THCN0001 到哪了？"
- 汇总查询：例如"我本月一共发了多少货？"

### 13.4 AI 查询审计字段
- aiQueryId: string
- userId: string
- companyId: string
- sessionId?: string
- question: string
- answerSummary: string
- referencedOrderIds?: string[]
- referencedShipmentIds?: string[]
- queriedAt: string (ISO datetime)