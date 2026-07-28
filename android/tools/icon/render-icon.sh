#!/usr/bin/env bash
# Rasterises the adaptive-icon foreground into every density bucket.
# VectorDrawable has no <text> element and the snapdoc logo is a typed glyph,
# so the PNGs are generated once from a pinned font and committed. Re-run only
# when the source SVG changes.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
res="$(cd "$here/../../app/src/main/res" && pwd)"
src="$here/ic_launcher_foreground.svg"

# mdpi is the 108dp baseline; the rest are the standard density multipliers.
declare -A sizes=([mdpi]=108 [hdpi]=162 [xhdpi]=216 [xxhdpi]=324 [xxxhdpi]=432)

for density in "${!sizes[@]}"; do
  size="${sizes[$density]}"
  out="$res/mipmap-$density"
  mkdir -p "$out"
  if command -v rsvg-convert >/dev/null 2>&1; then
    rsvg-convert --width "$size" --height "$size" --output "$out/ic_launcher_foreground.png" "$src"
  else
    magick -background none -density "$(( size * 96 / 108 ))" "$src" -resize "${size}x${size}" "$out/ic_launcher_foreground.png"
  fi
  printf 'wrote %s (%spx)\n' "$out/ic_launcher_foreground.png" "$size"
done
