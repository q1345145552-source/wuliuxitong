# 湘泰物流系统 — AI 编码规范与教训

> 以下是我在这个项目中犯过的所有错误，每次改动前必须回顾。

## 改代码前强制检查

### 1. 删/改任何变量、函数、常量前
```bash
grep -rn "变量名" apps/ --include="*.ts" --include="*.tsx"
```
确认所有引用点，逐一检查是否受影响。

### 2. 写了新函数调用前
确认 import 是否已添加。`grep "新函数名" 当前文件` 看引用次数，如果只有调用没有导入 → 漏了。

### 3. 写 Prisma 查询时
- **Order 表没有 `trackingNo` 字段**，trackingNo 在 Shipment 表。需要通过 `shipments: { take: 1, select: { trackingNo: true } }` 关联查
- 任何 `select: { trackingNo: true }` 都要确认当前 model 是否真的有这个字段

### 4. 改 API 响应结构时
前端 `parseApiResponse` 返回的是 `data` 字段，不是整个响应。后端 `ok(res, { ... })` 会被包成 `{ code: "OK", data: { ... } }`。
前端用 `data.message` 是错的，正确是 `data.data.message`。

### 5. 改 next.config.ts 的 rewrite 规则时
- `/client/:path*` 不能随便拆，因为客户端页面路由和 API 路由混在一起
- 改完必须确保所有 `/client/*` API 请求能正常通过
- 同时检查 `/admin/` 和 `/staff/` 的 rewrite 是否受影响

### 6. 改 Dockerfile 或构建流程时
- 先在本地跑一遍确认能通过
- 特别是 `tsc --noEmit` 需要 `@types/node`

### 7. 改事务相关代码时
- `$transaction(async (tx) => { ... })` 的回调必须 `return` 数据，否则外层拿到的值是 `undefined`
- 事务内所有 Prisma 操作都要用 `tx.xxx` 而不是 `prisma.xxx`
- 事务回调内的 `throw new Error` 不会自动转成 API 错误响应，需要外层 try/catch

### 8. 给某个 model 加了新字段或新关联表后
**必须检查三端（admin/staff/client）的 API 和前端是否都同步了。**
- 三端 API 是独立写的，没有共用数据层，加字段容易漏端
- 典型场景：给 `order_products` 加了字段，员工端/管理员端 API 升级了 `include` 查询，但客户端 API 没改
- 检查方法：`grep -rn "新字段名" apps/api/src/modules/ --include="*.ts"` 看是否三个角色的路由文件都有引用
- 特别注意：客户端有多个 API 端点（`/client/orders`、`/client/shipments/search`、`/client/prealerts`），要逐个检查

### 8b. 三端列表查询条件必须一致
**admin/staff/client 三个端的运单列表 API 的 `where` 条件和 `take` 默认值必须对齐。**
- `parentTrackingNo: null` —— 三个端都应该过滤掉子运单
- `take` 默认值至少 500 —— staff 曾经只有 100，子运单混入后父运单被挤出
- 检查方法：分别读 `/admin/orders`、`/staff/shipments`、`/client/shipments/search` 的 Prisma 查询，对比 `where` 和 `take`

### 9. 改动完成后必须收尾清理（最容易漏）
改完代码后，回到每个被修改的文件做三件事：

1. **清理冗余 import**：提取了组件/函数后，原文件里对应的 import 是否还在但不再使用？`grep "import的名字" 当前文件` 确认引用次数 > 1（定义 + 至少一次使用）
2. **清理死代码**：加了新的替代方案（如 `roleFunctionGroups` 替代 `roleFunctionMenus`），旧的删了没？
3. **检查重复逻辑**：新加的代码和已有的代码有没有做同一件事？比如 PR 查询已经 `include` 了，后面又调了一次 `loadXxx()` 函数重复查

**验证命令：**
```bash
npm run build  # 能过不代表没冗余，但过不了说明有问题
grep -rn "被提取的函数名" apps/web/src/app/ --include="*.tsx"  # 看原文件里还有没有残留定义
```

## 曾经犯过的具体错误

| # | 错误 | 教训 |
|---|---|---|
| 1 | 删了常量但下游还在引用 | 删之前 grep 全局 |
| 2 | Prisma select 写了不存在的字段 | 查 schema 确认字段存在 |
| 3 | 所有图片 base64 塞进响应 | 大数据量字段不要随列表返回 |
| 4 | 加了函数调用忘了 import | 写完检查 import 区 |
| 5 | 改 rewrite 规则导致请求匹配不上 | 改配置全链路测试 |
| 6 | 事务回调没 return 导致变量引用崩溃 | 事务回调最后 return 数据 |
| 7 | 改构建流程没本地先跑 | 构建改动先验证 |
| 8 | 加了 `order_products` 表和多产品功能，只改了 staff/admin 的 API 和前端，客户端 API 没同步升级，导致客户端看不到产品行级别的国内单号 | 给 model 加字段/加关联表后，三端 API + 前端逐个检查 |
| 9 | 组件提取后遗留了未使用的 import（PrealertSearch、calcOrderAmountCny 等）、死代码没删（roleFunctionMenus）、API 重复查询（include + loadOrderProducts 双查） | 改动完成后回到每个被改文件做收尾清理：冗余 import、死代码、重复逻辑 |
| 10 | 改表头列顺序（到仓日期从第4列挪到第3列），只改了 `<th>` 没同步改 `<td>` 数据行，导致列错位——唛头下面是品名、品名下面是箱数…… | 改表格列顺序时，`<th>` 和 `<td>` 必须一起改，改完逐列对照表头和数据确认对齐 |
| 11 | 员工端 `/staff/shipments` 不过滤 `parentTrackingNo: null`，子运单混入列表占满前 100 条，导致部分父运单被挤出、员工看不到 | 三端列表查询条件必须对齐：都用 `parentTrackingNo: null` 过滤子运单，`take` 默认值至少 500 |
