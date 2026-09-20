# 运营看板上线：完成并独立核验

## 最终状态
- 用户亲自执行第一段 --prepare 和第二段 --live；程序发布成功，收尾成功。agent 负责封包、独立核验与本地记录，没有代执行切换或删除生产数据。
- 目标 `0fdecc0f9bee13eba944473e3c3eb64ea0f46a16`，基线 `3d380aa3a98c24ac38cb493d528d321cd0372639`；包含运营看板直读数字与此前 a344a88「后缀」文案。
- 切换窗口 UTC 2026-09-19 23:59:42–2026-09-20 00:00:19（泰国 09-20 06:59:42–07:00:19）。`POSTFLIGHT_OK`、`CUTOVER_OK_API_THEN_WEB_0fdecc0`、`CLEANUP_OK`、`DEPLOYMENT_DRIVER_COMPLETED` 均有实际输出。
- UTC 00:08 独立核 GitHub main、服务器 HEAD、API/Web 镜像 revision 全同目标；四容器 healthy/restarts=0，无 OOM。PG/Redis 原 ID/启动时间/卷、应用业务环境/端口/网络/挂载、配置 SHA256 全不变。

## 包、备份与演练
- 专用包 `.audit/2026-09-20/release-overview-readable/package`，发布戳 `20260919T221112-overview-readable`，27 文件清单指纹 `60a5694441edaef11eea28101df4c4ca9b766b2deb8a357d749408eef3da25ae`。
- 本地代码与此前验收的 7 文件 SHA256 一致；封包前 9 项 driver 离线流程、178 项严格探针（3952 次真实比较）、篡改/缺失文件拒绝、独立审查通过。不保留历史发布的身份/唛头响应豁免。
- 首次内存不足未试跑或降门槛。用户明确确认后，按旧包 reviewed-cleanup 清理上次残留；独立核验可用内存 2335.8MiB ≥2300MiB 后才提供第一段。未停止其他项目。
- 三件套本机/服务器各 470772731 字节，3/3 全字节 SHA256 独立核验；备份清单指纹 `99d9432b26386dec1e2da0cadd77b34a02c0906913fbff89c43c78d9348dee7a`。
- 真实恢复 51 表，1689 订单、3309 运单、319 图片记录；393 图片 hash 验证。Node 22 Alpine 的 API/Web 镜像实际构建、默认 Turbopack 30/30，新旧镜像在私有恢复库各真实运行。两次全库快照重新比较均 51 表 equal=true。

## 上线独立核验
- 两个 agent 分工核实际运行状态与数据证据，不只采信用户贴回的终端输出。
- 重新运行只读 snapshot-compare.py 对比切换前后存档：51 表完整相等、0 差异，数据/结构/ID/运单指标/迁移账本摘要均一致。本次没有汇率差异，未走退出码 3。
- 原始 API 前后 routes/sample/sourceLogs 完整等值：9 契约、1 父单、19 条源日志，readonly on、连接 1、签收图片 body 读取 0。
- 图片切换前后完整 393 文件清单逐字相同；备份仍在，两边 hash 复核通过。这里描述切换窗口证据，不宣称之后员工业务数据永不变化。
- 公网 login/admin/staff/client/agent/API 均 200；5 个页面实际引用的 28 件 JS/CSS 哈希逐一等于运行容器，新看板文字存在，旧图表标题不在管理员资源中。
- 切换后 API/Web 日志分别 4/9 行，严重错误模式命中 0；不是所有业务操作测试。未做生产真实账号交互式浏览器验收，旧组件示例页视觉验收的边界不变。
- 新发布临时 PG/卷/内部网/builder/两个临时 env 已不存在；生产备份和旧应用镜像保留。员工已告知可以恢复操作，无需再执行命令。

## 收尾与边界
- 只停止本任务的示例预览 3018（核对命令及 cwd 后 SIGTERM），保留预览文件/证据；原开发端口 3000/3001 不动。原未跟踪审查文档不动。
- npm 构建告警 API 1 low、Web 3 moderate/1 high 仍在；本次锁文件/依赖未改，不执行 audit fix 或擅自升级。未做迁移、db push/reset 或生产业务写入。
- 完整证据 `.audit/2026-09-20/release-overview-readable/REPORT.md` 与 `tests/logs/{user-prepare-output,user-live-output}.txt`、`prepare-independent-verification.json`、`live-runtime-independent.json`、`live-data-independent.json`。
- 完整交接文档未擅自重写。本次收尾仅本地文档提交，不再推送/部署。**已执行包保持原目标和指纹，不得为匹配后续文档 HEAD 重封，也不得重跑 prepare/live/cleanup。** 日后只有确实需要回退时单独提供已核验的回退操作，绝不和正常命令混发。
