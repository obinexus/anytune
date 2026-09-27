#!/usr/bin/env bash
# Builds the native fusion harness against a staged Obicall build — in a UCRT64 shell, with the GCC that built Obicall:
#
#   MSYSTEM=UCRT64 /c/msys64/usr/bin/bash.exe -lc "cd /d/Projects/anytune && tools/obicall-native/build.sh [STAGE]"
#
# STAGE defaults to ../obicall-reference/stage-anytune. The harness and a copy of the staged obicall.dll go to .native/ (ignored by git); Obicall's
# checkout is only read.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
stage="$(cd "${1:-$root/../obicall-reference/stage-anytune}" && pwd)"
out="$root/.native"
mkdir -p "$out"
gcc -std=c11 -O2 -Wall -Wextra -Werror -I"$stage/include" "$here/fuse-harness.c" -L"$stage/lib" -lobicall -o "$out/fuse-harness.exe"
cp "$stage/bin/obicall.dll" "$out/obicall.dll"
echo "built $out/fuse-harness.exe ($(gcc --version | head -n 1)) against $stage"
