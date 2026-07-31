#!/usr/bin/env python3
import sys
import lottie
from PIL import features

# lottie's WebP exporter guards on features.check("webp_anim"), but Pillow 12
# removed that feature name — the check now fails on builds that write animated
# WebP perfectly well. Report it as present and let the real save succeed or raise.
_check = features.check
features.check = lambda name: True if name == "webp_anim" else _check(name)

from lottie.exporters.gif import export_webp  # noqa: E402  (import after the patch)

if len(sys.argv) != 3:
    print("Usage: tgs_to_webp.py <input.tgs> <output.webp>", file=sys.stderr)
    sys.exit(1)

with open(sys.argv[1], "rb") as f:
    animation = lottie.parsers.tgs.parse_tgs(f)

export_webp(animation, sys.argv[2])
