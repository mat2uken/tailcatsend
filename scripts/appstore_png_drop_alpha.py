#!/usr/bin/env python3
"""Rewrite an RGBA PNG as RGB so App Store screenshots carry no alpha channel.

`xcrun simctl io screenshot` always writes a PNG with an alpha channel, and
`sips` keeps that channel even after a format round trip. App Store Connect
rejects screenshots with transparency, so strip the channel losslessly here.

Usage: appstore_png_drop_alpha.py <input.png> <output.png>
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


def drop_alpha(source, target):
    data = open(source, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"{source} is not a PNG")
    header = None
    idat = bytearray()
    extras = []
    for kind, body in read_chunks(data):
        if kind == b"IHDR":
            header = body
        elif kind == b"IDAT":
            idat.extend(body)
        elif kind in (b"tRNS", b"iCCP"):
            continue
        elif kind not in (b"IEND",):
            extras.append((kind, body))
    width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", header)
    if depth != 8 or color != 6 or interlace != 0:
        raise SystemExit(f"unexpected PNG layout: depth={depth} color={color} interlace={interlace}")
    rows = unfilter(zlib.decompress(bytes(idat)), width, height, 4)
    rgb = bytearray()
    for row in rows:
        rgb.append(0)
        for index in range(width):
            start = index * 4
            rgb.extend(row[start : start + 3])
    out = bytearray(b"\x89PNG\r\n\x1a\n")
    out.extend(chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, compression, filtering, interlace)))
    for kind, body in extras:
        out.extend(chunk(kind, body))
    out.extend(chunk(b"IDAT", zlib.compress(bytes(rgb), 6)))
    out.extend(chunk(b"IEND", b""))
    with open(target, "wb") as handle:
        handle.write(out)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    drop_alpha(sys.argv[1], sys.argv[2])
