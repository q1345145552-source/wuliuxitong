/**
 * 湘泰 app（安卓外壳 mobile/，2026-10-05 老板「做安卓app」）—— 不开模拟器、不连库的测试。
 * 模拟器里逐项实测过的东西（导出存手机 + 分享、打印标签、返回键、拍照、键盘、断网重试、已登录直接进），
 * 这里把「改坏了会悄悄失效」的那几处钉住：
 *
 *   A1 浏览器里一行都不执行：没有 Capacitor（或不是原生）时 installNativeApp 不碰 document、不改任何东西
 *   A2 存文件：data: 链接能读出内容；文件名里手机存不了的字符换掉；页面造的 blob 按网址记原件（不靠 fetch，网站 CSP 会拦）
 *   A3 新窗口：只接管 window.open("") / about:blank（打印标签、看付款凭证），外面的网址照旧交给系统浏览器
 *   A4 返回键的先后：盖着的那层 → 浏览器自带弹窗（导出）→ 左边菜单 / 其它弹窗 → 上一页 → 收到后台
 *   A5 提示条走浏览器顶层（popover），不然被导出弹窗（<dialog>.showModal）盖住
 *   A6 打开 app 时已登录就直接进工作台：只在 /login、跟登录页用同一份「角色 → 工作台」
 *   A7 客服页「开启通知」那行 app 里不出（app 开不了浏览器通知，「换 Chrome」对 app 用户是错的）
 *   A8 外壳配置：打开线上网站、连不上有自己的页、调试口只在测试包开；安卓那边：打印登记在 onCreate 之前、
 *      上传图片能拍照（不申请相机权限）、固定浅色
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const NATIVE = "apps/web/src/modules/app-shell/native-app.ts";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`✓ ${name}`);
}

/** 截出 native-app.ts 里某个函数的源码（到下一个顶格 function / 注释段为止） */
function fnSource(src: string, name: string): string {
  const start = src.search(new RegExp(`function ${name}\\(`));
  assert.ok(start >= 0, `找不到 ${name}`);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n(?:export )?function |\n\/\* -{5,}|\nlet installed/);
  return src.slice(start, next < 0 ? undefined : start + 1 + next);
}

async function main(): Promise<void> {
  const src = read(NATIVE);

  await check("A1 浏览器里（没有 Capacitor / 不是原生）installNativeApp 什么都不做、不碰 document", async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { window: g.window, document: g.document };
    try {
      // document 故意不给：装的过程里只要碰一下就会抛错
      delete g.document;
      g.window = {};
      const mod = await import("../apps/web/src/modules/app-shell/native-app");
      assert.equal(mod.isNativeApp(), false);
      mod.installNativeApp();
      g.window = { Capacitor: { isNativePlatform: () => false } };
      assert.equal(mod.isNativeApp(), false, "网页版 Capacitor（不是原生）也不能当成 app");
      mod.installNativeApp();
    } finally {
      g.window = saved.window;
      if (saved.document === undefined) delete g.document; else g.document = saved.document;
    }
    assert.match(src, /export function installNativeApp\(\): void \{\n  if \(installed \|\| !isNativeApp\(\)\) return;/);
  });

  await check("A2 存文件：data: 链接读出内容；文件名去掉手机存不了的字符；blob 记原件不靠 fetch（CSP 会拦）", async () => {
    const { fileContentOf, safeFileName } = await import("../apps/web/src/modules/app-shell/native-app");
    assert.equal(await fileContentOf("data:application/octet-stream;base64,QUJD"), "QUJD");
    assert.equal(Buffer.from(await fileContentOf("data:text/plain,%E6%B9%98%E6%B3%B0")!, "base64").toString("utf8"), "湘泰");
    assert.equal(fileContentOf("https://xianlianth.com/a.xlsx"), null, "普通网址不接管");
    assert.equal(fileContentOf("blob:https://x/unknown"), null, "没记下的 blob 不接管（交回原来的点击）");
    assert.equal(safeFileName('运单:列表/2026*10?05.xlsx'), "运单_列表_2026_10_05.xlsx");
    assert.equal(safeFileName("   "), "下载的文件");
    const downloads = fnSource(src, "installDownloads");
    assert.ok(!/fetch\(/.test(downloads), "存文件不能用 fetch 读 blob / data 网址（网站 CSP 的 connect-src 不放行）");
    assert.match(downloads, /URL\.createObjectURL = /);
    assert.match(downloads, /HTMLAnchorElement\.prototype\.click = /);
    assert.match(downloads, /addEventListener\("click", [\s\S]*?\}, true\)/, "人手点的 <a download> 要在捕获阶段接");
    // 先存一份到手机公共文件夹，存不进（安卓 10 及更早）再退回 app 缓存，然后弹分享
    const share = fnSource(src, "shareFile");
    assert.ok(share.indexOf('directory: "DOCUMENTS"') < share.indexOf('directory: "CACHE"'));
    assert.match(share, /callNative\("Share", "share"/);
  });

  await check("A3 window.open：只接管空白窗口（打印标签 / 付款凭证），外面的网址照旧交给系统浏览器", () => {
    const open = fnSource(src, "installWindowOpen");
    assert.match(open, /if \(href === "" \|\| href === "about:blank"\) return openOverlayWindow\(\);/);
    assert.match(open, /return originalOpen\(/);
    const overlay = fnSource(src, "openOverlayWindow");
    assert.match(overlay, /win\.print = \(\) => \{/, "盖的那层里的 window.print 要交给安卓打印");
    assert.match(src, /callNative\("XtPrint", "printHtml"/);
    // 打印标签那边确实是 window.open("") + document.write + window.print（换了写法这里就要跟着看）
    const label = read("apps/web/src/modules/shipment/ShipmentPrintLabel.tsx");
    assert.match(label, /window\.open\("", "_blank"/);
    assert.match(label, /<script>window\.print\(\);<\/script>/);
  });

  await check("A4 返回键先后：盖的那层 → 浏览器自带弹窗 → 左边菜单 / 其它弹窗 → 上一页 → 收到后台（不退出登录）", () => {
    const back = fnSource(src, "installBackButton");
    const order = ["closeOverlay()", "closeTopLayer()", "window.history.back()", '"minimizeApp"'].map((s) => back.indexOf(s));
    assert.ok(order.every((i) => i > 0), `返回键处理少了一步：${order}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, "返回键先后顺序变了");
    const layer = fnSource(src, "closeTopLayer");
    assert.ok(layer.indexOf("dialog[open]") < layer.indexOf(".dashboard-sidebar.open"), "浏览器自带弹窗（导出）要最先关");
    assert.match(layer, /\.close\(\)/, "<dialog> 要直接 close：发 Esc 关不掉它");
    assert.match(layer, /new KeyboardEvent\("keydown", \{ key: "Escape"/);
  });

  await check("A5 提示条走浏览器顶层（popover），压得过导出那个 <dialog>.showModal()", () => {
    const toast = fnSource(src, "showToast");
    assert.match(toast, /setAttribute\("popover", "manual"\)/);
    assert.match(toast, /showPopover\(\)/);
    assert.match(read("apps/web/src/modules/shipment/ShipmentExportPanel.tsx"), /showModal\(\)/, "导出不再是 showModal 的话，A5 的理由要重看");
    // 分享菜单关了再提示（开着的时候提示被它盖住）
    assert.match(fnSource(src, "shareFile"), /finally \{[\s\S]*showToast/);
  });

  await check("A6 已登录直接进工作台：只在 /login；跟登录页用同一份「角色 → 工作台」", () => {
    const enter = fnSource(src, "enterWorkbenchIfLoggedIn");
    assert.match(enter, /if \(window\.location\.pathname !== "\/login"\) return;/);
    assert.match(enter, /ROLE_HOME_PATH\[session\.role\]/);
    assert.match(enter, /window\.location\.replace\(home\)/, "用 replace，不然返回键会退回登录页");
    const login = read("apps/web/src/modules/branding/LoginView.tsx");
    assert.match(login, /import \{ ROLE_HOME_PATH \} from "\.\/role-home";/);
    assert.match(login, /window\.location\.href = ROLE_HOME_PATH\[result\.user\.role\]/);
    assert.ok(!/roleRouteMap/.test(login), "登录页又自己抄了一份角色 → 工作台");
  });

  await check("A7 客服页「开启新消息通知」那行在 app 里不出", () => {
    const toggle = read("apps/web/src/modules/cs-chat/ChatPushToggle.tsx");
    assert.match(toggle, /if \(state === null \|\| state === "server-off" \|\| isNativeApp\(\)\) return null;/);
  });

  await check("A8 外壳配置 + 安卓那边的几处接线", () => {
    const layout = read("apps/web/src/app/layout.tsx");
    assert.match(layout, /<NativeAppBridge \/>/);
    const cfg = read("mobile/capacitor.config.ts");
    assert.match(cfg, /const appUrl = process\.env\.XT_APP_URL \|\| "https:\/\/xianlianth\.com";/);
    assert.match(cfg, /errorPath: "offline\.html"/);
    assert.match(cfg, /webContentsDebuggingEnabled: process\.env\.XT_APP_DEBUG === "1"/, "正式包不能开网页调试口");
    assert.match(cfg, /appId: "com\.xianlianth\.app"/, "包名一旦发出去就不能改（改了等于另一个 app）");
    assert.match(read("mobile/offline.template.html"), /window\.XT_APP_URL = "__XT_APP_URL__";/);
    const main = read("mobile/android/app/src/main/java/com/xianlianth/app/MainActivity.java");
    assert.ok(main.indexOf("registerPlugin(XtPrintPlugin.class)") < main.indexOf("super.onCreate(savedInstanceState);"), "自己写的原生功能要在 super.onCreate 之前登记");
    assert.match(main, /setWebChromeClient\(new XtWebChromeClient\(bridge\)\)/);
    const manifest = read("mobile/android/app/src/main/AndroidManifest.xml");
    assert.match(manifest, /android\.media\.action\.IMAGE_CAPTURE/, "安卓 11 起不声明就查不到相机");
    assert.ok(!/android\.permission\.CAMERA/.test(manifest), "声明了相机权限，系统相机拍照就得先弹权限框（不声明反而直接能拍）");
    assert.match(read("mobile/android/app/src/main/res/values/styles.xml"), /AppTheme\.NoActionBar" parent="Theme\.AppCompat\.Light\.NoActionBar"/);
    assert.match(read("mobile/android/app/build.gradle"), /\.xiangtai-app\/keystore\.properties/, "签名钥匙要从仓库外面读");
  });

  console.log(`\nApp 外壳 ${passed} 项全部通过`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
