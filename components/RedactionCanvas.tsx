'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * RedactionCanvas — client-side, manual PII redaction for receipt / tip-screen photos.
 *
 * The picked image is drawn onto a canvas entirely on-device: EXIF orientation is
 * applied, large photos are downscaled (longest side capped) so mobile stays fast,
 * and the ORIGINAL file never leaves the device. "Done" exports a compressed JPEG
 * of the edited image; that export is what gets uploaded and stored as the visible
 * (moderation) version. Zero boxes is fine — compression always applies.
 *
 * Gestures (mobile-first):
 *   - one finger: drag to draw a black redaction box; tap a box to select it
 *   - two fingers: pinch to zoom, drag to pan
 *   - mouse: drag to draw, wheel to zoom at cursor
 * Buttons cover the same actions for accessibility: undo, clear, delete-selected,
 * zoom in/out, reset view, cancel, done. `touch-action: none` on the canvas so the
 * page never scrolls mid-draw.
 *
 * Dependency-free: only DOM canvas APIs.
 */

interface RedactionCanvasProps {
  file: File;
  /** e.g. 'Receipt photo' — shown in the editor title. */
  kindLabel: string;
  onDone: (redacted: File) => void;
  onCancel: () => void;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface View {
  scale: number;
  tx: number;
  ty: number;
}

/** Longest side of the working image, px — keeps mobile canvas work cheap. */
const MAX_SIDE = 1600;
/** Exported JPEG quality. */
const JPEG_QUALITY = 0.82;
/** Boxes smaller than this (image px) are discarded as accidental taps. */
const MIN_BOX = 8;
/** Pointer travel (CSS px) below this counts as a tap, not a drag. */
const TAP_SLOP = 10;
/** Max zoom relative to the fit-to-screen scale. */
const MAX_ZOOM_REL = 10;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function normalizeBox(x: number, y: number, w: number, h: number): Box {
  return {
    x: w < 0 ? x + w : x,
    y: h < 0 ? y + h : y,
    w: Math.abs(w),
    h: Math.abs(h),
  };
}

/** Decode with EXIF orientation applied; falls back to <img> when needed. */
async function loadBitmap(file: File): Promise<ImageBitmap> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // fall through to the <img> path
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not decode this image.'));
      el.src = url;
    });
    // Browsers apply EXIF orientation when decoding into <img>.
    return await createImageBitmap(img);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function RedactionCanvas({
  file,
  kindLabel,
  onDone,
  onCancel,
}: RedactionCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null); // downscaled working image
  const fitRef = useRef(1); // fit-to-screen scale, the zoom floor
  const viewRef = useRef<View>({ scale: 1, tx: 0, ty: 0 });
  const boxesRef = useRef<Box[]>([]);
  const selectedRef = useRef<number | null>(null);
  const draftRef = useRef<Box | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef<
    | { mode: 'draw'; startImg: { x: number; y: number }; moved: boolean }
    | { mode: 'pinch'; d0: number; mid0: { x: number; y: number }; view0: View }
    | null
  >(null);

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);

  const setBoxesBoth = (next: Box[]) => {
    boxesRef.current = next;
    setBoxes(next);
  };
  const setSelectedBoth = (next: number | null) => {
    selectedRef.current = next;
    setSelected(next);
  };

  // ---- coordinate helpers -------------------------------------------------
  const viewSize = () => {
    const c = canvasRef.current;
    return { w: c ? c.clientWidth : 0, h: c ? c.clientHeight : 0 };
  };
  const toImage = (px: number, py: number, v?: View): { x: number; y: number } => {
    const vv = v ?? viewRef.current;
    return { x: (px - vv.tx) / vv.scale, y: (py - vv.ty) / vv.scale };
  };
  const clampView = (v: View): View => {
    const base = baseRef.current;
    const { w: cw, h: ch } = viewSize();
    if (!base || cw === 0 || ch === 0) return v;
    const minS = fitRef.current;
    const maxS = Math.min(minS * MAX_ZOOM_REL, 6);
    const scale = clamp(v.scale, minS, maxS);
    const iw = base.width * scale;
    const ih = base.height * scale;
    const margin = 80;
    return {
      scale,
      tx: clamp(v.tx, margin - iw, cw - margin),
      ty: clamp(v.ty, margin - ih, ch - margin),
    };
  };
  const setView = (v: View) => {
    viewRef.current = clampView(v);
    draw();
  };

  // ---- painting -----------------------------------------------------------
  function draw() {
    const canvas = canvasRef.current;
    const base = baseRef.current;
    if (!canvas || !base) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (cw === 0 || ch === 0) return;
    const bw = Math.round(cw * dpr);
    const bh = Math.round(ch * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    const v = viewRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg =
      getComputedStyle(document.documentElement).getPropertyValue('--surface-2').trim() ||
      '#222';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cw, ch);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(base, v.tx, v.ty, base.width * v.scale, base.height * v.scale);

    const paintBox = (b: Box, alpha: number) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#000';
      ctx.fillRect(b.x * v.scale + v.tx, b.y * v.scale + v.ty, b.w * v.scale, b.h * v.scale);
      ctx.globalAlpha = 1;
    };
    boxesRef.current.forEach((b, i) => {
      paintBox(b, 1);
      if (i === selectedRef.current) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.setLineDash([7, 5]);
        ctx.strokeRect(
          b.x * v.scale + v.tx - 3,
          b.y * v.scale + v.ty - 3,
          b.w * v.scale + 6,
          b.h * v.scale + 6,
        );
        ctx.setLineDash([]);
      }
    });
    if (draftRef.current) paintBox(draftRef.current, 0.55);
  }

  const fit = () => {
    const base = baseRef.current;
    const { w: cw, h: ch } = viewSize();
    if (!base || cw === 0 || ch === 0) return;
    const s = Math.min(cw / base.width, ch / base.height);
    fitRef.current = s;
    viewRef.current = {
      scale: s,
      tx: (cw - base.width * s) / 2,
      ty: (ch - base.height * s) / 2,
    };
    draw();
  };

  // ---- image loading ------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const bmp = await loadBitmap(file);
        if (cancelled) {
          if (typeof bmp.close === 'function') bmp.close();
          return;
        }
        const down = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
        const w = Math.max(1, Math.round(bmp.width * down));
        const h = Math.max(1, Math.round(bmp.height * down));
        const base = document.createElement('canvas');
        base.width = w;
        base.height = h;
        const bctx = base.getContext('2d');
        if (!bctx) throw new Error('Canvas is not available in this browser.');
        bctx.drawImage(bmp, 0, 0, w, h);
        if (typeof bmp.close === 'function') bmp.close();
        baseRef.current = base;
        setStatus('ready');
        // Fit after layout settles so clientWidth is real.
        requestAnimationFrame(() => {
          if (!cancelled) fit();
        });
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error
              ? e.message
              : 'Could not open this photo. Please try a JPG or PNG.',
          );
          setStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // file is fixed for this mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- overlay chrome: lock scroll, escape cancels, resize redraws --------
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => draw())
        : null;
    if (ro && canvasRef.current) ro.observe(canvasRef.current);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener('keydown', onKey);
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- gestures -----------------------------------------------------------
  const canvasPos = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (status !== 'ready') return;
    e.preventDefault();
    canvasRef.current?.setPointerCapture(e.pointerId);
    const pos = canvasPos(e);
    pointersRef.current.set(e.pointerId, pos);
    if (pointersRef.current.size === 1) {
      gestureRef.current = { mode: 'draw', startImg: toImage(pos.x, pos.y), moved: false };
      draftRef.current = null;
    } else if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      const d0 = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      gestureRef.current = {
        mode: 'pinch',
        d0,
        mid0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        view0: { ...viewRef.current },
      };
      draftRef.current = null;
      draw();
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (!g || !pointersRef.current.has(e.pointerId)) return;
    const pos = canvasPos(e);
    pointersRef.current.set(e.pointerId, pos);
    if (g.mode === 'draw') {
      const cur = toImage(pos.x, pos.y);
      // Movement is measured in CSS px from the pointerdown spot: below the
      // slop it's a tap (select), above it it's a box draw.
      const startPx = {
        x: g.startImg.x * viewRef.current.scale + viewRef.current.tx,
        y: g.startImg.y * viewRef.current.scale + viewRef.current.ty,
      };
      if (Math.hypot(pos.x - startPx.x, pos.y - startPx.y) > TAP_SLOP) g.moved = true;
      if (g.moved) {
        draftRef.current = normalizeBox(g.startImg.x, g.startImg.y, cur.x - g.startImg.x, cur.y - g.startImg.y);
        draw();
      }
    } else {
      const [a, b] = [...pointersRef.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const s1 = g.view0.scale * (d / g.d0);
      // Keep the image point under the gesture-start midpoint glued to the live midpoint.
      const anchor = toImage(g.mid0.x, g.mid0.y, g.view0);
      setView({
        scale: s1,
        tx: mid.x - anchor.x * s1,
        ty: mid.y - anchor.y * s1,
      });
    }
  };

  const hitBox = (px: number, py: number): number | null => {
    for (let i = boxesRef.current.length - 1; i >= 0; i--) {
      const b = boxesRef.current[i];
      if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return i;
    }
    return null;
  };

  const endPointer = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    pointersRef.current.delete(e.pointerId);
    if (!g) return;
    if (g.mode === 'draw' && pointersRef.current.size === 0) {
      if (!g.moved) {
        // Tap: select the topmost box under the finger, else deselect.
        const p = toImage(canvasPos(e).x, canvasPos(e).y);
        setSelectedBoth(hitBox(p.x, p.y));
      } else if (draftRef.current) {
        const d = draftRef.current;
        if (d.w >= MIN_BOX && d.h >= MIN_BOX) {
          setBoxesBoth([...boxesRef.current, d]);
          setSelectedBoth(boxesRef.current.length - 1);
        }
      }
      draftRef.current = null;
      gestureRef.current = null;
      draw();
    } else if (g.mode === 'pinch' && pointersRef.current.size < 2) {
      gestureRef.current = null;
    }
  };

  // Wheel zoom (desktop), attached natively so we can preventDefault.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      if (status !== 'ready') return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const v = viewRef.current;
      const s1 = v.scale * (e.deltaY < 0 ? 1.18 : 1 / 1.18);
      const anchor = toImage(px, py, v);
      setView({ scale: s1, tx: px - anchor.x * s1, ty: py - anchor.y * s1 });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // ---- toolbar actions ----------------------------------------------------
  const zoomBy = (factor: number) => {
    const { w: cw, h: ch } = viewSize();
    const v = viewRef.current;
    const s1 = v.scale * factor;
    const anchor = toImage(cw / 2, ch / 2, v);
    setView({ scale: s1, tx: cw / 2 - anchor.x * s1, ty: ch / 2 - anchor.y * s1 });
  };

  const undo = () => {
    if (boxesRef.current.length === 0) return;
    const next = boxesRef.current.slice(0, -1);
    setBoxesBoth(next);
    if (selectedRef.current != null && selectedRef.current >= next.length) {
      setSelectedBoth(null);
    }
    draw();
  };

  const clearAll = () => {
    setBoxesBoth([]);
    setSelectedBoth(null);
    draw();
  };

  const deleteSelected = () => {
    const i = selectedRef.current;
    if (i == null) return;
    const next = boxesRef.current.filter((_, idx) => idx !== i);
    setBoxesBoth(next);
    setSelectedBoth(null);
    draw();
  };

  const done = () => {
    const base = baseRef.current;
    if (!base || exporting) return;
    setExporting(true);
    // Paint at full working resolution so the stored copy stays legible.
    const out = document.createElement('canvas');
    out.width = base.width;
    out.height = base.height;
    const ctx = out.getContext('2d');
    if (!ctx) {
      setExporting(false);
      setError('Could not export the image in this browser.');
      return;
    }
    ctx.drawImage(base, 0, 0);
    ctx.fillStyle = '#000';
    for (const b of boxesRef.current) ctx.fillRect(b.x, b.y, b.w, b.h);
    out.toBlob(
      (blob) => {
        setExporting(false);
        if (!blob) {
          setError('Could not export the image in this browser.');
          return;
        }
        onDone(new File([blob], 'redacted.jpg', { type: 'image/jpeg' }));
      },
      'image/jpeg',
      JPEG_QUALITY,
    );
  };

  // ---- render -------------------------------------------------------------
  const toolBtn: React.CSSProperties = {
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid var(--line)',
    background: 'var(--surface)',
    color: 'var(--ink)',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    touchAction: 'manipulation',
    whiteSpace: 'nowrap',
  };
  const toolBtnDisabled: React.CSSProperties = { ...toolBtn, opacity: 0.4, cursor: 'default' };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Redact ${kindLabel}`}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg)',
      }}
    >
      {/* top bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          borderBottom: '1px solid var(--line)',
          background: 'var(--surface)',
        }}
      >
        <button type="button" style={toolBtn} onClick={onCancel} disabled={exporting}>
          Cancel
        </button>
        <div style={{ flex: 1, textAlign: 'center', minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--ink)' }}>
            Black out private info
          </div>
          <div
            style={{
              fontSize: 12,
              color: 'var(--muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {kindLabel} · the original never leaves your device
          </div>
        </div>
        <button
          type="button"
          onClick={done}
          disabled={exporting || status !== 'ready'}
          style={{
            ...toolBtn,
            background: 'var(--yellow)',
            borderColor: 'var(--yellow)',
            color: '#181916',
            opacity: exporting || status !== 'ready' ? 0.5 : 1,
          }}
        >
          {exporting ? 'Saving…' : 'Done'}
        </button>
      </div>

      {/* canvas */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            touchAction: 'none',
            cursor: 'crosshair',
          }}
        />
        {status === 'loading' && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--muted)',
              fontSize: 14,
            }}
          >
            Opening photo…
          </div>
        )}
        {status === 'error' && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              alignItems: 'center',
              justifyContent: 'center',
              padding: 24,
              textAlign: 'center',
              color: 'var(--ink)',
              fontSize: 14,
            }}
          >
            <div>{error || 'Could not open this photo.'}</div>
            <button type="button" style={toolBtn} onClick={onCancel}>
              Choose a different photo
            </button>
          </div>
        )}
      </div>

      {/* hint */}
      <div
        style={{
          padding: '6px 12px 0',
          fontSize: 12,
          color: 'var(--muted)',
          textAlign: 'center',
        }}
      >
        Drag to black out names, card numbers, codes · two fingers to zoom &amp; pan · tap a
        box to select it
      </div>

      {/* bottom toolbar */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          padding: '10px 12px calc(12px + env(safe-area-inset-bottom))',
          borderTop: '1px solid var(--line)',
          background: 'var(--surface)',
          overflowX: 'auto',
        }}
      >
        <button
          type="button"
          style={boxes.length === 0 ? toolBtnDisabled : toolBtn}
          onClick={undo}
          disabled={boxes.length === 0}
          aria-label="Undo last box"
        >
          Undo
        </button>
        <button
          type="button"
          style={boxes.length === 0 ? toolBtnDisabled : toolBtn}
          onClick={clearAll}
          disabled={boxes.length === 0}
        >
          Clear
        </button>
        <button
          type="button"
          style={selected == null ? toolBtnDisabled : toolBtn}
          onClick={deleteSelected}
          disabled={selected == null}
        >
          Delete
        </button>
        <span style={{ flex: 1 }} />
        <button type="button" style={toolBtn} onClick={() => zoomBy(1 / 1.4)} aria-label="Zoom out">
          −
        </button>
        <button type="button" style={toolBtn} onClick={() => zoomBy(1.4)} aria-label="Zoom in">
          +
        </button>
        <button type="button" style={toolBtn} onClick={fit}>
          Reset view
        </button>
      </div>
    </div>
  );
}
