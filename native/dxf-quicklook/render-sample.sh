#!/usr/bin/env bash
# Renders a DXF to a PNG through the same DxfRender path the Quick Look
# extension uses, so the thumbnail output can be inspected without registering
# the extension. Mirrors `cargo run --example render_sample` on Windows.
#
#   ./render-sample.sh [input.dxf] [out.png] [size]
set -euo pipefail
cd "$(dirname "$0")"

TARGET="aarch64-apple-darwin"
LIB_DIR="ffi/target/${TARGET}/release"

cargo build --release --target "$TARGET" --manifest-path ffi/Cargo.toml >/dev/null

BIN="build/render_sample"
mkdir -p build
xcrun swiftc \
  -parse-as-library \
  -O \
  -target "arm64-apple-macos11" \
  -sdk "$(xcrun --show-sdk-path)" \
  -import-objc-header Sources/bridging.h \
  -framework Foundation -framework CoreGraphics -framework ImageIO \
  -L "$LIB_DIR" -ldxf_quicklook_ffi \
  -o "$BIN" \
  Sources/DxfRender.swift Sources/render_sample.swift

exec "$BIN" "$@"
