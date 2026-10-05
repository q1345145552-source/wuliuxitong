# 打 app 包用的环境（2026-10-05）：Capacitor 8 要 Java 21；这台 Mac 默认是 17，不改全局，只在打包时指过去
export JAVA_HOME="${XT_JAVA_HOME:-/opt/homebrew/opt/openjdk@21}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
