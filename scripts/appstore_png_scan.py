#!/usr/bin/env python3
"""Helpers to locate UI text in iOS simulator screenshots without image viewing.

Subcommands:
  clusters <png> [limit]  Print white text clusters as "center_pt=(x,y) dots=N".
  alert <png>             Print ALERT when a system alert sheet covers the app.

White text (light on dark) is what the Ponlet UI uses for labels and buttons,
so cluster positions double as tap targets: tap points are pixels divided by 3
(the screenshots are @3x).
"""

import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from appstore_png_crop import load_rgb  # noqa: E402


def clusters(path, limit):
    width, height, rows = load_rgb(path)
    cell = 12
    grid = {}
    for y in range(height):
        row = rows[y]
        for x in range(width):
            r, g, b = row[x * 3 : x * 3 + 3]
            if r > 200 and g > 200 and b > 200:
                grid.setdefault((x // cell, y // cell), []).append((x, y))
    found, used = [], set()
    for key in grid:
        if key in used:
            continue
        stack, component = [key], []
        used.add(key)
        while stack:
            current = stack.pop()
            component.append(current)
            cx, cy = current
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    nxt = (cx + dx, cy + dy)
                    if nxt in grid and nxt not in used:
                        used.add(nxt)
                        stack.append(nxt)
        points = [point for cell_key in component for point in grid[cell_key]]
        xs = [point[0] for point in points]
        ys = [point[1] for point in points]
        found.append((len(points), min(xs), min(ys), max(xs), max(ys)))
    found.sort(reverse=True)
    for count, x0, y0, x1, y1 in found[:limit]:
        print(f"center_pt=({(x0 + x1) / 2 / 3:.0f},{(y0 + y1) / 2 / 3:.0f}) dots={count} px=({x0},{y0})-({x1},{y1})")


def alert(path):
    width, height, rows = load_rgb(path)
    count = 0
    for y in range(900, min(1900, height), 2):
        row = rows[y]
        for x in range(200, min(1120, width), 2):
            r, g, b = row[x * 3 : x * 3 + 3]
            if r > 235 and g > 235 and b > 235:
                count += 1
    print("ALERT" if count > 5000 else "OK")


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    command, path = sys.argv[1], sys.argv[2]
    if command == "clusters":
        clusters(path, int(sys.argv[3]) if len(sys.argv) > 3 else 16)
    elif command == "alert":
        alert(path)
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
