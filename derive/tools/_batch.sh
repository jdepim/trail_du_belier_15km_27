for a in "$@"; do node tools/shot.mjs "tools/render-preview.html?at=$a&freeze" /tmp/claude-0/s/$a.png 1266 584 300 1 2>&1 | grep -v saved; done
