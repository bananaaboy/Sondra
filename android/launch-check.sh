#!/usr/bin/env bash
# Sondra for Android on a real Android: installed, started from its icon, a
# shortcut, a link, a share and the way back from the Google sign-in — none
# of it may crash, each must reach the right address. A missing manifest entry once crashed every start, and
# neither lint nor the build noticed.
#
# The Android workflow runs it on an emulator, with the internet the page
# needs; by hand, with an emulator or a phone attached:
#   bash android/launch-check.sh <folder with the APK> [<folder for pictures>]
set -euo pipefail

pkg=ch.lizge.sondra
# The APK built for the device's processor (the workflow makes one per
# processor and a universal one); without one, the universal APK.
abi="$(adb shell getprop ro.product.cpu.abi | tr -d '\r')"
apk="$(ls "$1"/Sondra-Android-*-"$abi".apk 2>/dev/null | head -1 || true)"
[ -n "$apk" ] || apk="$(ls "$1"/Sondra-Android-*.apk 2>/dev/null | grep -Ev -- '-(arm64-v8a|armeabi-v7a|x86_64)\.apk$' | head -1 || true)"
[ -n "$apk" ] || apk="$1/app-release.apk"
echo "Installiere $apk ($abi)"
shots="${2:-}"
adb install -r "$apk" > /dev/null

fail() {
  echo "::error::$1"
  adb logcat -d > /tmp/sondra-logcat.txt || true
  grep -E "FATAL EXCEPTION|AndroidRuntime|SondraApp|chromium" /tmp/sondra-logcat.txt | tail -40 || true
  exit 1
}

# Starts with a clean log and waits until the app logs <expect> (MainActivity
# and Bridge write „SondraApp: …“), then ten seconds more; a crash at any
# point fails the check.
check() {
  local name="$1" expect="$2"
  shift 2
  adb logcat -c
  adb shell am start "$@" > /dev/null
  local seen="" settled=0 log
  for _ in $(seq 1 120); do
    # Read once, then search: "adb logcat | grep -q" under pipefail fails
    # when grep stops early, and a crash would go unseen.
    log="$(adb logcat -d)"
    grep -q "Process: $pkg, PID" <<< "$log" && fail "$name: Sondra ist abgestürzt"
    if [ -z "$seen" ]; then
      seen="$(grep -oF "SondraApp: $expect" <<< "$log" | head -1 || true)"
    elif [ "$settled" -ge 10 ]; then
      break
    else
      settled=$((settled + 1))
    fi
    sleep 1
  done
  [ -n "$seen" ] || fail "$name: nicht erreicht ($expect)"
  echo "$name: $seen"
}

main=(-n "$pkg/.MainActivity")

check "Symbol" "Seite geladen: https://sondra.lizge.ch/" \
  -a android.intent.action.MAIN -c android.intent.category.LAUNCHER "${main[@]}"
# The page found the app's bridge (it reports its theme on load).
log="$(adb logcat -d)"
grep -q "SondraApp: Seite verbunden" <<< "$log" || fail "Symbol: die Seite spricht nicht mit der App"
echo "Symbol: die Seite spricht mit der App"
if [ -n "$shots" ]; then
  mkdir -p "$shots"
  adb exec-out screencap -p > "$shots/start.png"
fi

# Android starts a static shortcut with NEW_TASK | CLEAR_TASK; Sondra stays
# open and only switches the tool.
check "Kurzbefehl Ordner" "Adresse: https://sondra.lizge.ch/#ordner" \
  -a android.intent.action.VIEW -f 0x10008000 -d "https://sondra.lizge.ch/#ordner" -n "$pkg/.ShortcutActivity"
if [ -n "$shots" ]; then
  sleep 5
  adb exec-out screencap -p > "$shots/ordner.png"
fi

check "Link auf die Seite" "Adresse: https://sondra.lizge.ch/#abspielen" \
  -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d "https://sondra.lizge.ch/#abspielen" "${main[@]}"

# A share of a file the app cannot read: taken without a crash, the page gets told.
check "Teilen" "Geteilt oder geöffnet: 1 Datei(en)" \
  -a android.intent.action.SEND -t video/mp4 --eu android.intent.extra.STREAM "content://media/external/video/media/999999" "${main[@]}"

# The browser's way back after the Google sign-in: Sondra comes to the front, nothing else.
check "Zurück von Google" "Zurück von der Anmeldung bei Google" \
  -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d "ch.lizge.sondra://angemeldet?state=app.probe\&code=probe"

# Cold again, with the page's state gone: the start must still hold.
adb shell am force-stop "$pkg"
check "Neustart" "Seite geladen: https://sondra.lizge.ch/" \
  -a android.intent.action.MAIN -c android.intent.category.LAUNCHER "${main[@]}"
echo "Sondra startet ohne Absturz."
