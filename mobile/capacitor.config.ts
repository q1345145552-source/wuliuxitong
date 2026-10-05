import type { CapacitorConfig } from "@capacitor/cli";

/**
 * 湘泰物流 app（2026-10-05 老板：「我需要做成app，数据都能连接上，不能有延迟」「做安卓app」）。
 *
 * 做法：app 是一个外壳，打开的就是线上网站（https://xianlianth.com），数据、登录、实时推送全跟网站同一套；
 * 网站一上线新版，app 下次打开就是新版，不用重新装。
 * 网页在 app 里做不到的几件事（存 Excel、打印标签、看付款凭证这种「开新窗口」、手机返回键）
 * 由网站里的 modules/app-shell/native-app.ts 在 app 里接过来，交给这里装的几个原生功能。
 *
 * 本机模拟器测试：XT_APP_URL=http://10.0.2.2:3019 npm run apk:debug（10.0.2.2 = 模拟器眼里的这台 Mac）
 */
const appUrl = process.env.XT_APP_URL || "https://xianlianth.com";

const config: CapacitorConfig = {
  appId: "com.xianlianth.app",
  appName: "湘泰物流",
  // 只放连不上网时显示的那一页（offline.html）；平时用的是上面的线上网站
  webDir: "www",
  backgroundColor: "#fafaf8",
  // 网站据此知道自己是在 app 里打开的
  appendUserAgent: "XiangtaiApp/1.0",
  server: {
    url: appUrl,
    cleartext: appUrl.startsWith("http://"),
    errorPath: "offline.html",
  },
  plugins: {
    // 状态栏 / 底部手势条：浅底深色字（网站是浅色的）。页面自动让开这两条，不会被盖住
    SystemBars: { style: "LIGHT" },
  },
  // 网页调试口故意不写：Capacitor 不写这项就按安装包类型定 —— 测试包（debuggable）开、正式包关，
  // 谁在终端里设了什么环境变量都改不了正式包（Codex 10-05 复审）。正式包打包时 app/build.gradle 还会再查一遍。
};

export default config;
