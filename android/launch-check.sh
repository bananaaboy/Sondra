#!/usr/bin/env bash
# Sondra for Android on a real Android: installed, started as from its icon
# and from a shortcut, and neither may crash. A missing manifest entry once
# crashed every start (LauncherActivity switches ManageDataLauncherActivity
# on and off), and neither lint nor the build noticed.
#
# The Android workflow runs it on an emulator; by hand, with an emulator or a
# phone attached:  bash android/launch-check.sh <folder with the APK>
set -euo pipefail

pkg=ch.lizge.sondra
apk="$(ls "$1"/Sondra-Android-*.apk 2>/dev/null | head -1 || true)"
[ -n "$apk" ] || apk="$1/app-release.apk"
adb install -r "$apk" > /dev/null

# Starts with a clean log, waits until the launcher says which address it
# opens, then a little longer; a crash at any point fails the check.
check() {
  local name="$1" expect="$2"
  shift 2
  adb logcat -c
  adb shell am start "$@" > /dev/null
  local seen=""
  for _ in $(seq 1 60); do
    if adb logcat -d | grep -q "Process: $pkg, PID"; then
      echo "::error::$name: Sondra ist abgestürzt"
      adb logcat -d | grep -A30 "FATAL EXCEPTION"
      exit 1
    fi
    if [ -z "$seen" ]; then
      seen="$(adb logcat -d -s TWALauncherActivity:D | grep -o "Using url from [A-Za-z]*: .*" | head -1 || true)"
    elif [ "${settled:-0}" -ge 10 ]; then
      break
    else
      settled=$(( ${settled:-0} + 1 ))
    fi
    sleep 1
  done
  settled=0
  if [ -z "$seen" ]; then
    echo "::error::$name: Sondra hat nichts geöffnet"
    adb logcat -d | tail -40
    exit 1
  fi
  if ! echo "$seen" | grep -qF "$expect"; then
    echo "::error::$name: erwartet $expect, geöffnet: $seen"
    exit 1
  fi
  echo "$name: $seen"
  adb shell am force-stop "$pkg"
}

check "Symbol" "https://sondra.lizge.ch/#merkliste" \
  -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n "$pkg/com.google.androidbrowserhelper.trusted.LauncherActivity"
check "Kurzbefehl Ordner" "https://sondra.lizge.ch/#ordner" \
  -a android.intent.action.VIEW -d "https://sondra.lizge.ch/#ordner" -f 0x10008000 \
  -n "$pkg/com.google.androidbrowserhelper.trusted.ShortcutTrampolineActivity"
check "Link auf die Seite" "https://sondra.lizge.ch/#abspielen" \
  -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d "https://sondra.lizge.ch/#abspielen" -n "$pkg/com.google.androidbrowserhelper.trusted.LauncherActivity"
echo "Sondra startet ohne Absturz."
