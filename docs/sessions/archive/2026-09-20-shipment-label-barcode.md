# 运单标签条形码：本地完成，未提交/推送/上线

## 范围与实现
- 用户“能搞条形码吗”：给管理员、员工原运单「打印」标签添加条形码；共用 ShipmentPrintLabel.tsx，不改两端调用方、后端、权限或生产数据。
- 扫描值是原运单号，大小写/空格/前导零不改，不附箱号；不增加扫码自动入库、签收等行为。原文字与每箱一张保留，多产品分支同样生效。
- 新 trackingBarcode.ts 复用前端已锁定 JsBarcode 3.12.3 的公开对象 encodings API，用 CODE128 编码后画 SVG；不使用 CDN、图片加载、打印窗口脚本或外部字体。编码一次，多个箱标签复用。
- 原标签 280px 宽，SVG 最大 256px，左右各 10 模块静区，默认 1.5px 模块，不够才降 1px，44px 黑条、纯白底；仍放不下就显示过长提示，不强缩。空号/全空白、非 printable ASCII、控制字/FNC、编码异常也保留原标签并明确提示。
- 测试旧 VM 加 jsbarcode 精确 allowlist 和与前端一致的 esModuleInterop；其余外部依赖继续拒绝。新 npm 测试脚本和 CI 步骤已加入，依赖/锁文件不改。

## 已验证
- 改前旧身份/唛头回归通过；改后真模块新增 36/36，身份保护 19/19，唛头 12/12，运单列表 12/12，管理员详情 16/16，合计 95 项通过。
- scripts 与 web tsc 通过，源码隔离副本默认 Turbopack 正式构建 30/30；没有在原 web 下 build。6 件交付文件最终 hash 与验证副本一致。
- 5 个变异只在隔离副本做，依次制造静区不足、号码 trim/大写、单产品漏 SVG、模块<1px强缩、吞错误提示，均预期失败；每项恢复原始 bytes/hash，最后 36/36 再过。没有在原 3000 热更新目录反复撤改。
- 独立 agent 从真实 openPrintLabel 抽 SVG，用 sharp 按 CSS 96px/in 对应 96/203/300dpi，Apple Vision 真解码 7 种号×3=21 图均回原值，包括子单、36位数字、大小写、特殊字符、首尾空格。
- 首轮独立夹具错误期待 38 位数字也能生成，实际含静区 264 模块超过 256，明确降级是正确行为；改夹具为 36 位可生成、38 位应提示，首次失败日志保留，源码未为通过测试放宽。
- 实际 IAB 打开独立静态示例（真 HTML 只移除自动 print 脚本防误打），标签 280px、条码198px完整在内，无溢出、控制台无告警/错误；截图 label-preview.jpg。未调用实体打印机，未做扫码枪验收。

## 收尾与证据
- 无生产访问/推送/部署；基线本地 HEAD f6fc895，线上仍前轮已核的 0fdecc0，本次没有再查线上或改旧包。
- 原 3000/PID73424、3001/PID24476 开发服务保留；只关闭本任务浏览器页，核命令/cwd 后停止 3038 静态预览。
- `.audit/2026-09-20-shipment-barcode/REPORT.md`、`verified-sha256.json`、`logs/`、`independent/`、`mutations/`、`label-preview.jpg`。源码与测试尚未提交。
- 如果继续上线，先提交新版本并准备新包；旧已执行包不能重封/重跑。本地数据图像识别不等于真实纸张与扫码枪已验，需先试打一张。

## 一手依据
- 本机 apps/web/node_modules/jsbarcode 实际版本源码和类型。
- 已联网打开的官方 README：https://github.com/lindell/JsBarcode （CODE128、对象 encodings）、Options：https://github.com/lindell/JsBarcode/wiki/Options。
