#!/usr/bin/env python3
"""Generate a diverse synthetic receipt corpus for extraction testing.

Each receipt is drawn with PIL and has known ground truth (see GROUND_TRUTH
in run_corpus.py). The set covers: paper w/ handwritten tip, Chinese-language
receipt, card slip w/ handwritten tip+total, fee-laden receipt, no-tip counter
receipt, VAT-inclusive EUR receipt, and a two-image itemized+slip pair.
"""
import math
import os
import random
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.expanduser("~/workspace/tipshame-app/tests/corpus")
os.makedirs(OUT, exist_ok=True)

MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
SANSCJK = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
SERIFCJK = "/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc"

W = 440


def new_canvas(lines, font_path=MONO, size=17, pad=18):
    font = ImageFont.truetype(font_path, size)
    lh = size + 9
    h = pad * 2 + lh * lines
    img = Image.new("RGB", (W, h), "white")
    return img, ImageDraw.Draw(img), font, lh, pad


def text(d, font, x, y, s, fill="black"):
    d.text((x, y), s, font=font, fill=fill)


def hand(d, x, y, s, size=20):
    """Simulate pen handwriting: blue, slightly rotated."""
    font = ImageFont.truetype(SANS, size)
    tw = int(d.textlength(s, font=font)) + 12
    layer = Image.new("RGBA", (tw + 20, size + 24), (255, 255, 255, 0))
    ld = ImageDraw.Draw(layer)
    ld.text((10, 8), s, font=font, fill=(20, 40, 160, 255))
    layer = layer.rotate(random.uniform(-6, 6), expand=True, resample=Image.BICUBIC)
    d._image.paste(layer, (x, y), layer)


def row(d, font, y, left, right, x0=18, x1=422):
    text(d, font, x0, y, left)
    w = d.textlength(right, font=font)
    text(d, font, x1 - w, y, right)


def divider(d, font, y, x0=18, x1=422):
    text(d, font, x0, y, "-" * 34)


def centered(d, font, y, s, x1=440):
    w = d.textlength(s, font=font)
    text(d, font, (x1 - w) / 2, y, s)


def save(img, name):
    p = os.path.join(OUT, name)
    img.save(p)
    print("wrote", p)


random.seed(7)

# ---- t1: paper receipt, handwritten tip -------------------------------------
img, d, f, lh, pad = new_canvas(24)
y = pad
centered(d, f, y, "LUIGI'S PIZZA"); y += lh
centered(d, f, y, "(555) 123-4567"); y += lh
divider(d, f, y); y += lh
row(d, f, y, "Pepperoni Pizza", "18.99"); y += lh
row(d, f, y, "Garlic Knots", "6.50"); y += lh
row(d, f, y, "Caesar Salad", "12.00"); y += lh
row(d, f, y, "Soda", "5.01"); y += lh
divider(d, f, y); y += lh
row(d, f, y, "Subtotal", "42.50"); y += lh
row(d, f, y, "Tax", "4.36"); y += lh
text(d, f, 18, y, "Suggested: 15%  18%  20%"); y += lh
text(d, f, 18, y, "Tip:"); hand(d, 330, y - 4, "8.50"); y += lh
text(d, f, 18, y, "Total:"); hand(d, 310, y - 4, "55.36"); y += lh * 2
centered(d, f, y, "Thank you!"); y += lh
save(img, "t1_paper_handwritten.png")

# ---- t2: Chinese-language receipt -------------------------------------------
img, d, f, lh, pad = new_canvas(26, font_path=SANSCJK, size=18)
y = pad
fc = ImageFont.truetype(SERIFCJK, 22)
centered(d, fc, y, "老北京炸酱面馆"); y += lh + 4
centered(d, f, y, "Beijing Noodle House"); y += lh
divider(d, f, y); y += lh
row(d, f, y, "炸酱面 Zha Jiang Mian", "18.00"); y += lh
row(d, f, y, "宫保鸡丁 Kung Pao", "22.00"); y += lh
row(d, f, y, "酸辣汤 Hot & Sour", "12.00"); y += lh
row(d, f, y, "米饭 Rice x2", "16.00"); y += lh
divider(d, f, y); y += lh
row(d, f, y, "小计 Subtotal", "68.00"); y += lh
row(d, f, y, "税 Tax", "6.80"); y += lh
row(d, f, y, "服务费 Service Fee", "3.40"); y += lh
text(d, f, 18, y, "建议小费 15%  18%  20%"); y += lh
row(d, f, y, "小费 Tip", "13.60"); y += lh
row(d, f, y, "总计 Total", "91.80"); y += lh
save(img, "t2_chinese.png")

# ---- t3: card slip, handwritten tip + total ----------------------------------
img, d, f, lh, pad = new_canvas(20)
y = pad
centered(d, f, y, "BLUE BOTTLE COFFEE"); y += lh
centered(d, f, y, "*** CARD SLIP ***"); y += lh
divider(d, f, y); y += lh
row(d, f, y, "Subtotal", "18.75"); y += lh
row(d, f, y, "Tax", "1.88"); y += lh
text(d, f, 18, y, "Tip: ________"); hand(d, 250, y - 4, "3.75"); y += lh
text(d, f, 18, y, "Total: _______"); hand(d, 250, y - 4, "24.38"); y += lh * 2
centered(d, f, y, "Signature: __________"); y += lh
save(img, "t3_card_slip.png")

# ---- t4: fee-laden ------------------------------------------------------------
img, d, f, lh, pad = new_canvas(26)
y = pad
centered(d, f, y, "SEASIDE GRILL"); y += lh
divider(d, f, y); y += lh
row(d, f, y, "Grilled Salmon", "45.00"); y += lh
row(d, f, y, "Ribeye Steak", "55.00"); y += lh
row(d, f, y, "Wine", "20.00"); y += lh
divider(d, f, y); y += lh
row(d, f, y, "Subtotal", "120.00"); y += lh
row(d, f, y, "Tax", "12.36"); y += lh
row(d, f, y, "Service Charge (5%)", "6.00"); y += lh
row(d, f, y, "Card Surcharge (3%)", "3.60"); y += lh
text(d, f, 18, y, "Suggested gratuity:"); y += lh
text(d, f, 18, y, "  18%   20%   22%"); y += lh
row(d, f, y, "Tip", "24.00"); y += lh
row(d, f, y, "Total", "165.96"); y += lh
save(img, "t4_fees.png")

# ---- t5: counter takeout, no tip section --------------------------------------
img, d, f, lh, pad = new_canvas(16)
y = pad
centered(d, f, y, "POKE BOWL EXPRESS"); y += lh
centered(d, f, y, "*** TAKEOUT ***"); y += lh
divider(d, f, y); y += lh
row(d, f, y, "Salmon Poke Bowl", "14.95"); y += lh
divider(d, f, y); y += lh
row(d, f, y, "Subtotal", "14.95"); y += lh
row(d, f, y, "Tax", "1.54"); y += lh
row(d, f, y, "Total", "16.49"); y += lh * 2
centered(d, f, y, "Thank you!"); y += lh
save(img, "t5_notip.png")

# ---- t6: VAT-inclusive, EUR ----------------------------------------------------
img, d, f, lh, pad = new_canvas(24)
y = pad
centered(d, f, y, "CAFÉ LUMIÈRE"); y += lh
centered(d, f, y, "12 rue de la Paix, Paris"); y += lh
divider(d, f, y); y += lh
row(d, f, y, "Croissant", "3.50"); y += lh
row(d, f, y, "Cafe creme", "4.50"); y += lh
row(d, f, y, "Quiche Lorraine", "12.00"); y += lh
row(d, f, y, "Tarte citron", "8.00"); y += lh
row(d, f, y, "Jus d'orange", "20.00"); y += lh
divider(d, f, y); y += lh
row(d, f, y, "TOTAL", "48.00 EUR"); y += lh
centered(d, f, y, "TVA incluse (20%)"); y += lh
text(d, f, 18, y, "Pourboire:"); hand(d, 300, y - 4, "7.20"); y += lh
row(d, f, y, "TOTAL PAYE", "55.20 EUR"); y += lh
save(img, "t6_vat_eur.png")

# ---- t7: two-image pair — itemized bill + card slip ---------------------------
img, d, f, lh, pad = new_canvas(18)
y = pad
centered(d, f, y, "TACOS EL GORDO"); y += lh
centered(d, f, y, "Dine-in  #42"); y += lh
divider(d, f, y); y += lh
row(d, f, y, "Tacos al pastor x4", "16.00"); y += lh
row(d, f, y, "Quesadilla", "9.50"); y += lh
row(d, f, y, "Agua fresca x2", "7.00"); y += lh
divider(d, f, y); y += lh
row(d, f, y, "Subtotal", "32.50"); y += lh
row(d, f, y, "Tax", "3.35"); y += lh
text(d, f, 18, y, "Tip guide: 15% 18% 20%"); y += lh
save(img, "t7a_itemized.png")

img, d, f, lh, pad = new_canvas(16)
y = pad
centered(d, f, y, "TACOS EL GORDO"); y += lh
centered(d, f, y, "*** CARD SLIP ***"); y += lh
divider(d, f, y); y += lh
row(d, f, y, "Amount", "35.85"); y += lh
text(d, f, 18, y, "Tip: ________"); hand(d, 250, y - 4, "6.50"); y += lh
text(d, f, 18, y, "Total: _______"); hand(d, 250, y - 4, "42.35"); y += lh * 2
centered(d, f, y, "VISA ****1234"); y += lh
save(img, "t7b_cardslip.png")

print("done")
