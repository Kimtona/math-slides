#!/usr/bin/env bash
# Verifies a MathSlides macOS release candidate (used by the release workflow and for local checks).
#
#   scripts/verify-macos-release.sh <MathSlides-X.Y.Z-arm64.dmg> <X.Y.Z> [SHA256SUMS]
#
# Checks: checksum, DMG layout (Applications shortcut), bundle metadata, a VALID ad-hoc code signature
# (the app is deliberately not Developer-ID signed or notarized), the Gatekeeper assessment of a quarantined copy,
# and that the app launches. It never removes quarantine from anything and never touches your real MathSlides data.
set -euo pipefail

DMG="${1:?usage: verify-macos-release.sh <dmg> <version> [SHA256SUMS]}"
VERSION="${2:?usage: verify-macos-release.sh <dmg> <version> [SHA256SUMS]}"
SUMS="${3:-}"
abspath() { echo "$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; }
DMG="$(abspath "$DMG")"
[ -n "$SUMS" ] && SUMS="$(abspath "$SUMS")"

work="$(mktemp -d "${TMPDIR:-/tmp}/mathslides-verify.XXXXXX")"
mnt="$work/mnt"
mkdir -p "$mnt" "$work/app" "$work/quarantined"
pid=""
cleanup() {
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  hdiutil detach "$mnt" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

fail() { [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error::$*"; echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

# ---- checksum -------------------------------------------------------------------------------------------------
if [ -n "$SUMS" ]; then
  ( cd "$(dirname "$DMG")" && shasum -a 256 -c "$SUMS" ) >/dev/null 2>&1 || fail "SHA-256 of $(basename "$DMG") does not match $SUMS"
  grep -q "  $(basename "$DMG")\$" "$SUMS" || fail "$SUMS has no entry for $(basename "$DMG")"
  ok "checksum matches $(basename "$SUMS")"
fi

# ---- DMG layout -----------------------------------------------------------------------------------------------
hdiutil attach -readonly -nobrowse -noverify -noautoopen -mountpoint "$mnt" "$DMG" >/dev/null
[ -d "$mnt/MathSlides.app" ] || fail "MathSlides.app is missing from the DMG"
[ -L "$mnt/Applications" ] && [ "$(readlink "$mnt/Applications")" = "/Applications" ] || fail "DMG has no Applications shortcut"
visible="$(ls "$mnt" | sort | tr '\n' ' ')"
[ "$visible" = "Applications MathSlides.app " ] || fail "Unexpected visible items in the DMG: $visible"
ok "DMG shows MathSlides.app and an Applications shortcut"

ditto "$mnt/MathSlides.app" "$work/app/MathSlides.app"
app="$work/app/MathSlides.app"
plist="$app/Contents/Info.plist"
pb() { /usr/libexec/PlistBuddy -c "Print :$1" "$plist"; }

# ---- bundle metadata ------------------------------------------------------------------------------------------
[ "$(pb CFBundleShortVersionString)" = "$VERSION" ] || fail "Bundle version is $(pb CFBundleShortVersionString), expected $VERSION"
[ "$(pb CFBundleIdentifier)" = "com.mathslides.app" ] || fail "Unexpected bundle identifier $(pb CFBundleIdentifier)"
[ "$(lipo -archs "$app/Contents/MacOS/MathSlides")" = "arm64" ] || fail "Executable is not arm64-only"
[ "$(pb LSMinimumSystemVersion)" = "13.0" ] || fail "Minimum macOS is $(pb LSMinimumSystemVersion), expected 13.0"
[ -f "$app/Contents/Resources/$(pb CFBundleIconFile)" ] || fail "App icon missing"
[ -f "$app/Contents/Resources/mslides.icns" ] || fail "Document icon missing"
plutil -p "$plist" | grep -q '"mslides"' || fail ".mslides document type missing"
plutil -p "$plist" | grep -q 'com.mathslides.presentation' || fail "com.mathslides.presentation UTI missing"
plutil -p "$plist" | grep -q 'public.data' || fail "UTI does not conform to public.data"
ok "bundle: version $VERSION, com.mathslides.app, arm64, macOS 13+, icons, .mslides association"

# ---- code signature: must be a VALID, sealed ad-hoc signature (and honestly nothing more) ------------------------
codesign --verify --deep --strict --verbose=2 "$app" >"$work/verify.log" 2>&1 || { cat "$work/verify.log" >&2; fail "codesign --verify --deep --strict failed: the app bundle signature is invalid"; }
info="$(codesign -dvv "$app" 2>&1)"
echo "$info" | grep -q '^Identifier=com.mathslides.app$' || fail "Signature identifier is not com.mathslides.app (a stale Electron signature?)"
echo "$info" | grep -q '^Signature=adhoc$' || fail "Signature is not ad-hoc"
echo "$info" | grep -q '^TeamIdentifier=not set$' || fail "Unexpected Team Identifier (this build must not pretend to be Developer-ID signed)"
echo "$info" | grep -q '^Sealed Resources version=' || fail "Bundle resources are not sealed by the signature"
echo "$info" | grep -q '^Info.plist entries=' || fail "Info.plist is not bound by the signature"
echo "$info" | grep -q '^Authority=' && fail "Unexpected signing authority: this build must be ad-hoc only"
echo "$info" | grep -q 'flags=.*runtime' && fail "Hardened runtime is on; ad-hoc builds need it off (library validation rejects Electron's frameworks)"
bad=0
while IFS= read -r nested; do
  codesign --verify --strict "$nested" >/dev/null 2>&1 || { echo "invalid signature: $nested" >&2; bad=1; }
done < <(find "$app/Contents/Frameworks" -maxdepth 1 \( -name '*.app' -o -name '*.framework' \))
[ "$bad" = 0 ] || fail "A nested helper or framework has an invalid signature"
ok "code signature: valid ad-hoc, identifier com.mathslides.app, resources sealed, nested helpers valid, no hardened runtime"

# ---- Gatekeeper assessment of a quarantined copy (what a browser download looks like) ------------------------------
# The copy is only used for this assessment; nothing here removes or bypasses quarantine.
if spctl --status 2>&1 | grep -q 'assessments disabled'; then
  echo "note: Gatekeeper assessments are disabled on this machine; skipping the quarantined-copy assessment"
else
  q="$work/quarantined/MathSlides.app"
  ditto "$app" "$q"
  xattr -w com.apple.quarantine "0083;$(printf '%x' "$(date +%s)");Safari;$(uuidgen)" "$q"
  out="$(spctl --assess --type execute --verbose=4 "$q" 2>&1 || true)"
  echo "$out" | grep -q 'rejected' || fail "Expected the normal 'rejected' (not notarized) assessment, got: $out"
  echo "$out" | grep -qiE 'no resources|invalid|sealed resource|damaged|not valid' && fail "Gatekeeper reports a broken signature: $out"
  ok "quarantined copy gets the ordinary not-notarized rejection (Open Anyway path), not a broken-signature error"
fi

# ---- launch smoke test: the app must stay alive with a throwaway profile ------------------------------------------
MATHSLIDES_TEST_HIDDEN=1 "$app/Contents/MacOS/MathSlides" --user-data-dir="$work/profile" >"$work/launch.log" 2>&1 &
pid=$!
sleep 8
if ! kill -0 "$pid" 2>/dev/null; then
  cat "$work/launch.log" || true
  fail "MathSlides exited within 8 seconds of launch"
fi
ok "launch: still running after 8 seconds with a throwaway profile"

echo "$info" | grep -E '^(Identifier|Signature|TeamIdentifier|Sealed Resources|CodeDirectory)' | sed 's/^/  /'
echo "  sha256 $(shasum -a 256 "$DMG" | cut -d' ' -f1)"
echo "PASS: $(basename "$DMG") verified"
