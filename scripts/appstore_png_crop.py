#!/usr/bin/env python3
"""Crop a region from a PNG using pixel coordinates.

Usage: appstore_png_crop.py <input.png> <output.png> <x> <y> <width> <height>
"""

import struct
import sys
import zlib


def read_chunks(data):
    offset = 8
    while offset < len(data):
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        kind = data[offset + 4 : offset + 8]
        body = data[offset + 8 : offset + 8 + length]
        yield kind, body
        offset += 12 + length


def unfilter(raw, width, height, bpp):
    stride = width * bpp
    rows = []
    previous = bytearray(stride)
    offset = 0
    for _ in range(height):
        mode = raw[offset]
        offset += 1
        row = bytearray(raw[offset : offset + stride])
        offset += stride
        for index in range(stride):
            left = row[index - bpp] if index >= bpp else 0
            up = previous[index]
            up_left = previous[index - bpp] if index >= bpp else 0
            if mode == 1:
                row[index] = (row[index] + left) & 0xFF
            elif mode == 2:
                row[index] = (row[index] + up) & 0xFF
            elif mode == 3:
                row[index] = (row[index] + ((left + up) >> 1)) & 0xFF
            elif mode == 4:
                estimate = left + up - up_left
                distances = (abs(estimate - left), abs(estimate - up), abs(estimate - up_left))
                predictor = (left, up, up_left)[distances.index(min(distances))]
                row[index] = (row[index] + predictor) & 0xFF
            elif mode != 0:
                raise ValueError(f"unsupported PNG filter {mode}")
        rows.append(row)
        previous = row
    return rows


def chunk(kind, body):
    return (
        struct.pack(">I", len(body))
        + kind
        + body
        + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
    )


def load_rgb(path):
    data = open(path, "rb").read()
    header = None
    idat = bytearray()
    for kind, body in read_chunks(data):
        if kind == b"IHDR":
            header = body
        elif kind == b"IDAT":
            idat.extend(body)
    width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", header)
    if depth != 8 or interlace != 0 or color not in (2, 6):
        raise SystemExit(f"unexpected PNG layout: depth={depth} color={color}")
    channels = 3 if color == 2 else 4
    rows = unfilter(zlib.decompress(bytes(idat)), width, height, channels)
    rgb = []
    for row in rows:
        stripped = bytearray()
        for index in range(width):
            start = index * channels
            stripped.extend(row[start : start + 3])
        rgb.append(stripped)
    return width, height, rgb


def save_rgb(path, width, height, rows):
    raw = bytearray()
    for row in rows:
        raw.append(0)
        raw.extend(row)
    out = bytearray(b"\x89PNG\r\n\x1a\n")
    out.extend(chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)))
    out.extend(chunk(b"IDAT", zlib.compress(bytes(raw), 6)))
    out.extend(chunk(b"IEND", b""))
    with open(path, "wb") as handle:
        handle.write(out)


def main():
    source, target, x, y, width, height = sys.argv[1:7]
    x, y, width, height = int(x), int(y), int(width), int(height)
    full_width, full_height, rows = load_rgb(source)
    if x + width > full_width or y + height > full_height:
        raise SystemExit("crop exceeds the source image")
    cropped = [row[x * 3 : (x + width) * 3] for row in rows[y : y + height]]
    save_rgb(target, width, height, cropped)


if __name__ == "__main__":
    main()
