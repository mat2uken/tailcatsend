#!/usr/bin/env python3
"""Pixel statistics for a region of a PNG, for screenshot checks without viewing.

Subcommands:
  stats <png> <x> <y> <w> <h>       Mean RGB, dark ratio (luma<80), light ratio (luma>200).
  contrast <png> <x> <y> <w> <h>    Horizontal luma transitions per row mean; a QR code or
                                    dense text scores high, empty panels score near zero.
  sample <png> <x> <y> <w> <h> <step>
                                    Coarse ASCII map (dark '#', mid '.', light '+').

Coordinates are pixels from the top-left.
"""

import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from appstore_png_crop import load_rgb  # noqa: E402


def region(path, x, y, w, h):
    width, height, rows = load_rgb(path)
    if x + w > width or y + h > height:
        raise SystemExit("region exceeds the image")
    return [row[x * 3 : (x + w) * 3] for row in rows[y : y + h]], w, h


def luma(row, index, w):
    if index < 0 or index >= w:
        return 0
    start = index * 3
    r, g, b = row[start], row[start + 1], row[start + 2]
    return 0.299 * r + 0.587 * g + 0.114 * b


def stats(path, x, y, w, h):
    rows, w, h = region(path, x, y, w, h)
    total = w * h
    dark = light = 0
    sums = [0, 0, 0]
    for row in rows:
        for index in range(w):
            start = index * 3
            sums[0] += row[start]
            sums[1] += row[start + 1]
            sums[2] += row[start + 2]
            value = luma(row, index, w)
            if value < 80:
                dark += 1
            elif value > 200:
                light += 1
    print(f"mean_rgb=({sums[0] / total:.1f},{sums[1] / total:.1f},{sums[2] / total:.1f}) dark={dark / total:.3f} light={light / total:.3f}")


def contrast(path, x, y, w, h):
    rows, w, h = region(path, x, y, w, h)
    transitions = 0
    for row in rows:
        previous = luma(row, 0, w)
        for index in range(1, w):
            value = luma(row, index, w)
            if abs(value - previous) > 60:
                transitions += 1
            previous = value
    print(f"transitions={transitions} per_px={transitions / (w * h):.3f}")


def sample(path, x, y, w, h, step):
    rows, w, h = region(path, x, y, w, h)
    for row_y in range(0, h, step):
        row = rows[row_y]
        line = []
        for index in range(0, w, step):
            value = luma(row, index, w)
            line.append("#" if value < 80 else ("+" if value > 200 else "."))
        print("".join(line))


def main():
    if len(sys.argv) < 7:
        raise SystemExit(__doc__)
    command, path = sys.argv[1], sys.argv[2]
    box = [int(value) for value in sys.argv[3:7]]
    if command == "stats":
        stats(path, *box)
    elif command == "contrast":
        contrast(path, *box)
    elif command == "sample":
        sample(path, *box, int(sys.argv[7]) if len(sys.argv) > 7 else 16)
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
