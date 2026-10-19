#!/usr/bin/env python3
"""Regenerates every Tammy brand file from the geometry below.

    python3 assets/brand/build.py            # from the repository root

Needs only Python 3: the outputs are SVG, written as text.

The mark is an order pad with a pencil, drawn from first principles in the
same family as Prepcook's toque: the same ink, off-white and blue, the same
64 x 64 grid, the same flat geometry. The pad is a binding strip over a sheet
whose ruled lines are cut out as holes; the pencil leans in from the right
with its point on the sheet, and a notch the pencil's shape plus a margin is
cut out of the sheet around it, so the two read apart at favicon size. Every
shape is a plain path: no masks or clip paths, which some renderers ignore. Nothing is traced from clip art, a logo or a font glyph. The
wordmark in the logo files is ordinary text set in the viewer's sans-serif.

Outputs (all overwritten):
  assets/brand/tammy-mark.svg            the pad alone, ink on transparent (light backgrounds)
  assets/brand/tammy-mark-dark.svg       the pad alone, off-white on transparent (dark backgrounds)
  assets/brand/tammy-mark-mono.svg       single colour, inherits currentColor
  assets/brand/tammy-app-icon.svg        white pad on the blue tile (Slack app icon, favicons)
  assets/brand/tammy-logo.svg            mark + "Tammy" for light backgrounds
  assets/brand/tammy-logo-dark.svg       mark + "Tammy" for dark backgrounds
"""
from __future__ import annotations

import math
import os

BRAND = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(BRAND))

INK = "#1F2328"        # near-black, light backgrounds (Prepcook's ink)
INK_DARK = "#F4F1EA"   # warm off-white, dark backgrounds
BLUE = "#3F6AA6"       # the one accent colour, shared with Prepcook
WHITE = "#FFFFFF"

# Geometry on a 64 x 64 grid.
PAD_X, PAD_W = 9.0, 36.0
BIND_Y, BIND_H = 7.0, 7.0          # the binding strip across the top
SHEET_Y, SHEET_BOTTOM = 16.5, 57.0  # the sheet below it
SHEET_R = 3.5
RULE_X = 15.0
RULE_H = 2.4
RULES = ((24.0, 20.0), (31.5, 20.0), (39.0, 20.0), (46.5, 13.0))  # (y, length)

# The pencil, drawn pointing down along its own axis, then turned and placed.
PENCIL_W = 7.0
ERASER_TOP, ERASER_BOTTOM = -22.0, -17.0
BODY_TOP, BODY_BOTTOM = -15.0, 9.0
TIP = 17.0                         # the point
LEAD = 13.5                        # where the bare wood ends and the lead shows
PENCIL_AT = (47.5, 34.0)
PENCIL_TURN = 32.0                 # degrees clockwise from pointing straight down
GAP = 2.4                          # clearance cut around the pencil, each side

Point = tuple[float, float]


def turn(p: Point) -> Point:
    """A point on the pencil's own axis, placed on the grid."""
    a = math.radians(PENCIL_TURN)
    x, y = p
    return (
        PENCIL_AT[0] + x * math.cos(a) - y * math.sin(a),
        PENCIL_AT[1] + x * math.sin(a) + y * math.cos(a),
    )


def clearance() -> list[Point]:
    """The pencil's silhouette grown by GAP on every side, on the grid,
    clockwise from the eraser end."""
    h = PENCIL_W / 2 + GAP
    # Growing a point of half-angle t by GAP moves its apex GAP / sin(t).
    t = math.atan2(PENCIL_W / 2, TIP - BODY_BOTTOM)
    return [
        turn(p)
        for p in (
            (-h, ERASER_TOP - GAP),
            (h, ERASER_TOP - GAP),
            (h, BODY_BOTTOM),
            (0.0, TIP + GAP / math.sin(t)),
            (-h, BODY_BOTTOM),
        )
    ]


def clip_left_of(poly: list[Point], x0: float) -> list[Point]:
    """Sutherland-Hodgman: the part of a convex polygon with x <= x0."""
    out: list[Point] = []
    for i, cur in enumerate(poly):
        prev = poly[i - 1]
        cur_in, prev_in = cur[0] <= x0, prev[0] <= x0
        if cur_in != prev_in:
            k = (x0 - prev[0]) / (cur[0] - prev[0])
            out.append((x0, prev[1] + k * (cur[1] - prev[1])))
        if cur_in:
            out.append(cur)
    return out


def f(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".")


def rounded_rect(x: float, y: float, w: float, h: float, r: float) -> str:
    """A rounded rectangle as a closed subpath (so it can be a hole)."""
    return (
        f"M{f(x + r)} {f(y)} H{f(x + w - r)} "
        f"A{f(r)} {f(r)} 0 0 1 {f(x + w)} {f(y + r)} V{f(y + h - r)} "
        f"A{f(r)} {f(r)} 0 0 1 {f(x + w - r)} {f(y + h)} H{f(x + r)} "
        f"A{f(r)} {f(r)} 0 0 1 {f(x)} {f(y + h - r)} V{f(y + r)} "
        f"A{f(r)} {f(r)} 0 0 1 {f(x + r)} {f(y)} Z"
    )


def sheet_outline() -> str:
    """The sheet, with a notch where the pencil crosses its right edge."""
    x, y, r = PAD_X, SHEET_Y, SHEET_R
    right, bottom = PAD_X + PAD_W, SHEET_BOTTOM
    notch = clip_left_of(clearance(), right)
    on_edge = [p for p in notch if abs(p[0] - right) < 1e-9]
    inside = [p for p in notch if p[0] < right - 1e-9]
    assert len(on_edge) == 2, "the pencil must cross the sheet's right edge"
    top_cut, bottom_cut = sorted(on_edge, key=lambda p: p[1])
    assert y + r < top_cut[1] and bottom_cut[1] < bottom - r, (
        "the pencil must cross the straight part of the right edge"
    )
    assert max(p[1] for p in inside) < bottom - 1.5, "the point must stay on the sheet"
    # Walk the notch from where it enters at the top to where it leaves lower
    # down. One way round the clipped polygon goes straight down the edge to
    # the lower crossing; the other passes every vertex on the sheet.
    n = len(notch)
    i = notch.index(top_cut)
    step = -1 if notch[(i + 1) % n] == bottom_cut else 1
    walk: list[Point] = []
    j = (i + step) % n
    while notch[j] != bottom_cut:
        walk.append(notch[j])
        j = (j + step) % n
    for rx_y, length in RULES:
        for px, py in inside:
            assert not (RULE_X - GAP < px < RULE_X + length + GAP / 2 and rx_y - GAP < py < rx_y + RULE_H + GAP), (
                "a ruled line runs into the pencil"
            )
    notch_path = " ".join(f"L{f(px)} {f(py)}" for px, py in walk)
    return (
        f"M{f(x + r)} {f(y)} H{f(right - r)} A{f(r)} {f(r)} 0 0 1 {f(right)} {f(y + r)} "
        f"V{f(top_cut[1])} {notch_path} L{f(right)} {f(bottom_cut[1])} "
        f"V{f(bottom - r)} A{f(r)} {f(r)} 0 0 1 {f(right - r)} {f(bottom)} H{f(x + r)} "
        f"A{f(r)} {f(r)} 0 0 1 {f(x)} {f(bottom - r)} V{f(y + r)} "
        f"A{f(r)} {f(r)} 0 0 1 {f(x + r)} {f(y)} Z"
    )


def pad_path() -> str:
    """The binding strip and the notched sheet, with the ruled lines as holes."""
    d = [rounded_rect(PAD_X, BIND_Y, PAD_W, BIND_H, 2.5), sheet_outline()]
    for y, length in RULES:
        d.append(rounded_rect(RULE_X, y, length, RULE_H, RULE_H / 2))
    return f'<path fill-rule="evenodd" d="{" ".join(d)}"/>'


def pencil_path() -> str:
    """Eraser, body and the sharpened wood, and the lead as its own point."""
    h = PENCIL_W / 2
    lead_half = h * (TIP - LEAD) / (TIP - BODY_BOTTOM)

    def pts(*points: Point) -> str:
        placed = [turn(p) for p in points]
        return "M" + " L".join(f"{f(px)} {f(py)}" for px, py in placed) + " Z"

    eraser = pts((-h, ERASER_TOP), (h, ERASER_TOP), (h, ERASER_BOTTOM), (-h, ERASER_BOTTOM))
    wood = pts(
        (-h, BODY_TOP),
        (h, BODY_TOP),
        (h, BODY_BOTTOM),
        (lead_half + 0.9, LEAD - 0.9),
        (-lead_half - 0.9, LEAD - 0.9),
        (-h, BODY_BOTTOM),
    )
    lead = pts((-lead_half, LEAD), (lead_half, LEAD), (0.0, TIP))
    return f'<path stroke-linejoin="round" d="{eraser} {wood} {lead}"/>'


def mark_body() -> str:
    return f"  {pad_path()}\n  {pencil_path()}"


def mark_svg(fill: str) -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Tammy">\n'
        f'<g fill="{fill}">\n{mark_body()}\n</g>\n</svg>\n'
    )


def app_icon_svg() -> str:
    """White pad, scaled to leave a margin, on a rounded blue tile."""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Tammy">\n'
        f'<rect width="64" height="64" rx="14" fill="{BLUE}"/>\n'
        f'<g fill="{WHITE}" transform="translate(32 32) scale(0.74) translate(-32 -32)">\n'
        f"{mark_body()}\n</g>\n</svg>\n"
    )


def logo_svg(fill: str) -> str:
    """The mark beside the word "Tammy". 232 x 64; the mark fills the height,
    and the width leaves room for the word at the mark's 40 px type size."""
    font = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 232 64" role="img" aria-label="Tammy">\n'
        f'<g fill="{fill}">\n{mark_body()}\n'
        f'  <text x="70" y="49" font-family="{font}" font-size="40" font-weight="700" letter-spacing="-0.5">Tammy</text>\n'
        "</g>\n</svg>\n"
    )


def write(name: str, text: str) -> None:
    path = os.path.join(BRAND, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print("wrote", os.path.relpath(path, ROOT))


def main() -> None:
    write("tammy-mark.svg", mark_svg(INK))
    write("tammy-mark-dark.svg", mark_svg(INK_DARK))
    write("tammy-mark-mono.svg", mark_svg("currentColor"))
    write("tammy-app-icon.svg", app_icon_svg())
    write("tammy-logo.svg", logo_svg(INK))
    write("tammy-logo-dark.svg", logo_svg(INK_DARK))


if __name__ == "__main__":
    main()
