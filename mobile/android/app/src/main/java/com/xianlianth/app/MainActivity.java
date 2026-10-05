package com.xianlianth.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 自己写的原生功能要在 super.onCreate 之前登记（Capacitor 的规矩）
        registerPlugin(XtPrintPlugin.class);
        super.onCreate(savedInstanceState);
        // 上传图片时「拍照 / 相册」都能选（见 XtWebChromeClient）；其余行为照 Capacitor 原来的
        bridge.getWebView().setWebChromeClient(new XtWebChromeClient(bridge));
    }
}
