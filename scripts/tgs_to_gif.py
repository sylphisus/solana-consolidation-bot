#!/usr/bin/env python3
import sys
import lottie
from lottie.exporters import exporters

if len(sys.argv) != 3:
    print("Usage: tgs_to_gif.py <input.tgs> <output.gif>", file=sys.stderr)
    sys.exit(1)

with open(sys.argv[1], "rb") as f:
    animation = lottie.parsers.tgs.parse_tgs(f)

exp = exporters.get("gif")
exp.export(animation, sys.argv[2])
