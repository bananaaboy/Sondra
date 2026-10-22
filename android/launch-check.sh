#!/usr/bin/env bash
# Sondra for Android on a real Android: installed, started as from its icon,
# from a shortcut and from a link, and none of it may crash. A missing
# manifest entry once crashed every start (LauncherActivity switches
# ManageDataLauncherActivity on and off), and neither lint nor the build
# noticed.
#
# The Android workflow runs it on an emulator; by hand, with an emulator or a
# phone attached:  bash android/launch-check.sh <folder with the APK>
set -euo pipefail

pkg=ch.lizge.sondra
apk="$(ls "$1"/Sondra-Android-*.apk 2>/dev/null | head -1 || true)"
[ -n "$apk" ] || apk="$1/app-release.apk"
adb install -r "$apk" > /dev/null

fail() {
  echo "::error::$1"
  adb logcat -d > /tmp/sondra-logcat.txt || true
  grep -E "FATAL EXCEPTION|AndroidRuntime|ShortcutTrampoline|TWALauncherActivity|TWAProviderPicker|ActivityTaskManager: START" /tmp/sondra-logcat.txt | tail -40 || true
  exit 1
}

# Starts with a clean log and waits for the sign that Sondra handed the
# address on, then ten seconds more; a crash at any point fails the check.
#   launcher <url>  the launcher says which address it opens (a cold start)
#   chrome          Chrome is started with this site (a TWA already running:
#                   the shortcut goes straight to it, no launcher involved)
check() {
  local name="$1" kind="$2" expect="$3"
  shift 3
  adb logcat -c
  adb shell am start "$@" > /dev/null
  local seen="" settled=0
  local log
  for _ in $(seq 1 90); do
    # Read once, then search: "adb logcat | grep -q" under pipefail fails
    # when grep stops early, and a crash would go unseen.
    log="$(adb logcat -d)"
    grep -q "Process: $pkg, PID" <<< "$log" && fail "$name: Sondra ist abgestürzt"
    grep -q "Dropping untrusted" <<< "$log" && fail "$name: Adresse abgelehnt"
    if [ -z "$seen" ]; then
      if [ "$kind" = launcher ]; then
        seen="$(grep -o "TWALauncherActivity: Using url from [A-Za-z]*: .*" <<< "$log" | head -1 || true)"
      else
        seen="$(grep -o "START u0 {act=android.intent.action.VIEW dat=https://sondra.lizge.ch[^ ]* .*cmp=com.android.chrome/[^ }]*" <<< "$log" | head -1 || true)"
      fi
    elif [ "$settled" -ge 10 ]; then
      break
    else
      settled=$((settled + 1))
    fi
    sleep 1
  done
  [ -n "$seen" ] || fail "$name: Sondra hat nichts geöffnet"
  echo "$seen" | grep -qF "$expect" || fail "$name: erwartet $expect, geöffnet: $seen"
  echo "$name: $seen"
}

launcher=(-n "$pkg/com.google.androidbrowserhelper.trusted.LauncherActivity")
trampoline=(-n "$pkg/com.google.androidbrowserhelper.trusted.ShortcutTrampolineActivity")
# Android starts a static shortcut with NEW_TASK | CLEAR_TASK.
shortcut=(-a android.intent.action.VIEW -f 0x10008000)

# Cold: no task of Sondra left from the check before.
adb shell pm clear "$pkg" > /dev/null
check "Symbol" launcher "https://sondra.lizge.ch/#merkliste" \
  -a android.intent.action.MAIN -c android.intent.category.LAUNCHER "${launcher[@]}"
check "Kurzbefehl, Sondra läuft" chrome "cmp=com.android.chrome" \
  "${shortcut[@]}" -d "https://sondra.lizge.ch/#ordner" "${trampoline[@]}"

adb shell pm clear "$pkg" > /dev/null
check "Kurzbefehl, kalt" launcher "https://sondra.lizge.ch/#ordner" \
  "${shortcut[@]}" -d "https://sondra.lizge.ch/#ordner" "${trampoline[@]}"

adb shell pm clear "$pkg" > /dev/null
check "Link auf die Seite" launcher "https://sondra.lizge.ch/#abspielen" \
  -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d "https://sondra.lizge.ch/#abspielen" "${launcher[@]}"
echo "Sondra startet ohne Absturz."
