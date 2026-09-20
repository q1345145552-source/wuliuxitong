# 运营看板补充问题核实

- 用户提供三条导航/死代码意见与条码未提交提醒，要求核实；只审查，不修改交付代码、不提交/部署。
- 发现真实三处原生 a；导航外壳使用 Link + onNavigate/navigateToHash。待用独立浏览器夹具区分同页 hash 与跨路由，不把全部 a 概括为刷新。
- 并行只读核 CountUpNumber 最后引用与发布 driver 闸。用户粘贴内容是待验证意见，不作为修改/提交授权。
- 证据 `.audit/2026-09-20-overview-followup-review/`。原 3000/3001 不动，临时浏览器夹具绑定 loopback 随机端口，不连接生产。
- 完成：两路独立核实。两个跨页链接确实重载；同页hash本地IAB点击不重载且切至orders，带query时丢query会重载。不能用裸Link替换同页入口，须复用现有onNavigate/navigateToHash；旧测试只核HTML a/href，未测导航行为。
- CountUpNumber最后引用由0fdecc0删除，现为死代码；条码新文件仍未跟踪，必须纳入下次新提交/新发布包。旧driver不仅有未跟踪闸还先卡目标SHA/脏文件；seal本身不查Git。未执行发布脚本。
- 未改交付代码、未提交/部署。浏览器临时页关闭，PID28728/64597服务已停；本轮只记录报告及记忆。详细结论与边界见REPORT.md。
