#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p artifacts
printf 'running\n' > artifacts/node-test.exit
printf 'running\n' > artifacts/android-test.exit
npm test >artifacts/node-test.log 2>&1
code=$?
printf '%s\n' "$code" > artifacts/node-test.exit
if [ "$code" -ne 0 ]; then exit "$code"; fi
ANDROID_HOME="${ANDROID_HOME:-/home/coder/android-sdk}" ./android/gradlew -p android --console=plain assembleDebug testDebugUnitTest lintDebug >artifacts/android-test.log 2>&1
code=$?
printf '%s\n' "$code" > artifacts/android-test.exit
exit "$code"
