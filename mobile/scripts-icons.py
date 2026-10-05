# 用网站现有的公司标志（apps/web/src/app/icon.png，256×256 透明底红圈 X.T）生成安卓图标和启动图。
# 重跑：python3 scripts-icons.py（要 Pillow）
from PIL import Image
import os, glob
RES = "android/app/src/main/res"
logo = Image.open("assets/logo.png").convert("RGBA")
BG = (250, 250, 248, 255)  # 网站页面底色 #fafaf8

def fit(size, ratio):
    s = round(size * ratio)
    return logo.resize((s, s), Image.LANCZOS)

def on_canvas(size, ratio, bg):
    canvas = Image.new("RGBA", (size, size), bg)
    l = fit(size, ratio)
    canvas.alpha_composite(l, ((size - l.width) // 2, (size - l.height) // 2))
    return canvas

legacy = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
for d, px in legacy.items():
    out = f"{RES}/mipmap-{d}"
    # 老手机（安卓 8 以前）直接用这张：白底方块 + 标志
    on_canvas(px, 0.9, (255, 255, 255, 255)).convert("RGB").save(f"{out}/ic_launcher.png")
    # 圆形图标：标志本身就是圆的，透明底直接放
    fit(px, 1.0).save(f"{out}/ic_launcher_round.png")
    # 安卓 8 起的自适应图标前景：108dp 的画布，系统会裁掉外圈，标志放在中间 66dp 的安全区里
    fg = Image.new("RGBA", (px * 108 // 48, px * 108 // 48), (0, 0, 0, 0))
    l = fit(fg.width, 66 / 108)
    fg.alpha_composite(l, ((fg.width - l.width) // 2, (fg.height - l.height) // 2))
    fg.save(f"{out}/ic_launcher_foreground.png")

# 启动图（安卓 12 以前用；12 起系统自己拿图标 + 底色画）：每张保持原尺寸，底色 + 居中标志
for path in glob.glob(f"{RES}/drawable*/splash.png"):
    w, h = Image.open(path).size
    canvas = Image.new("RGBA", (w, h), BG)
    l = fit(min(w, h), 0.28)
    canvas.alpha_composite(l, ((w - l.width) // 2, (h - l.height) // 2))
    canvas.convert("RGB").save(path)
print("ok")
