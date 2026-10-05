/**
 * 安卓 app 安装包放在哪、是哪一版（2026-10-05 老板选「C」：网站放下载页 + 他自己也发文件）。
 * 发新版外壳时：mobile/ 里 npm run apk:release → 把 app-release.apk 拷成 apps/web/public/download/xiangtai-<版本>.apk，
 * 改下面三个值、删掉旧文件，随网站一起上线（见 mobile/README.md「发新版」）。
 */
export const APP_VERSION = "1.0";
export const APK_PATH = "/download/xiangtai-1.0.apk";
/** 给人看的大小 */
export const APK_SIZE_TEXT = "约 4 MB";
/** 下载到手机上的文件名 */
export const APK_SAVE_AS = "湘泰物流-1.0.apk";
