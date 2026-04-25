#!/usr/bin/env bash
# Smoke-test the freshly-built debug APK on a running Android emulator.
# Run by .github/workflows/android.yml under reactivecircus/android-emulator-runner.
#
# - Argument: directory containing the artifact tree from the
#   upload-artifact step (default: ./apk).
# - Exits 0 if the app is alive 8 seconds after launch.
# - Exits non-zero with a diagnostic dump otherwise.
set -e

ARTIFACT_DIR="${1:-apk}"
PKG="com.goldinkollar.nexus.debug"
ACTIVITY="com.goldinkollar.nexus.MainActivity"

APK=$(find "$ARTIFACT_DIR" -name 'nexus-*.apk' -type f | head -1)
if [ -z "$APK" ]; then
  echo "::error::No APK found under $ARTIFACT_DIR/. Tree:"
  find "$ARTIFACT_DIR" -type f
  exit 1
fi

echo "::group::Installing $APK"
adb install -r "$APK"
echo "::endgroup::"

echo "::group::Clearing logcat"
adb logcat -c
echo "::endgroup::"

echo "::group::Launching $ACTIVITY"
adb shell am start -W -n "$PKG/$ACTIVITY"
echo "::endgroup::"

# Give the app 8 seconds to either render or crash.
sleep 8

echo "::group::logcat (filtered)"
adb logcat -d -t 1000 \
  AndroidRuntime:E \
  SentryInitializer:* \
  NexusApp:* \
  MainActivity:* \
  CrashRecorder:* \
  SessionStore:* \
  '*:F' \
  | head -300
echo "::endgroup::"

PID=$(adb shell pidof "$PKG" || echo "")
if [ -z "$PID" ]; then
  echo "::error::Nexus process died within 8 seconds"
  echo "::group::Full logcat dump (last 500 lines)"
  adb logcat -d -t 500 | tail -300
  echo "::endgroup::"
  echo "::group::CrashRecorder report"
  adb shell run-as "$PKG" cat "/data/data/$PKG/files/last-crash.txt" 2>/dev/null \
    || echo "(no last-crash.txt — process probably died before CrashRecorder could write)"
  echo "::endgroup::"
  exit 1
fi
echo "::notice::Nexus is alive after 8 seconds (pid=$PID)"

echo "::group::CrashRecorder report (if any)"
adb shell run-as "$PKG" cat "/data/data/$PKG/files/last-crash.txt" 2>/dev/null \
  || echo "(no last-crash.txt — clean launch)"
echo "::endgroup::"
