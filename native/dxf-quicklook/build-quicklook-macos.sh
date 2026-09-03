#!/usr/bin/env bash
# Builds the macOS Quick Look thumbnail extension (DxfThumbnail.appex) for DXF
# files, without Xcode — just the Rust toolchain, swiftc, and codesign from the
# Command Line Tools. Mirrors native/build-shell-extensions.ps1 on Windows.
#
# Output: native/dxf-quicklook/build/DxfThumbnail.appex (ad-hoc signed).
# Embed it into Sketchor.app with native/embed-quicklook-macos.sh.
#
#   ./build-quicklook-macos.sh [--sign "Developer ID Application: ..."]
#
# Default signing is ad-hoc (-), enough for local testing on this machine.
set -euo pipefail

cd "$(dirname "$0")"
HERE="$(pwd)"

SIGN_ID="-"
if [[ "${1:-}" == "--sign" && -n "${2:-}" ]]; then
  SIGN_ID="$2"
fi

TARGET="aarch64-apple-darwin"          # arm64 only for now; lipo for universal later
SWIFT_TARGET="arm64-apple-macos11"
NAME="DxfThumbnail"
APPEX="build/${NAME}.appex"

echo "==> Building Rust FFI static lib ($TARGET)"
cargo build --release --target "$TARGET" --manifest-path ffi/Cargo.toml
LIB_DIR="ffi/target/${TARGET}/release"

echo "==> Assembling ${APPEX}"
rm -rf "$APPEX"
mkdir -p "${APPEX}/Contents/MacOS"
cp Info.plist "${APPEX}/Contents/Info.plist"

echo "==> Compiling Swift extension"
# App extensions have no main() of their own: the entry point is
# _NSExtensionMain (provided by Foundation), and -parse-as-library stops swiftc
# from expecting a top-level main.
xcrun swiftc \
  -parse-as-library \
  -O \
  -target "$SWIFT_TARGET" \
  -sdk "$(xcrun --show-sdk-path)" \
  -import-objc-header Sources/bridging.h \
  -framework Foundation \
  -framework CoreGraphics \
  -framework QuickLookThumbnailing \
  -L "$LIB_DIR" -ldxf_quicklook_ffi \
  -Xlinker -e -Xlinker _NSExtensionMain \
  -o "${APPEX}/Contents/MacOS/${NAME}" \
  Sources/DxfRender.swift Sources/ThumbnailProvider.swift

echo "==> Signing (${SIGN_ID})"
codesign --force --timestamp=none \
  --sign "$SIGN_ID" \
  --entitlements ext.entitlements \
  "$APPEX"

echo "==> Done: ${HERE}/${APPEX}"
codesign -dvv "$APPEX" 2>&1 | sed 's/^/    /' || true
