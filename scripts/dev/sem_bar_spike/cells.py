import numpy as np
from PIL import Image, ImageOps


def cells(bar):
    """Split an FEI bar into (header, value) cell images using its white divider lines."""
    a = np.asarray(bar)
    h, w = a.shape
    # header and value rows are separated by a dark gap (the cells have no line between them): split at the
    # darkest run of rows in the middle band, judged on the left 40% where the cells are
    left = a[:, : int(w * 0.4)].mean(axis=1)
    band = list(range(int(0.3 * h), int(0.7 * h) + 1))
    lo = min(left[y] for y in band)
    dark = [y for y in band if left[y] <= lo + 2]
    mid = (dark[0] + dark[-1]) // 2
    body = a[2 : h - 1]
    cols = [
        x for x in range(w) if (body[:, x] > 0.4 * body.max()).mean() > 0.9
    ]  # vertical dividers
    edges = []
    for x in cols:
        if not edges or x - edges[-1][-1] > 1:
            edges.append([x])
        else:
            edges[-1].append(x)
    xs = [0] + [e[len(e) // 2] for e in edges] + [w]
    out = []
    for x0, x1 in zip(xs, xs[1:]):
        if x1 - x0 < 12:
            continue
        top = bar.crop((x0 + 2, 2, x1 - 1, mid))
        bot = bar.crop((x0 + 2, mid + 2, x1 - 1, h - 1))
        out.append((x0, x1, top, bot))
    return out, mid


def prep(img, scale=3, pad=16):
    img = ImageOps.invert(img).resize(
        (img.width * scale, img.height * scale), Image.LANCZOS
    )
    return ImageOps.expand(img, border=pad, fill=255).convert("RGB")
