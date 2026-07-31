#!/usr/bin/env python3
import sys
import lottie
from lottie.exporters.gif import export_gif

# Telegram's TGS canvas is 512x512, which Discord renders as a full-width
# image. Scale before rasterizing so cairo only draws the smaller frames.
SIZE = 160

if len(sys.argv) != 3:
    print("Usage: tgs_to_gif.py <input.tgs> <output.gif>", file=sys.stderr)
    sys.exit(1)

with open(sys.argv[1], "rb") as f:
    animation = lottie.parsers.tgs.parse_tgs(f)

animation.scale(SIZE, SIZE)
export_gif(animation, sys.argv[2])
