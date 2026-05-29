# 3 Agent 协作规范（Cursor）

## 1. 目标
使用 3 个 Cursor agent 并行开发管理员端、员工端、客户端，最终合并为单一前端应用。

## 2. 分工边界
- Agent-admin：管理员页面与能力
- Agent-staff：员工页面与能力
- Agent-client：客户端页面与能力

共同边界：
1. 不得在各自分支私自定义业务状态枚举。
2. 不得绕开 shared-types 创建重复类型。
3. 不得修改他人角色目录中的业务逻辑（紧急修复除外）。

## 3. 分支策略
- main（稳定分支）
- feature/admin-portal
- feature/staff-portal
- feature/client-portal

流程：
1. 每天开始前同步 main
2. 每个 agent 在自己的 feature 分支开发
3. 发 PR 到 main
4. 通过检查后合并

## 4. 开发顺序（强制）
1. 先改 docs（domain / rbac / api）
2. 再改 packages/shared-types
3. 再改 packages/ui（如涉及）
4. 最后改 apps/web 对应角色页面与 apps/api 逻辑

## 5. PR 检查清单（每次必看）
- 是否引用 shared-types，而非本地重复定义？
- 是否遵守统一状态流转？
- 是否符合 API 契约？
- 是否符合权限矩阵（前端 + 后端）？
- 是否影响其他角色显示一致性？

## 6. 冲突处理
- 状态/字段冲突：以 docs/domain-dictionary.md 为唯一真相源。
- 权限冲突：以 docs/rbac-matrix.md 为唯一真相源。
- 接口冲突：以 docs/api-contract.md 为唯一真相源。

## 7. 一致性验收标准
1. 三端查看同一运单，核心字段一致。
2. 同一状态在三端文案一致。
3. 客户端无法执行 staff/admin 的动作。
4. staff/admin 越权访问受限数据时后端返回 403。

## 8. 变更规则
- 新增字段/状态/接口，必须先更新 docs，再改代码。
- 破坏性接口变更必须写迁移说明。
## 9. Client V1 新需求同步规则（2026-02）

### 9.1 本次新增范围（必须同步）
- 物流预报单字段：
  - itemName
  - packageCount
  - productQuantity
  - domesticTrackingNo
  - transportMode (sea | land)
  - receiverNameTh
  - receiverPhoneTh
  - receiverAddressTh

- 客户端查询维度：
  - trackingNo
  - domesticTrackingNo
  - itemName
  - dateFrom/dateTo
  - transportMode

- 我的订单分组规则：
  - completed = delivered | returned | cancelled
  - unfinished = 其他状态

### 9.2 三个 Agent 的执行边界（本次版本）
- Agent-client：
  - 负责 client 的预报单、查询、订单列表页面与交互
- Agent-staff：
  - 负责 staff 侧同维度查询与状态处理页面
- Agent-admin：
  - 负责 admin 侧全量查询、数据校验、统计看板字段对齐

### 9.3 强制一致性要求
1. 三端查询参数命名必须一致（trackingNo、domesticTrackingNo、itemName、transportMode、dateFrom、dateTo）。
2. 三端"完成/未完成"分组规则必须一致。
3. 任何字段变更先更新：
   - docs/domain-dictionary.md
   - docs/api-contract.md
   - docs/rbac-matrix.md
   - docs/agent-workflow.md
   再进入代码开发。

### 9.4 PR 额外检查项（本版本）
- 是否遗漏 domesticTrackingNo 字段？
- transportMode 是否统一使用 sea/land 枚举？
- completed/unfinished 规则是否与文档一致？
- client 数据范围是否仍限制为"仅本人"？
财务板块（对账、结算、退款、发票）归入 V2，不进入当前 V1 开发范围。
## 10. Staff V1 新规则同步（状态与仓库权限）

### 10.1 Agent-staff 强制约束
1. 不允许实现任意状态跳转，必须走状态流转规则。
2. 不允许绕过仓库权限进行状态修改。
3. 必须记录状态变更审计日志字段：
   - operatorId
   - operatorName
   - operatorWarehouseId
   - fromStatus
   - toStatus
   - changedAt
   - remark

### 10.2 PR 额外检查项
- 是否有状态流转合法性校验？
- 是否有仓库修改权限校验？
- 是否写入了完整审计日志？
- 是否与 client 端状态展示规则一致？
## 11. Staff 创建订单与字段对齐规则（V1）

### 11.1 命名统一
- "国内订单号"与"国内快递单号"统一为 domesticTrackingNo。
- 禁止在任何分支新增同义字段名（如 domesticOrderNo、chinaExpressNo）。

### 11.2 Agent 分工补充
- Agent-staff：
  - 负责员工创建订单与物流字段补录页面/接口联调。
- Agent-client：
  - 负责展示 staff 录入字段（只读，不可编辑）。
- Agent-admin：
  - 负责字段审计、权限校验与全量查看。

### 11.3 提交流程补充
1. 先更新四文档（domain/api/rbac/workflow）。
2. 再更新 shared-types 字段定义。
3. 最后开发页面与接口。

### 11.4 PR 额外检查项
- 是否全链路统一使用 domesticTrackingNo？
- client 是否仅只读展示物流补录字段？
- staff/admin 是否具备更新权限且后端有权限校验？
- 三端字段展示是否一致（trackingNo、weightKg、volumeM3、packageCount、packageUnit）？
## 12. Admin V1 新需求同步（账号权限 + 看板 + 配置）

### 12.1 Agent-admin 负责范围
- 运营看板页面与接口联调
- 员工/客户账号管理页面与接口联调
- 仓库授权页面与接口联调
- 字典与运输方式配置页面与接口联调
- 操作日志页面与接口联调

### 12.2 强制约束
1. 所有管理员变更操作必须产生日志（operatedAt 必填）。
2. 管理员修改状态需记录 fromStatus/toStatus/remark。
3. 状态字典变更不得破坏 client/staff 已使用状态值。
4. 仓库授权变更必须即时影响 staff 修改权限判定。

### 12.3 PR 检查项
- 看板指标字段是否与 domain 定义一致？
- 账号与仓库授权是否有后端权限校验？
- 字典/运输方式配置改动是否有审计日志？
- 是否影响 client/staff 现有查询和状态展示一致性？

## 13. Client AI 对话（DeepSeek）协作规则

### 13.1 Agent 分工
- Agent-client：
  - 负责 AI 按钮、对话弹窗、消息展示和常用问题。
- Agent-staff：
  - 不实现 AI 入口，但需确保订单/运单字段可被 AI 查询层读取。
- Agent-admin：
  - 负责 AI 审计查询页面与权限校验联动（如有）。

### 13.2 强制约束
1. DeepSeek 仅允许后端代理调用，禁止前端直连。
2. AI 查询必须限定在"同公司范围"。
3. AI 回答必须基于结构化数据，不允许无证据输出。
4. 每次 AI 对话必须写审计日志（userId/companyId/question/answerSummary/queriedAt）。

### 13.3 PR 检查项
- 是否有公司范围校验？
- 是否避免前端泄露 DeepSeek Key？
- AI 响应是否包含可核对证据字段（evidence）？
- 审计日志字段是否完整？