# 湘泰物流 app（安卓外壳）

2026-10-05 起。用 Capacitor 8 把线上网站 https://xianlianth.com 包成安卓 app：数据、登录、实时推送全跟网站同一套，
网站一上线新版，app 下次打开就是新版，**改网站不用重新发 app**。只有改了这个目录（外壳本身）才要重新打包、重新装。

网页在 app 里做不到的几件事由网站这边的 `apps/web/src/modules/app-shell/native-app.ts` 接过来（浏览器里不执行）：
存 Excel（先存到手机「Documents / 湘泰物流」再弹分享）、打印标签（安卓自带打印）、看付款凭证这类「开新窗口」、
手机返回键、键盘弹起时收起底部入口、已登录直接进工作台。外壳这边自己写的原生代码：

- `android/app/src/main/java/com/xianlianth/app/XtPrintPlugin.java`：打印
- `android/app/src/main/java/com/xianlianth/app/XtWebChromeClient.java`：上传图片时「拍照 / 相册」都能选

## 打包

要 Java 21 和安卓 SDK（`android-env.sh` 里指好了，不改这台 Mac 的默认 Java）。

```bash
cd mobile && npm install
npm run apk:release   # 正式包：android/app/build/outputs/apk/release/app-release.apk，打开线上网站
```

正式包用 `~/.xiangtai-app/` 里的签名钥匙（`xiangtai-release.jks` + `keystore.properties`，不在仓库里）。
**这两个文件一定要另外备份**：丢了以后发的新版装不到已经装了 app 的手机上（签名对不上），只能让所有人卸了重装。
换电脑打包：把这两个文件一起拷到新电脑的 `~/.xiangtai-app/`（`storeFile` 写的是相对路径，两个文件放一起就找得到）；
放别处就用 `XT_KEYSTORE_PROPS=那份 keystore.properties 的路径 npm run apk:release`。
`apk:release` 自己把网址锁成线上；网页调试口只在测试包里开（Capacitor 按安装包类型自动定）。
打正式包前 `app/build.gradle` 还会查一遍要装进包的配置：网址不是线上、开了明文或调试口，直接打不出来。

每次发新版外壳，把 `android/app/build.gradle` 里的 `versionCode` 加 1（`versionName` 写给人看的版本号）。

## 本机模拟器测试

```bash
. ./android-env.sh
emulator -avd xt_phone -no-window -no-audio &          # 第一次要先建：avdmanager create avd -n xt_phone -k "system-images;android-36;google_apis;arm64-v8a" -d pixel_7
XT_APP_URL=http://10.0.2.2:3019 npm run apk:debug   # 10.0.2.2 = 模拟器眼里的这台 Mac；3019 是本机起的网站
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

测试包开了网页调试口：`adb forward tcp:9333 localabstract:webview_devtools_remote_<进程号>` 后能在电脑上看页面、执行脚本。
注意：用脚本点按钮造成的换页，安卓网页控件不算进「返回」历史（防滥用规则）；测返回键要用 `adb shell input tap` 真点。

## 安全边界（改外壳前先看）

- **跟手机打交道的那座桥只开给 `https://xianlianth.com` 一个网站**（Capacitor 按 `server.url` 定，没配 `allowNavigation`）。
  点到别的网址（快递100 之类）一律交给手机自带浏览器，不在 app 里开。代价：凡是在 xianlianth.com 上跑的脚本
  都能调存文件 / 分享 / 打印 —— 网站自己别引进来路不明的第三方脚本。
- **装了哪些原生功能**：App（返回键）、Filesystem（存文件）、Share（分享）、自己写的 XtPrint（打印）；
  上传图片的「相机 / 相册」是改的 WebChromeClient，不申请相机权限。
- **网页调试口**：只有测试包有；正式包打包前 `app/build.gradle` 会查，开了就打不出来。
- **不备份**：`allowBackup="false"` + `data_extraction_rules.xml`，登录令牌不跟云备份、换机迁移走。
- **能交给别的 app 的文件**（`res/xml/file_paths.xml`）只限拍照临时文件、导出文件那几个文件夹。
- **签名钥匙**：在仓库外 `~/.xiangtai-app/`，仓库的 `.gitignore` 挡着 `*.jks`。

## 图标 / 启动图

用网站的公司标志 `assets/logo.png` 生成：`python3 scripts-icons.py`（要 Pillow）。

## 还没做

- 苹果版：同一套外壳加 iOS，要先装 Xcode。
- 锁屏 / 后台的新消息提醒：app 里的网页开不了浏览器通知，要接厂商推送通道。
- 上应用商店：备案、开发者账号这些不在技术范围里，目前是直接发安装包。
