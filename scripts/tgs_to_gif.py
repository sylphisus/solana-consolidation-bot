#!/usr/bin/env python3
"""Render a Telegram .tgs sticker to an animated GIF with transparency.

Uses rlottie (via its C API) for the rendering — python-lottie gets masks and
track mattes wrong on real stickers, and rlottie is what Telegram itself uses.
Encoding is done here with Pillow rather than rlottie's own lottie2gif, which
composites the alpha away against a background colour.
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


def to_gif_frame(im: "Image.Image") -> "Image.Image":
    """Palettize an RGBA frame, reserving index 255 for transparency.

    GIF alpha is 1-bit, so anything under half opacity becomes fully
    transparent and everything else fully opaque.
    """
    alpha = im.getchannel("A")
    frame = im.convert("RGB").convert("P", palette=Image.ADAPTIVE, colors=255)
    frame.paste(255, Image.eval(alpha, lambda v: 255 if v <= 128 else 0))
    return frame


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: tgs_to_gif.py <input.tgs> <output.gif>", file=sys.stderr)
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

        # GIF delays are whole centiseconds, and viewers clamp anything under
        # 2cs up to 10cs — a 60fps sticker written at 1cs plays 6x slow. Cap at
        # the fastest un-clamped rate and drop source frames to keep real time.
        delay_cs = max(2, int(round(100 / fps)))
        out_fps = 100 / delay_cs
        count = max(1, int(round(total / fps * out_fps)))
        indices = [min(total - 1, int(round(i * fps / out_fps))) for i in range(count)]

        frames = []
        for i in indices:
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

    gif_frames = [to_gif_frame(f) for f in frames]
    gif_frames[0].save(
        sys.argv[2],
        save_all=True,
        append_images=gif_frames[1:],
        duration=delay_cs * 10,
        loop=0,
        transparency=255,
        disposal=2,  # clear each frame, otherwise transparent areas smear
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
