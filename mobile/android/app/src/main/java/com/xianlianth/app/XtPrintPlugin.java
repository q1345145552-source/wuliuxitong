package com.xianlianth.app;

import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 打印（2026-10-05）：网页里的 window.print() 在 app 里没反应（安卓的网页控件不带打印），
 * 网站在 app 里打印标签时把要打印的那页 HTML 交过来，这里用安卓自带的打印功能打（选打印机，或者存成 PDF）。
 *
 * 做法照安卓官方文档：另开一个看不见的网页控件装这段 HTML，加载完再交给系统打印；
 * 文档要求打印期间一直拿着这个控件，所以存在 printView 里，下一次打印时才换掉。
 * 不开脚本：标签 HTML 末尾带一句 window.print()，开了脚本会在这里再触发一次。
 */
@CapacitorPlugin(name = "XtPrint")
public class XtPrintPlugin extends Plugin {

    private WebView printView;

    @PluginMethod
    public void printHtml(PluginCall call) {
        String html = call.getString("html");
        if (html == null || html.isEmpty()) {
            call.reject("没有要打印的内容");
            return;
        }
        String jobName = call.getString("jobName", "湘泰物流");
        getActivity()
            .runOnUiThread(() -> {
                WebView view = new WebView(getContext());
                view.getSettings().setJavaScriptEnabled(false);
                view.setWebViewClient(
                    new WebViewClient() {
                        private boolean started = false;

                        @Override
                        public void onPageFinished(WebView loaded, String url) {
                            if (started) return;
                            started = true;
                            PrintManager printManager = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                            PrintDocumentAdapter adapter = loaded.createPrintDocumentAdapter(jobName);
                            printManager.print(jobName, adapter, new PrintAttributes.Builder().build());
                            call.resolve();
                        }
                    }
                );
                printView = view;
                view.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
            });
    }
}
