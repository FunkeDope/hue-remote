#!/usr/bin/env bash
# Builds android/build/hue-remote.apk with the Android tools Debian/Ubuntu package.
# No Gradle or Android Studio needed. On Ubuntu/WSL, install them once:
#
#   sudo apt install openjdk-21-jdk-headless zip android-sdk-platform-23 aapt dalvik-exchange zipalign apksigner
#
# The UI comes from ../web, the same files the Node server serves.
# Signing defaults to ~/.android/debug.keystore (created on first run); point
# KEYSTORE / KEYSTORE_PASS / KEY_ALIAS at your own key to override.
set -euo pipefail
cd "$(dirname "$0")"

ANDROID_JAR=${ANDROID_JAR:-/usr/lib/android-sdk/platforms/android-23/android.jar}
KEYSTORE=${KEYSTORE:-$HOME/.android/debug.keystore}
export KEYSTORE_PASS=${KEYSTORE_PASS:-android} # read by apksigner via env:
KEY_ALIAS=${KEY_ALIAS:-androiddebugkey}
OUT=build

for tool in aapt2 javac dalvik-exchange zip zipalign apksigner keytool; do
  command -v "$tool" >/dev/null || { echo "missing: $tool (see the apt line at the top of this script)" >&2; exit 1; }
done
[ -f "$ANDROID_JAR" ] || { echo "missing: $ANDROID_JAR (apt install android-sdk-platform-23)" >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes"

echo "> resources"
aapt2 compile --dir res -o "$OUT/res.zip"
aapt2 link "$OUT/res.zip" -I "$ANDROID_JAR" --manifest AndroidManifest.xml -A ../web \
  --java "$OUT/gen" -o "$OUT/unsigned.apk"

echo "> java"
# Java 8 bytecode: dx can't read newer class files.
javac -Xlint:-options --release 8 -classpath "$ANDROID_JAR" -d "$OUT/classes" \
  $(find src "$OUT/gen" -name '*.java')

echo "> dex"
dalvik-exchange --dex --min-sdk-version=21 --output="$OUT/classes.dex" "$OUT/classes"
(cd "$OUT" && zip -q unsigned.apk classes.dex)

echo "> sign"
zipalign -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  keytool -genkeypair -keystore "$KEYSTORE" -storepass "$KEYSTORE_PASS" -keypass "$KEYSTORE_PASS" \
    -alias "$KEY_ALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US" >/dev/null
fi
apksigner sign --ks "$KEYSTORE" --ks-key-alias "$KEY_ALIAS" \
  --ks-pass env:KEYSTORE_PASS --key-pass env:KEYSTORE_PASS \
  --out "$OUT/hue-remote.apk" "$OUT/aligned.apk"
apksigner verify "$OUT/hue-remote.apk"

echo "built $OUT/hue-remote.apk ($(du -k "$OUT/hue-remote.apk" | cut -f1) KB)"
