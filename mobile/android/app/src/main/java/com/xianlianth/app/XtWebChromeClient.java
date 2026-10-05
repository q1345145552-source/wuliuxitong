package com.xianlianth.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.provider.MediaStore;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.FileProvider;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;
import com.getcapacitor.Logger;
import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * 网页里点「上传图片」时，让人能选「拍照」还是「从相册选」（2026-10-05）。
 *
 * Capacitor 自带的做法是二选一：网页的上传框没写 capture 就只能从相册选，写了就只能拍照；
 * 手机浏览器里这一步是「相机 / 相册」都给。系统里的上传框（客服发图、入库拍照、签收凭证……）都没写 capture，
 * 装成 app 以后就拍不了照了 —— 签收、入库多半是现场拍。这里只改「只收图片、没写 capture」这一种情况：
 * 弹系统的选择框，里面同时有相机和相册；别的（收别的文件、写了 capture）照旧走 Capacitor 原来那套。
 *
 * 不申请相机权限：调系统相机拍照（ACTION_IMAGE_CAPTURE）本身不用 app 有相机权限；
 * 拍的照片先放 app 缓存（res/xml/file_paths.xml 的 cache-path 已放行），交给网页上传。
 */
public class XtWebChromeClient extends BridgeWebChromeClient {

    private final Bridge bridge;
    private final ActivityResultLauncher<Intent> chooserLauncher;
    private ValueCallback<Uri[]> pendingCallback;
    private Uri cameraUri;

    public XtWebChromeClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
        this.chooserLauncher = bridge.registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), (result) -> {
            ValueCallback<Uri[]> callback = pendingCallback;
            pendingCallback = null;
            if (callback == null) return;
            Uri[] picked = null;
            if (result.getResultCode() == Activity.RESULT_OK) {
                Intent data = result.getData();
                List<Uri> uris = new ArrayList<>();
                if (data != null && data.getClipData() != null) {
                    ClipData clip = data.getClipData();
                    for (int i = 0; i < clip.getItemCount(); i++) uris.add(clip.getItemAt(i).getUri());
                } else if (data != null && data.getData() != null) {
                    uris.add(data.getData());
                } else if (cameraUri != null) {
                    // 拍照：相机把照片写进了我们给的文件，返回的 data 是空的
                    uris.add(cameraUri);
                }
                if (!uris.isEmpty()) picked = uris.toArray(new Uri[0]);
            }
            callback.onReceiveValue(picked);
        });
    }

    private static boolean onlyImages(String[] acceptTypes) {
        if (acceptTypes == null || acceptTypes.length == 0) return false;
        boolean any = false;
        for (String type : acceptTypes) {
            for (String part : type.split(",")) {
                String t = part.trim().toLowerCase();
                if (t.isEmpty()) continue;
                any = true;
                if (!(t.startsWith("image/") || t.equals(".jpg") || t.equals(".jpeg") || t.equals(".png") || t.equals(".webp") || t.equals(".heic"))) return false;
            }
        }
        return any;
    }

    @Override
    public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
        if (fileChooserParams.isCaptureEnabled() || !onlyImages(fileChooserParams.getAcceptTypes())) {
            return super.onShowFileChooser(webView, filePathCallback, fileChooserParams);
        }
        if (pendingCallback != null) pendingCallback.onReceiveValue(null);

        Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        pick.setType("image/*");
        if (fileChooserParams.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        Intent chooser = Intent.createChooser(pick, "选择图片");

        cameraUri = null;
        Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        if (camera.resolveActivity(bridge.getActivity().getPackageManager()) != null) {
            try {
                File dir = new File(bridge.getContext().getCacheDir(), "xt-camera");
                if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("建不了拍照临时目录");
                File photo = File.createTempFile("photo_", ".jpg", dir);
                cameraUri = FileProvider.getUriForFile(bridge.getContext(), bridge.getContext().getPackageName() + ".fileprovider", photo);
                camera.putExtra(MediaStore.EXTRA_OUTPUT, cameraUri);
                camera.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[] { camera });
            } catch (Exception e) {
                Logger.warn("拍照入口没加上，只能从相册选：" + e.getMessage());
                cameraUri = null;
            }
        }

        pendingCallback = filePathCallback;
        try {
            chooserLauncher.launch(chooser);
        } catch (Exception e) {
            pendingCallback = null;
            return super.onShowFileChooser(webView, filePathCallback, fileChooserParams);
        }
        return true;
    }
}
