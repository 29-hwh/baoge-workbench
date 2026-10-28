#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
宝哥工作台 · TabBar 图标生成器

纯 Python 实现，不依赖 Pillow / cairosvg 等第三方库。
采用 4x 超采样 + 盒式降采样实现抗锯齿，输出 RGBA PNG。

使用方法：
    python3 tools/gen_icons.py

输出：assets/tabbar/tab_<name>[_active].png  尺寸 81x81
"""

import os
import math
import zlib
import struct

DESIGN = 54.0      # 设计坐标系尺寸
OUTPUT = 81        # 输出图标尺寸（小程序 tabBar 规范 81x81）
SS = 4             # 超采样倍数
RENDER = OUTPUT * SS
SCALE = RENDER / DESIGN

# 配色：未选中统一灰，选中用各模块主色
C_GRAY = (0x88, 0x87, 0x80)
C_TODAY = (0xE2, 0x4B, 0x4A)     # 今日 · 红
C_READING = (0x37, 0x8A, 0xDD)   # 读书 · 蓝
C_FITNESS = (0xEF, 0x9F, 0x27)   # 健身 · 橙
C_LEARNING = (0x1D, 0x9E, 0x75)  # 学习 · 绿
C_PROFILE = (0x53, 0x4A, 0xB7)   # 我的 · 紫


class Canvas:
    """单通道覆盖率画布（超采样分辨率）"""

    def __init__(self, size):
        self.size = size
        self.buf = [0.0] * (size * size)

    def _set(self, x, y, v=1.0):
        if 0 <= x < self.size and 0 <= y < self.size:
            i = y * self.size + x
            if v > self.buf[i]:
                self.buf[i] = v

    # ---------- 基础图元（坐标均为设计坐标，内部自动缩放） ----------

    def fill_circle(self, cx, cy, r):
        cx, cy, r = cx * SCALE, cy * SCALE, r * SCALE
        x0, x1 = int(cx - r - 1), int(cx + r + 2)
        y0, y1 = int(cy - r - 1), int(cy + r + 2)
        r2 = r * r
        for y in range(max(0, y0), min(self.size, y1)):
            dy = y + 0.5 - cy
            for x in range(max(0, x0), min(self.size, x1)):
                dx = x + 0.5 - cx
                if dx * dx + dy * dy <= r2:
                    self._set(x, y)

    def stroke_circle(self, cx, cy, r, w):
        cx, cy, r, w = cx * SCALE, cy * SCALE, r * SCALE, w * SCALE
        hw = w / 2.0
        outer = (r + hw + 1) ** 2
        inner = (r - hw - 1) ** 2
        x0, x1 = int(cx - r - hw - 2), int(cx + r + hw + 3)
        y0, y1 = int(cy - r - hw - 2), int(cy + r + hw + 3)
        for y in range(max(0, y0), min(self.size, y1)):
            dy = y + 0.5 - cy
            for x in range(max(0, x0), min(self.size, x1)):
                dx = x + 0.5 - cx
                d2 = dx * dx + dy * dy
                if inner <= d2 <= outer and abs(math.sqrt(d2) - r) <= hw:
                    self._set(x, y)

    def stroke_line(self, x1, y1, x2, y2, w):
        x1, y1, x2, y2, w = x1 * SCALE, y1 * SCALE, x2 * SCALE, y2 * SCALE, w * SCALE
        hw = w / 2.0
        vx, vy = x2 - x1, y2 - y1
        vlen2 = vx * vx + vy * vy
        x0, x1b = int(min(x1, x2) - hw - 2), int(max(x1, x2) + hw + 3)
        y0, y1b = int(min(y1, y2) - hw - 2), int(max(y1, y2) + hw + 3)
        for y in range(max(0, y0), min(self.size, y1b)):
            py = y + 0.5
            for x in range(max(0, x0), min(self.size, x1b)):
                px = x + 0.5
                if vlen2 == 0:
                    d = math.hypot(px - x1, py - y1)
                else:
                    t = ((px - x1) * vx + (py - y1) * vy) / vlen2
                    t = max(0.0, min(1.0, t))
                    d = math.hypot(px - (x1 + t * vx), py - (y1 + t * vy))
                if d <= hw:
                    self._set(x, y)

    def stroke_polygon(self, points, w, close=True):
        pts = list(points)
        if close:
            pts.append(pts[0])
        for i in range(len(pts) - 1):
            self.stroke_line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], w)

    def stroke_rounded_rect(self, x, y, w, h, r, lw):
        self.stroke_polygon(_rounded_rect_points(x, y, w, h, r), lw, close=True)

    def fill_rounded_rect(self, x, y, w, h, r):
        """内缩描边实现填充（圆角处近似，图标尺寸下视觉无损）"""
        steps = max(2, int(min(w, h) / 2))
        step = (min(w, h) / 2.0) / steps
        cur = 0.0
        while cur < min(w, h) / 2.0 + 0.01:
            self.stroke_rounded_rect(x + cur, y + cur, w - 2 * cur, h - 2 * cur,
                                     max(0.0, r - cur), step * 2.05)
            cur += step

    def stroke_arc(self, cx, cy, r, w, a1deg, a2deg):
        """屏幕坐标系（y 向下），角度为顺时针度数，0°=正右，270°=正上"""
        cx, cy, r, w = cx * SCALE, cy * SCALE, r * SCALE, w * SCALE
        hw = w / 2.0
        a1, a2 = math.radians(a1deg), math.radians(a2deg)
        x0, x1 = int(cx - r - hw - 2), int(cx + r + hw + 3)
        y0, y1 = int(cy - r - hw - 2), int(cy + r + hw + 3)
        lo, hi = (a1, a2) if a1 <= a2 else (a2, a1)
        for y in range(max(0, y0), min(self.size, y1)):
            dy = y + 0.5 - cy
            for x in range(max(0, x0), min(self.size, x1)):
                dx = x + 0.5 - cx
                d = math.hypot(dx, dy)
                if abs(d - r) > hw:
                    continue
                ang = math.atan2(dy, dx) % (2 * math.pi)
                a1m, a2m = a1 % (2 * math.pi), a2 % (2 * math.pi)
                if a1m <= a2m:
                    ok = a1m <= ang <= a2m
                else:
                    ok = ang >= a1m or ang <= a2m
                if ok:
                    self._set(x, y)

    # ---------- 输出 ----------

    def to_png(self, path, color):
        """降采样 + 写出 RGBA PNG"""
        n = SS * SS
        rows = []
        for oy in range(OUTPUT):
            row = bytearray()
            for ox in range(OUTPUT):
                acc = 0.0
                base_y = oy * SS
                base_x = ox * SS
                for sy in range(SS):
                    y = base_y + sy
                    line = self.buf[y * RENDER: y * RENDER + RENDER]
                    for sx in range(SS):
                        acc += line[base_x + sx]
                a = acc / n
                a = 0.0 if a < 0.0 else (1.0 if a > 1.0 else a)
                row += bytes((color[0], color[1], color[2], int(round(a * 255))))
            rows.append(bytes(row))
        _write_png(path, OUTPUT, OUTPUT, rows)


def _rounded_rect_points(x, y, w, h, r):
    """生成圆角矩形轮廓采样点"""
    r = min(r, w / 2.0, h / 2.0)
    pts = []
    seg = 8
    # 四个角：右上、右下、左下、左上
    corners = [
        (x + w - r, y + r, -90, 0),
        (x + w - r, y + h - r, 0, 90),
        (x + r, y + h - r, 90, 180),
        (x + r, y + r, 180, 270),
    ]
    for ccx, ccy, a0, a1 in corners:
        for i in range(seg + 1):
            a = math.radians(a0 + (a1 - a0) * i / seg)
            pts.append((ccx + r * math.cos(a), ccy + r * math.sin(a)))
    return pts


def _write_png(path, w, h, rows):
    raw = b''.join(b'\x00' + r for r in rows)

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


# ============ 图标绘制 ============

def icon_today(c):
    """今日 · 日历 + 对勾"""
    c.stroke_rounded_rect(6, 8, 42, 40, 4, 3.2)
    c.stroke_line(15, 3, 15, 11, 2.6)
    c.stroke_line(39, 3, 39, 11, 2.6)
    c.stroke_line(6, 20, 48, 20, 2.8)
    c.stroke_line(18, 31, 24, 37, 3.4)
    c.stroke_line(24, 37, 37, 25, 3.4)


def icon_reading(c):
    """读书 · 摊开的书"""
    c.stroke_polygon([(27, 14), (9, 17.5), (9, 41), (27, 44)], 3.0)
    c.stroke_polygon([(27, 14), (45, 17.5), (45, 41), (27, 44)], 3.0)
    c.stroke_line(27, 14, 27, 44, 3.0)


def icon_fitness(c):
    """健身 · 哑铃"""
    c.stroke_line(16, 27, 38, 27, 3.6)
    c.fill_rounded_rect(8, 16, 6.5, 22, 2)
    c.fill_rounded_rect(14.5, 20.5, 4.5, 13, 1.5)
    c.fill_rounded_rect(35, 20.5, 4.5, 13, 1.5)
    c.fill_rounded_rect(39.5, 16, 6.5, 22, 2)


def icon_learning(c):
    """学习 · 靶心目标"""
    c.stroke_circle(27, 27, 20, 3.2)
    c.stroke_circle(27, 27, 12, 3.0)
    c.fill_circle(27, 27, 4.6)


def icon_profile(c):
    """我的 · 人像"""
    c.fill_circle(27, 17.5, 8)
    c.stroke_arc(27, 50, 18, 3.6, 200, 340)


ICONS = [
    ('today', icon_today, C_TODAY),
    ('reading', icon_reading, C_READING),
    ('fitness', icon_fitness, C_FITNESS),
    ('learning', icon_learning, C_LEARNING),
    ('profile', icon_profile, C_PROFILE),
]


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(os.path.dirname(here), 'assets', 'tabbar')
    os.makedirs(out_dir, exist_ok=True)

    for name, draw, color in ICONS:
        # 未选中态
        c = Canvas(RENDER)
        draw(c)
        p1 = os.path.join(out_dir, 'tab_%s.png' % name)
        c.to_png(p1, C_GRAY)

        # 选中态
        c2 = Canvas(RENDER)
        draw(c2)
        p2 = os.path.join(out_dir, 'tab_%s_active.png' % name)
        c2.to_png(p2, color)

        print('generated: %s (%d bytes) / %s (%d bytes)'
              % (os.path.basename(p1), os.path.getsize(p1),
                 os.path.basename(p2), os.path.getsize(p2)))


if __name__ == '__main__':
    main()
