#!/usr/bin/env python3
"""Render a Telegram .tgs sticker to an animated WebP with transparency.

Uses rlottie (via its C API) for the rendering — python-lottie gets masks and
track mattes wrong on real stickers, and rlottie is what Telegram itself uses.
Only the encoding is done here, because rlottie's own lottie2gif writes GIF,
which composites away the alpha channel and is 1-bit transparent regardless.
"""
import ctypes
import gzip
import sys

import numpy as np
from PIL import Image

lib = ctypes.CDLL("librlottie.so")
lib.lottie_animation_from_data.restype = ctypes.c_void_p
lib.lottie_animation_from_data.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p]
lib.lottie_animation_get_totalframe.restype = ctypes.c_size_t
lib.lottie_animation_get_totalframe.argtypes = [ctypes.c_void_p]
lib.lottie_animation_get_framerate.restype = ctypes.c_double
lib.lottie_animation_get_framerate.argtypes = [ctypes.c_void_p]
lib.lottie_animation_render.argtypes = [
    ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_uint32),
    ctypes.c_size_t, ctypes.c_size_t, ctypes.c_size_t,
]
lib.lottie_animation_destroy.argtypes = [ctypes.c_void_p]

SIZE = 512


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: tgs_to_webp.py <input.tgs> <output.webp>", file=sys.stderr)
        return 1

    with gzip.open(sys.argv[1], "rb") as f:
        data = f.read()

    # rlottie caches by key; the resource path is unused for self-contained stickers
    anim = lib.lottie_animation_from_data(data, b"sticker", b"")
    if not anim:
        print("rlottie failed to parse the animation", file=sys.stderr)
        return 1

    try:
        total = lib.lottie_animation_get_totalframe(anim)
        fps = lib.lottie_animation_get_framerate(anim) or 60.0
        buf = (ctypes.c_uint32 * (SIZE * SIZE))()

        frames = []
        for i in range(total):
            lib.lottie_animation_render(anim, i, buf, SIZE, SIZE, SIZE * 4)
            # rlottie writes premultiplied BGRA; undo both for Pillow
            px = np.frombuffer(buf, dtype=np.uint8).reshape(SIZE, SIZE, 4)
            a = px[:, :, 3].astype(np.uint16)
            safe = np.where(a == 0, 1, a)
            rgb = px[:, :, [2, 1, 0]].astype(np.uint16) * 255 // safe[:, :, None]
            out = np.empty((SIZE, SIZE, 4), dtype=np.uint8)
            out[:, :, :3] = np.clip(rgb, 0, 255).astype(np.uint8)
            out[:, :, 3] = px[:, :, 3]
            frames.append(Image.fromarray(out, "RGBA"))
    finally:
        lib.lottie_animation_destroy(anim)

    if not frames:
        print("no frames rendered", file=sys.stderr)
        return 1

    frames[0].save(
        sys.argv[2],
        save_all=True,
        append_images=frames[1:],
        duration=int(round(1000 / fps)),
        loop=0,
        background=(0, 0, 0, 0),
        lossless=False,
        quality=80,
        method=0,
        exact=True,  # keep RGB under fully-transparent pixels, avoids edge fringing
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
