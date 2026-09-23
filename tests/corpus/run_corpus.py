#!/usr/bin/env python3
"""Regression corpus for the VLM receipt-extraction contract.

Uses the REAL prompt + validation from lib/vlm-extract.ts (dumped via tsx),
runs each corpus image through Gemini, and scores field-by-field against
ground truth. Re-run after any prompt/contract change.
"""
import json
import os
import subprocess
import sys

APP = os.path.expanduser("~/workspace/tipshame-app")
CORPUS = os.path.join(APP, "tests/corpus")
CLI = os.path.expanduser("~/workspace/skills/gemini/bin/gemini_generate.py")
REAL_RECEIPT = os.path.expanduser(
    "~/workspace/user/media_library/image/64/6473b9251de7ef37b3dba5b0536038b4f02e0db850c27f1f96c82ae77aaeec63.png")
SYNTH0 = "/tmp/test_receipt.jpg"

# images, ground truth
CASES = [
    ("t0_synthetic", [SYNTH0], {
        "venue": "MIGHTY BOWL", "currency": "USD", "subtotal": 16.00,
        "tax": 1.66, "presets": [15, 20, 25], "tip": 3.20, "fees": None,
        "paidTotal": 20.86, "tipPercentage": 20.0, "taxBase": "pre"}),
    ("t1_paper_handwritten", ["t1_paper_handwritten.png"], {
        "venue": "LUIGI'S PIZZA", "currency": "USD", "subtotal": 42.50,
        "tax": 4.36, "presets": [15, 18, 20], "tip": 8.50, "fees": None,
        "paidTotal": 55.36, "tipPercentage": 20.0, "taxBase": "pre"}),
    ("t2_chinese", ["t2_chinese.png"], {
        "venue": "老北京炸酱面馆", "currency": None, "subtotal": 68.00,
        "tax": 6.80, "presets": [15, 18, 20], "tip": 13.60,
        "fees": [("Service Fee", 3.40)], "paidTotal": 91.80,
        "tipPercentage": 20.0, "taxBase": "pre"}),
    ("t3_card_slip", ["t3_card_slip.png"], {
        "venue": "BLUE BOTTLE COFFEE", "currency": "USD", "subtotal": 18.75,
        "tax": 1.88, "presets": None, "tip": 3.75, "fees": None,
        "paidTotal": 24.38, "tipPercentage": 20.0, "taxBase": "pre"}),
    ("t4_fees", ["t4_fees.png"], {
        "venue": "SEASIDE GRILL", "currency": "USD", "subtotal": 120.00,
        "tax": 12.36, "presets": [18, 20, 22], "tip": 24.00,
        "fees": [("Service Charge", 6.00), ("Card Surcharge", 3.60)],
        "paidTotal": 165.96, "tipPercentage": 20.0, "taxBase": "pre"}),
    ("t5_notip", ["t5_notip.png"], {
        "venue": "POKE BOWL EXPRESS", "currency": "USD", "subtotal": 14.95,
        "tax": 1.54, "presets": None, "tip": None, "fees": None,
        "paidTotal": 16.49, "tipPercentage": None, "taxBase": "unknown"}),
    ("t6_vat_eur", ["t6_vat_eur.png"], {
        "venue": "CAFÉ LUMIÈRE", "currency": "EUR", "subtotal": 48.00,
        "tax": None, "presets": None, "tip": 7.20, "fees": None,
        "paidTotal": 55.20, "tipPercentage": 15.0, "taxBase": "unknown"}),
    ("t7_two_images", ["t7a_itemized.png", "t7b_cardslip.png"], {
        "venue": "TACOS EL GORDO", "currency": "USD", "subtotal": 32.50,
        "tax": 3.35, "presets": [15, 18, 20], "tip": 6.50, "fees": None,
        "paidTotal": 42.35, "tipPercentage": 20.0, "taxBase": "pre"}),
    ("t8_real_clover", [REAL_RECEIPT], {
        "venue": "PAIK'S NOODLE", "currency": "USD", "subtotal": 61.85,
        "tax": 6.62, "presets": None, "tip": 10.27, "fees": None,
        "paidTotal": 78.74, "tipPercentage": 15.0, "taxBase": "post"}),
]

FIELDS = ["venue", "currency", "subtotal", "tax", "presets", "tip",
          "fees", "paidTotal", "tipPercentage", "taxBase"]


def dump_prompt():
    r = subprocess.run(
        ["npx", "tsx", "-e",
         "import {EXTRACTION_PROMPT} from './lib/vlm-extract'; process.stdout.write(EXTRACTION_PROMPT)"],
        cwd=APP, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return r.stdout


def validate(raw):
    r = subprocess.run(
        ["npx", "tsx", "-e",
         "import {validateExtraction} from './lib/vlm-extract';"
         "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{"
         "const v=validateExtraction(JSON.parse(s));"
         "process.stdout.write(JSON.stringify(v));});"],
        cwd=APP, input=json.dumps(raw), capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def money_eq(a, b):
    if a is None or b is None:
        return a is None and b is None
    return abs(a - b) < 0.011


def field_ok(field, got, want):
    if field in ("subtotal", "tax", "tip", "paidTotal", "tipPercentage"):
        return money_eq(got, want)
    if field == "venue":
        if got is None or want is None:
            return got is None and want is None
        g, w = got.lower(), want.lower()
        return w in g or g in w
    if field == "currency":
        return (got or "").upper() == (want or "").upper() or (got is None and want is None)
    if field == "presets":
        if got is None or want is None:
            return got is None and want is None
        return sorted(got) == sorted(want)
    if field == "fees":
        if got is None or want is None:
            return got is None and want is None
        if len(got) != len(want):
            return False
        for (wl, wa) in want:
            if not any(wl.lower() in (g.get("label") or "").lower()
                       and money_eq(g.get("amount"), wa) for g in got):
                return False
        return True
    return got == want


def main():
    prompt = dump_prompt()
    totals = {f: [0, 0] for f in FIELDS}
    for name, imgs, want in CASES:
        paths = [i if os.path.isabs(i) else os.path.join(CORPUS, i) for i in imgs]
        cmd = [sys.executable, CLI, "--prompt", prompt, "--model",
               "gemini-3-flash-preview", "--json", "--timeout", "120"]
        for p in paths:
            cmd += ["--image", p]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        if r.returncode != 0:
            print(f"{name}: MODEL CALL FAILED\n{r.stderr[:300]}")
            for f in FIELDS:
                totals[f][1] += 1
            continue
        try:
            raw = json.loads(r.stdout)
        except json.JSONDecodeError:
            print(f"{name}: BAD JSON\n{r.stdout[:300]}")
            for f in FIELDS:
                totals[f][1] += 1
            continue
        got = validate(raw)
        if got is None:
            print(f"{name}: VALIDATION REJECTED")
            for f in FIELDS:
                totals[f][1] += 1
            continue
        marks = []
        for f in FIELDS:
            ok = field_ok(f, got.get(f), want.get(f))
            totals[f][0] += 1 if ok else 0
            totals[f][1] += 1
            marks.append("✓" if ok else f"✗(got {got.get(f)!r})")
        print(f"{name}:\n  {' '.join(marks)}\n  notes={got.get('notes')!r}")
    print("\nFIELD SCORES (passed/total):")
    for f in FIELDS:
        p, t = totals[f]
        print(f"  {f}: {p}/{t}")


if __name__ == "__main__":
    main()
