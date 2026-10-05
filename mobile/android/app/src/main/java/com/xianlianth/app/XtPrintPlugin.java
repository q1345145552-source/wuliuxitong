package com.xianlianth.app;

import android.app.Activity;
import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintJob;
import android.print.PrintManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/**
 * 打印（2026-10-05）：网页里的 window.print() 在 app 里没反应（安卓的网页控件不带打印），
 * 网站在 app 里打印标签时把要打印的那页 HTML 交过来，这里用安卓自带的打印功能打（选打印机，或者存成 PDF）。
 *
 * 做法照安卓官方文档：另开一个看不见的网页控件装这段 HTML，加载完再交给系统打印。
 * 文档要求打印任务结束前一直拿着这个控件，所以每个任务连同它的控件记在 jobs 里，任务结束（打完 / 取消 / 失败）才销毁。
 * 一次只准备一个：上一个还在加载就点第二下，直接告诉网页「还没弹出来」（dsh 10-05 复审：连点会把上一个的控件丢掉）。
 * 不开脚本：标签 HTML 末尾带一句 window.print()，开了脚本会在这里再触发一次。
 */
@CapacitorPlugin(name = "XtPrint")
public class XtPrintPlugin extends Plugin {

    private static final class Job {
        final PrintJob printJob;
        final WebView view;

        Job(PrintJob printJob, WebView view) {
            this.printJob = printJob;
            this.view = view;
        }
    }

    private final List<Job> jobs = new ArrayList<>();
    private WebView loadingView;
    private long loadingSince;

    @PluginMethod
    public void printHtml(PluginCall call) {
        String html = call.getString("html");
        if (html == null || html.isEmpty()) {
            call.reject("没有要打印的内容");
            return;
        }
        String jobName = call.getString("jobName", "湘泰物流");
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("app 还没准备好，请再点一次");
            return;
        }
        activity.runOnUiThread(() -> {
            if (loadingView != null) {
                // 正常一两百毫秒就加载完；10 秒还没好就当它卡住了，丢掉重来，别让打印永远锁死
                if (System.currentTimeMillis() - loadingSince < 10_000) {
                    call.reject("上一张还在准备打印，请稍等一下");
                    return;
                }
                loadingView.destroy();
                loadingView = null;
            }
            releaseFinishedJobs();
            WebView view = new WebView(activity);
            view.getSettings().setJavaScriptEnabled(false);
            view.setWebViewClient(
                new WebViewClient() {
                    private boolean settled = false;

                    @Override
                    public void onPageFinished(WebView loaded, String url) {
                        if (settled) return;
                        settled = true;
                        if (loadingView == loaded) loadingView = null;
                        try {
                            PrintManager printManager = (PrintManager) activity.getSystemService(Context.PRINT_SERVICE);
                            PrintDocumentAdapter adapter = loaded.createPrintDocumentAdapter(jobName);
                            PrintJob printJob = printManager.print(jobName, adapter, new PrintAttributes.Builder().build());
                            jobs.add(new Job(printJob, loaded));
                            call.resolve();
                        } catch (Exception e) {
                            loaded.destroy();
                            call.reject("这台手机打不开打印：" + e.getMessage());
                        }
                    }

                    @Override
                    public void onReceivedError(WebView failed, WebResourceRequest request, WebResourceError error) {
                        if (settled || !request.isForMainFrame()) return;
                        settled = true;
                        if (loadingView == failed) loadingView = null;
                        failed.destroy();
                        call.reject("要打印的内容没加载出来：" + error.getDescription());
                    }
                }
            );
            loadingView = view;
            loadingSince = System.currentTimeMillis();
            view.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
        });
    }

    /** 已经打完 / 取消 / 失败的任务，把它拿着的那个网页控件销毁 */
    private void releaseFinishedJobs() {
        Iterator<Job> it = jobs.iterator();
        while (it.hasNext()) {
            Job job = it.next();
            if (job.printJob == null || job.printJob.isCompleted() || job.printJob.isCancelled() || job.printJob.isFailed()) {
                job.view.destroy();
                it.remove();
            }
        }
    }

    @Override
    protected void handleOnDestroy() {
        for (Job job : jobs) job.view.destroy();
        jobs.clear();
        if (loadingView != null) {
            loadingView.destroy();
            loadingView = null;
        }
        super.handleOnDestroy();
    }
}
