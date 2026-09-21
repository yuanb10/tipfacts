/**
 * OCR layer for TipFacts (Sprint 1).
 *
 * Wraps the `tesseract` CLI binary if it is installed. Everything here is
 * defensive by design: tesseract may be absent (apt install was in progress
 * during development), and we must NEVER fabricate OCR output. Any OCR
 * problem — missing binary, bad image, parse error — returns null so the
 * caller can fall back to the manual path.
 */

import { execFile, execFileSync } from 'child_process';
import fs from 'fs';

export interface OcrWord {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  conf: number; // tesseract word confidence, 0-100; -1 = no text
  lineNum: number; // tesseract line grouping id
}

export interface OcrResult {
  words: OcrWord[];
  rawText: string;
  meanConfidence: number; // 0-100 over words with conf >= 0
}

let cached: boolean | null = null;

/** True when the `tesseract` binary is on PATH. Cached after first check. */
export function isOcrAvailable(): boolean {
  if (cached !== null) return cached;
  try {
    // execFileSync-style check without spawning a shell.
    execFileSync('tesseract', ['--version'], { stdio: 'ignore', timeout: 5000 });
    cached = true;
  } catch {
    cached = false;
  }
  return cached;
}

function runTesseract(imagePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // `tesseract <img> stdout tsv` — TSV to stdout, level-5 word rows.
    execFile('tesseract', [imagePath, 'stdout', 'tsv'], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, _stderr) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** Parse `tesseract stdout tsv` output into word rows (level === 5). */
function parseTsv(tsv: string): OcrWord[] {
  const lines = tsv.trim().split('\n');
  if (lines.length < 2) return [];
  const header = lines[0].split('\t');
  const idx = (name: string) => header.indexOf(name);
  const iLevel = idx('level');
  const iText = idx('text');
  const iConf = idx('conf');
  const iLeft = idx('left');
  const iTop = idx('top');
  const iWidth = idx('width');
  const iHeight = idx('height');
  const iLineNum = idx('line_num');
  if ([iLevel, iText, iConf, iLeft, iTop, iWidth, iHeight, iLineNum].some((i) => i < 0)) {
    throw new Error('Unexpected tesseract TSV header: ' + lines[0]);
  }
  const words: OcrWord[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split('\t');
    if (parseInt(cols[iLevel], 10) !== 5) continue; // word rows only
    const text = (cols[iText] ?? '').trim();
    if (!text) continue;
    const conf = parseFloat(cols[iConf]);
    const left = parseInt(cols[iLeft], 10);
    const top = parseInt(cols[iTop], 10);
    const width = parseInt(cols[iWidth], 10);
    const height = parseInt(cols[iHeight], 10);
    if ([left, top, width, height].some((n) => !Number.isFinite(n))) continue;
    words.push({
      text,
      x0: left,
      y0: top,
      x1: left + width,
      y1: top + height,
      conf: Number.isFinite(conf) ? conf : -1,
      lineNum: parseInt(cols[iLineNum], 10) || 0,
    });
  }
  return words;
}

function reconstructText(words: OcrWord[]): string {
  // Rebuild lines: cluster by y (tesseract's line_num is unreliable —
  // it resets per paragraph and often repeats), sort by x within each line.
  return groupWordsIntoLines(words)
    .map((ws) => ws.map((w) => w.text).join(' '))
    .join('\n');
}

/**
 * Cluster words into visual text lines by y-coordinate.
 *
 * Do NOT use tesseract's `line_num` for this: it is scoped per paragraph
 * and in practice repeats (e.g. every line of a receipt can report
 * line_num=1), which collapses the whole image into one mega-line and
 * breaks both PII adjacency and value parsing. Y-clustering is robust for
 * roughly horizontal receipt text.
 */
export function groupWordsIntoLines(words: OcrWord[]): OcrWord[][] {
  const sorted = [...words].sort(
    (a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2,
  );
  const heights = sorted.map((w) => w.y1 - w.y0).sort((a, b) => a - b);
  const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 12;
  const tolerance = Math.max(4, medianH * 0.6);
  const lines: OcrWord[][] = [];
  for (const w of sorted) {
    const yc = (w.y0 + w.y1) / 2;
    const last = lines[lines.length - 1];
    if (last) {
      const lastYc =
        last.reduce((s, x) => s + (x.y0 + x.y1) / 2, 0) / last.length;
      if (Math.abs(yc - lastYc) <= tolerance) {
        last.push(w);
        continue;
      }
    }
    lines.push([w]);
  }
  for (const line of lines) line.sort((a, b) => a.x0 - b.x0);
  return lines;
}

/**
 * Run OCR on an image file. Returns null on ANY failure (missing binary,
 * unreadable image, tesseract error, TSV parse error) — callers must treat
 * null as "OCR unavailable", never as "image had no text". This function
 * never throws for OCR problems.
 */
export async function runOcr(imagePath: string): Promise<OcrResult | null> {
  try {
    if (!isOcrAvailable()) return null;
    if (!fs.existsSync(imagePath)) return null;
    const tsv = await runTesseract(imagePath);
    const words = parseTsv(tsv);
    const confs = words.map((w) => w.conf).filter((c) => c >= 0);
    const meanConfidence = confs.length
      ? confs.reduce((a, b) => a + b, 0) / confs.length
      : 0;
    return { words, rawText: reconstructText(words), meanConfidence };
  } catch {
    return null;
  }
}
