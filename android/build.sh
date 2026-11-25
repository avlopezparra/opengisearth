#!/usr/bin/env bash
# Builds the OpenStarshipEarth Android app (a WebView on the game) without Gradle: resources, Java, dex, align, sign.
# Needs a JDK 17+ and the Android SDK (platform 34, build-tools 34.0.0); the signing key stays outside the repository.
#   SDK=D:/mhtc/android/sdk JAVA_HOME=D:/mhtc/android/jdk17 KEYS=D:/mhtc/android/keys bash build.sh
set -euo pipefail
cd "$(dirname "$0")"
SDK="${SDK:-D:/mhtc/android/sdk}"; JAVA_HOME="${JAVA_HOME:-D:/mhtc/android/jdk17}"; KEYS="${KEYS:-D:/mhtc/android/keys}"
BT="$SDK/build-tools/34.0.0"; JAR="$SDK/platforms/android-34/android.jar"; PKG=com/opengisearth/starship
VERSION=$(sed -n 's/.*android:versionName="\([^"]*\)".*/\1/p' AndroidManifest.xml)
export JAVA_HOME PATH="$JAVA_HOME/bin:$PATH"
rm -rf build && mkdir -p build/gen build/classes build/dex
"$BT/aapt2" compile --dir res -o build/res.zip
"$BT/aapt2" link -o build/unsigned.apk -I "$JAR" --manifest AndroidManifest.xml --java build/gen build/res.zip
javac -source 8 -target 8 -Xlint:-options -cp "$JAR" -d build/classes "src/$PKG/MainActivity.java" "build/gen/$PKG/R.java"
"$BT/d8.bat" --release --min-api 24 --lib "$JAR" --output build/dex build/classes/$PKG/*.class
(cd build/dex && "$BT/aapt" add ../unsigned.apk classes.dex >/dev/null)
"$BT/zipalign" -f 4 build/unsigned.apk build/aligned.apk
OUT="build/OpenStarshipEarth-v$VERSION-android.apk"
"$BT/apksigner.bat" sign --ks "$KEYS/opengisearth-release.jks" --ks-pass "file:$KEYS/opengisearth-release.pass" --out "$OUT" build/aligned.apk
"$BT/apksigner.bat" verify --print-certs "$OUT" | head -3
ls -la "$OUT"
