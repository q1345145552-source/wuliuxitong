// cap sync 之前跑：按 XT_APP_URL（跟 capacitor.config.ts 同一个）生成 www/offline.html（连不上网时那一页，「重试」回到这个网址）。
// 网址直接写进页面：app 打开的是线上网站时，外壳只让这一页从本地读，旁边的 js 文件读不到（2026-10-05 模拟器实测）。
import { readFileSync, writeFileSync, rmSync } from "node:fs";
const url = process.env.XT_APP_URL || "https://xianlianth.com";
// 只认 http(s) 网址（写成 javascript: 之类，离线页的「重试」会去执行它）
if (!/^https?:\/\/[^\s"'<>]+$/.test(url)) throw new Error(`XT_APP_URL 不是正常网址：${url}`);
const template = readFileSync(new URL("./offline.template.html", import.meta.url), "utf8");
writeFileSync(new URL("./www/offline.html", import.meta.url), template.replace("__XT_APP_URL__", JSON.stringify(url).slice(1, -1).replace(/</g, "\\u003c")));
rmSync(new URL("./www/app-url.js", import.meta.url), { force: true });
console.log("app 打开的网址：", url);
