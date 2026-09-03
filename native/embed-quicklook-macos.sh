#!/usr/bin/env bash
# Embeds the DXF Quick Look thumbnail extension into a built Sketchor.app.
# Tauri 2 cannot bundle a macOS .appex and has no post-bundle hook, so this
# runs AFTER `tauri build`. It copies the extension into Contents/PlugIns/,
# signs it, then re-signs the whole app so the nested code seals correctly.
#
#   ./embed-quicklook-macos.sh /path/to/Sketchor.app [--sign "Developer ID Application: ..."]
#
# Default signing is ad-hoc (-), enough for local Finder/Quick Look testing on
# this machine. For distribution, pass a Developer ID identity (and notarize +
# rebuild the DMG separately).
set -euo pipefail

APP="${1:-}"
if [[ -z "$APP" || ! -d "$APP" ]]; then
  echo "usage: $0 /path/to/Sketchor.app [--sign IDENTITY]" >&2
  exit 1
fi

SIGN_ID="-"
if [[ "${2:-}" == "--sign" && -n "${3:-}" ]]; then
  SIGN_ID="$3"
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
APPEX="${HERE}/dxf-quicklook/build/DxfThumbnail.appex"
if [[ ! -d "$APPEX" ]]; then
  echo "==> Extension not built yet; running build-quicklook-macos.sh"
  "${HERE}/dxf-quicklook/build-quicklook-macos.sh" ${SIGN_ID:+--sign "$SIGN_ID"}
fi

PLUGINS="${APP}/Contents/PlugIns"
echo "==> Embedding $(basename "$APPEX") into ${PLUGINS}"
mkdir -p "$PLUGINS"
rm -rf "${PLUGINS}/DxfThumbnail.appex"
cp -R "$APPEX" "${PLUGINS}/"

echo "==> Signing embedded extension (${SIGN_ID})"
codesign --force --timestamp=none \
  --sign "$SIGN_ID" \
  --entitlements "${HERE}/dxf-quicklook/ext.entitlements" \
  "${PLUGINS}/DxfThumbnail.appex"

echo "==> Re-signing app with hardened runtime (${SIGN_ID})"
# Hardened runtime is required for notarization; harmless for local ad-hoc.
codesign --force --timestamp=none --options runtime \
  --sign "$SIGN_ID" \
  "$APP"

echo "==> Verifying nested signature"
codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | sed 's/^/    /' || true

cat <<EOF

Embedded. To test:
  1) Move "$APP" to /Applications (Launch Services registers the extension and
     the exported com.sketchor.dxf UTI), or run:
       pluginkit -a "${PLUGINS}/DxfThumbnail.appex"
  2) pluginkit -mAvvv -p com.apple.quicklook.thumbnail | grep -i sketchor
  3) mdls -name kMDItemContentType some.dxf   # must print com.sketchor.dxf
  4) qlmanage -r && qlmanage -r cache
  5) qlmanage -t -s 512 -o /tmp some.dxf       # inspect /tmp/some.dxf.png
  6) Open a folder of .dxf in Finder gallery/icon view.
EOF
