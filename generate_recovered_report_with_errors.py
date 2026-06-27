from PIL import Image, ImageDraw, ImageFont
from pathlib import Path


OUT_DIR = Path(__file__).resolve().parent
PNG_PATH = OUT_DIR / "stress-20260623-073228-h3wd-recovered-full-400-429.png"
PDF_PATH = OUT_DIR / "stress-20260623-073228-h3wd-recovered-full-400-429.pdf"


def font(size, bold=False):
    candidates = [
        "/System/Library/Fonts/STHeiti Medium.ttc" if bold else "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


W = 1800
H = 3700
M = 90
BLUE = "#0068a9"
GREEN = "#02945f"
WARN = "#d58a00"
TEXT = "#111827"
MUTED = "#68717d"
BORDER = "#d7dde4"
CARD = "#f7f9fc"
BG = "#ffffff"


img = Image.new("RGB", (W, H), BG)
draw = ImageDraw.Draw(img)

f_title = font(74, True)
f_sub = font(30)
f_card_value = font(50, True)
f_card_label = font(25)
f_h2 = font(34, True)
f_h3 = font(29, True)
f_body = font(26)
f_small = font(22)
f_table = font(23)
f_table_bold = font(23, True)


def text(x, y, s, fill=TEXT, f=None):
    draw.text((x, y), s, fill=fill, font=f or f_body)


def rounded_rect(x1, y1, x2, y2, radius=18, fill=None, outline=BORDER, width=2):
    draw.rounded_rectangle((x1, y1, x2, y2), radius=radius, fill=fill, outline=outline, width=width)


def card(x, y, w, h, value, label, color=TEXT):
    rounded_rect(x, y, x + w, y + h, radius=18, fill=CARD, outline=BORDER, width=2)
    text(x + 28, y + 28, value, color, f_card_value)
    text(x + 28, y + 98, label, MUTED, f_card_label)


def error_label(code, reason):
    code = str(code)
    reason = str(reason or "")
    if code == "429" or "限流" in reason:
        return code + " 限流"
    if code == "400" and "安全" in reason:
        return code + " 安全拦截"
    if code.startswith("5"):
        return code + " 上游错误"
    return code + " 错误"


def top_cards(error_rows):
    cards = [
        ("500", "目标 RPM", BLUE),
        ("500", "实际 RPM", GREEN),
        ("1000", "总请求", TEXT),
        ("98.1%", "成功率", GREEN),
        ("981 / 19", "成功 / 失败", TEXT),
    ]
    for row in error_rows:
        code, count, reason, _ = row
        if int(count) > 0:
            cards.append((str(count), error_label(code, reason), WARN))
    fallback = [
        ("325", "峰值在途", BLUE),
        ("187.73s", "总耗时", TEXT),
        ("34.97s", "平均耗时", BLUE),
        ("68.20s", "P95", WARN),
        ("5.33", "QPS", BLUE),
    ]
    for item in fallback:
        if len(cards) >= 8:
            break
        cards.append(item)
    return cards[:8]


def section_title(y, title):
    text(M, y, title, BLUE, f_h2)
    draw.line((M, y + 52, W - M, y + 52), fill="#dfe7ef", width=2)
    return y + 72


def sub_title(y, title):
    text(M, y, title, TEXT, f_h3)
    return y + 48


def table(y, headers, rows, widths, row_h=54):
    x = M
    draw.rounded_rectangle((M, y, W - M, y + row_h), radius=12, fill="#edf5fb", outline="#c9ddec", width=2)
    cx = x
    for h, w in zip(headers, widths):
        text(cx + 16, y + 15, h, BLUE, f_table_bold)
        cx += w
    y += row_h
    for i, row in enumerate(rows):
        fill = "#ffffff" if i % 2 == 0 else "#f8fafc"
        draw.rectangle((M, y, W - M, y + row_h), fill=fill, outline="#e2e8f0")
        cx = x
        for cell, w in zip(row, widths):
            text(cx + 16, y + 15, str(cell), TEXT, f_table)
            cx += w
        y += row_h
    return y + 36


text(M, 70, "混合生图 RPM 压测救援报告", TEXT, f_title)
text(M, 166, "4 个 worker 原始报告合并恢复；worker 已按目标 RPM 正常发射请求，上游已有使用记录。", MUTED, f_sub)

card_w = (W - M * 2 - 3 * 20) // 4
card_h = 134
y = 245
error_rows = [
    ["400", "14", "Azure 安全系统拦截", "保留当前混合测试方法，作为真实场景样本"],
    ["429", "5", "Azure 速率限制", "观察高 RPM 档位限流比例，评估上游承载边界"],
]
cards = top_cards(error_rows)
for idx, (value, label, color) in enumerate(cards):
    row = idx // 4
    col = idx % 4
    card(M + col * (card_w + 20), y + row * (card_h + 22), card_w, card_h, value, label, color)

note_y = y + 2 * (card_h + 22) + 26
rounded_rect(M, note_y, W - M, note_y + 70, radius=16, fill="#fff8e7", outline="#efc45d", width=2)
text(M + 28, note_y + 19, "失败原因：Azure 安全系统 400 ×14；Azure 速率限制 429 ×5", "#9a6a00", f_body)

y = note_y + 120
y = section_title(y, "测试配置")
y = table(
    y,
    ["项目", "值"],
    [
        ["模型", "gpt-image-2"],
        ["Base URL", "https://api.azure-openai.net"],
        ["模式", "图片生成 RPM 多 Worker 混合压测"],
        ["时长", "120 秒"],
        ["Worker", "4 个，每个 125 RPM"],
        ["尺寸模式", "mixed"],
        ["负载模式", "mixed"],
        ["档位模式", "mixed"],
    ],
    [330, W - M * 2 - 330],
    row_h=52,
)

y = section_title(y, "性能结果")
perf_cards = [
    ("34.97s", "平均延迟", BLUE),
    ("29.39s", "P50", TEXT),
    ("56.43s", "P90", WARN),
    ("68.20s", "P95", WARN),
    ("101.84s", "P99", "#cf2e2e"),
    ("15.58s", "最小延迟", GREEN),
    ("139.01s", "最大延迟", "#cf2e2e"),
    ("5.33", "QPS", BLUE),
]
for idx, (value, label, color) in enumerate(perf_cards):
    row = idx // 4
    col = idx % 4
    card(M + col * (card_w + 20), y + row * (card_h + 18), card_w, card_h, value, label, color)
y += 2 * (card_h + 18) + 26

y = section_title(y, "Worker 结果")
y = table(
    y,
    ["Worker", "请求", "成功", "失败", "400", "429", "成功率", "P95"],
    [
        ["worker-1", "250", "246", "4", "4", "0", "98.4%", "83.15s"],
        ["worker-2", "250", "244", "6", "3", "3", "97.6%", "45.53s"],
        ["worker-3", "250", "246", "4", "2", "2", "98.4%", "43.26s"],
        ["worker-4", "250", "245", "5", "5", "0", "98.0%", "86.43s"],
    ],
    [230, 170, 170, 150, 150, 150, 210, W - M * 2 - 1230],
    row_h=52,
)

y = section_title(y, "混合生图分布")
y = sub_title(y, "工作类型")
y = table(
    y,
    ["项目", "数量", "占比"],
    [
        ["text-to-image", "504", "50.4%"],
        ["image-to-image-intent", "496", "49.6%"],
    ],
    [760, 360, W - M * 2 - 1120],
    row_h=50,
)

y = sub_title(y, "尺寸分布")
y = table(
    y,
    ["项目", "数量", "占比"],
    [
        ["1024x1536", "144", "14.4%"],
        ["2560x1440", "140", "14.0%"],
        ["1024x1024", "144", "14.4%"],
        ["1536x1024", "144", "14.4%"],
        ["2048x1152", "144", "14.4%"],
        ["1920x1088", "144", "14.4%"],
        ["3840x2160", "140", "14.0%"],
    ],
    [760, 360, W - M * 2 - 1120],
    row_h=48,
)

y = sub_title(y, "清晰度档位")
y = table(
    y,
    ["项目", "数量", "占比"],
    [
        ["low", "336", "33.6%"],
        ["medium", "336", "33.6%"],
        ["high", "328", "32.8%"],
    ],
    [760, 360, W - M * 2 - 1120],
    row_h=50,
)

y = section_title(y, "错误归因")
y = table(
    y,
    ["错误类型", "次数", "归因", "处理建议"],
    error_rows,
    [180, 150, 520, W - M * 2 - 850],
    row_h=50,
)

y = section_title(y, "结论")
summary = "本次 500 RPM、120 秒混合生图压测共发出 1000 个请求，实际 RPM 达到 500，成功 981 个，失败 19 个，成功率 98.1%。混合矩阵分布正常，文生图与图生图需求接近均分，尺寸和档位按轮转覆盖。失败主要来自上游 Azure 的安全拦截与速率限制，压测平台侧请求链路和 worker 发压流程正常。"
lines = []
current = ""
for ch in summary:
    test = current + ch
    if draw.textlength(test, font=f_body) > W - M * 2:
        lines.append(current)
        current = ch
    else:
        current = test
if current:
    lines.append(current)
for line in lines:
    text(M, y, line, TEXT, f_body)
    y += 46

text(M, H - 90, "生成时间：2026-06-23；数据来源：4 个 worker 原始报告合并恢复", MUTED, f_small)

img.save(PNG_PATH)
img.save(PDF_PATH, "PDF", resolution=144.0)
print(PDF_PATH)
print(PNG_PATH)
