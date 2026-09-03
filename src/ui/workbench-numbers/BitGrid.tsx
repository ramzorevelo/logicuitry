import { useEffect, useRef, useState } from 'react';
import type { BusValue } from '../../core/value/busValue';
import { toUnsigned } from '../../core/numkit/format';
import { expApproach } from '../../render/anim';
import {
  borrowBandH,
  columnAtPoint,
  defaultMetrics,
  drawBitRow,
  drawCaret,
  layoutBitRow,
  nearestBitAtPoint,
  scaleMetrics,
  topBandH,
  type BorrowMarks,
  type WeightMode,
} from '../../render/bitGrid';
import { readTheme } from '../../render/theme';
import {
  applyInput,
  applyKey,
  applyPaste,
  copyText,
  dragTo,
  span,
  type BitEntry,
  type BitSel,
} from './bitEntry';

interface BitGridProps {
  value: BusValue;
  width: number;
  highlight?: ReadonlySet<number> | undefined;
  /** Would-be value shown as an eased overlay on changed cells; never committed. */
  preview?: BusValue | undefined;
  editable?: boolean;
  /** Column weights above the cells (Convert tab). */
  weights?: WeightMode | undefined;
  /** Where the wider gap falls: 4 for hex nibbles, 3 for octal triplets. */
  groupBits?: number;
  /** Carry-in per lane, MSB-left string; drawn above the cells (Compute result). */
  carries?: string | undefined;
  /** Borrow notation over a minuend row (Compute, SUB by borrowing). */
  borrows?: BorrowMarks | undefined;
  onToggleBit?: (bit: number) => void;
  onHoverBit?: ((bit: number | undefined) => void) | undefined;
  /** Typed binary entry. Present only on editable rows; the overlay lays the
   *  row out at uniform pitch so one <input> can sit across the cells. */
  onTypeBits?: ((text: string) => void) | undefined;
  /** MSB-left digits, exactly `width` long. Editing overwrites in place, so a
   *  bit outside the edited span is never disturbed and the row never shifts. */
  text?: string | undefined;
}

// Canvas bit row: React owns the element, the render/ helpers own the pixels.
// Highlight intensity eases per cell so emphasis pulses in rather than snapping;
// a hover preview overlay fades in on cells whose result bit would change.
export function BitGrid({
  value,
  width,
  highlight,
  preview,
  editable,
  weights,
  groupBits = 4,
  carries,
  borrows,
  onToggleBit,
  onHoverBit,
  onTypeBits,
  text,
}: BitGridProps) {
  const typed = editable === true && onTypeBits !== undefined;
  // Caret/selection are column indices, MSB-left, and are drawn on the canvas:
  // nothing here depends on how the browser lays the hidden field's text out.
  const [sel, setSel] = useState<BitSel | null>(null);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // `beforeinput` is listened to natively and reads the live entry from here:
  // a software keyboard reports what it inserted, not which key was pressed.
  const entryRef = useRef<{ entry: BitEntry; commit: (next: BitEntry) => void } | null>(null);
  const dragging = useRef(false);
  const moved = useRef(false);
  const selSpan = sel ? span(sel) : null;
  const topH = borrows
    ? borrowBandH
    : weights !== undefined || carries !== undefined
      ? topBandH
      : 0;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const intensity = useRef<Map<number, number>>(new Map());
  const previewAlpha = useRef(0);
  const raf = useRef(0);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const theme = readTheme();
      const metrics = rowMetrics();
      const layout = layoutBitRow(width, 4, 4 + topH, metrics, groupBits);
      const dpr = window.devicePixelRatio || 1;
      const w = layout.width + 8;
      const h = layout.height + 8 + topH;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      let settled = true;
      for (let bit = 0; bit < width; bit++) {
        const target = highlight?.has(bit) ? 1 : 0;
        const next = expApproach(intensity.current.get(bit) ?? 0, target);
        intensity.current.set(bit, next);
        if (next !== target) settled = false;
      }
      drawBitRow(ctx, theme, layout, {
        value,
        intensity: (bit) => intensity.current.get(bit) ?? 0,
        ...(weights !== undefined && { weights }),
        ...(carries !== undefined && { carries }),
        ...(borrows !== undefined && { borrows }),
        ...(typed && focused && selSpan && selSpan.end > selSpan.start && { selection: selSpan }),
      });
      if (typed && focused && selSpan && selSpan.end === selSpan.start)
        drawCaret(ctx, theme, layout, selSpan.start);

      // Hover-preview overlay: eased-follower alpha (render/anim vocabulary) on
      // just the cells whose bit would flip.
      const pTarget = preview ? 1 : 0;
      previewAlpha.current = expApproach(previewAlpha.current, pTarget);
      if (previewAlpha.current !== pTarget) settled = false;
      if (preview && previewAlpha.current > 0.01) {
        const cur = toUnsigned(value, width);
        const nxt = toUnsigned(preview, width);
        const fontPx = Math.max(theme.canvasTextMin, Math.round(metrics.cellH * 0.5));
        ctx.save();
        ctx.globalAlpha = previewAlpha.current;
        for (const { bit, rect } of layout.cells) {
          const willBe = (nxt >>> bit) & 1;
          if (willBe === ((cur >>> bit) & 1)) continue;
          ctx.fillStyle = theme.colors.surface;
          ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
          ctx.strokeStyle = theme.colors.accent;
          ctx.lineWidth = theme.strokes.min;
          ctx.setLineDash([4, 3]);
          ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
          ctx.setLineDash([]);
          ctx.fillStyle = theme.colors.accent;
          ctx.font = `${fontPx}px ${theme.fonts.mono}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(willBe), rect.x + rect.w / 2, rect.y + rect.h / 2);
        }
        ctx.restore();
      }

      if (!settled) raf.current = requestAnimationFrame(draw);
    };

    draw();
    // Redraw when theme/presentation flips (class/attr on <html>).
    const observer = new MutationObserver(draw);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf.current);
    };
  }, [
    value,
    width,
    highlight,
    preview,
    weights,
    groupBits,
    carries,
    borrows,
    topH,
    typed,
    focused,
    selSpan?.start,
    selSpan?.end,
  ]);

  // Software keyboards report the composed edit, not a key, and Android often
  // sends no usable `key` at all -- this is the phone's route into the same
  // overwrite model the desktop keydown path uses.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onBeforeInput = (e: Event) => {
      const live = entryRef.current;
      if (!live) return;
      const ev = e as InputEvent;
      const next = applyInput(live.entry, ev.inputType, ev.data);
      e.preventDefault();
      if (next) live.commit(next);
    };
    el.addEventListener('beforeinput', onBeforeInput);
    return () => el.removeEventListener('beforeinput', onBeforeInput);
  }, [typed]);

  // Rendered during SSR smoke tests too, where there is no document to ask.
  // Presentation mode: +0.5 on top of the value-entry section's own 1.5x zoom.
  // A cell never shrinks to fit the viewport -- a 32-bit row scrolls instead,
  // because a bit box small enough to fit a phone is too small to press.
  const rowMetrics = () =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('presentation')
      ? scaleMetrics(2)
      : defaultMetrics;
  const cellH = rowMetrics().cellH;

  // Every pointer lookup goes through the CANVAS rect, never the event target:
  // the typed-entry overlay is inset from the canvas, so measuring against it
  // shifted every hit-test by the inset and the row's own top band.
  const localPoint = (clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return undefined;
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const rowLayout = () => layoutBitRow(width, 4, 4 + topH, rowMetrics(), groupBits);

  const bitAtClient = (clientX: number, clientY: number) => {
    const pt = localPoint(clientX, clientY);
    return pt && nearestBitAtPoint(rowLayout(), pt.x, pt.y);
  };

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!editable || !onToggleBit) return;
    const bit = bitAtClient(e.clientX, e.clientY);
    if (bit !== undefined) onToggleBit(bit);
  };

  const canvas = (
    <canvas
      ref={canvasRef}
      className={`bit-grid${editable ? ' bit-grid--editable' : ''}`}
      onClick={onClick}
      onMouseMove={onHoverBit ? (e) => onHoverBit(bitAtClient(e.clientX, e.clientY)) : undefined}
      onMouseLeave={onHoverBit ? () => onHoverBit(undefined) : undefined}
    />
  );
  if (!typed) return <div className="bit-grid-scroll">{canvas}</div>;

  const bits = (text ?? '').padStart(width, '0').slice(-width);
  const entry = { bits, sel: sel ?? { anchor: 0, head: width } };
  const commit = (next: { bits: string; sel: BitSel }) => {
    setSel(next.sel);
    if (next.bits !== bits) onTypeBits?.(next.bits);
  };
  // Caret column, not a cell: a click always lands on the nearest leading
  // edge, so a gap between cells resolves to the boundary it looks like.
  const colAt = (e: React.PointerEvent) => {
    const pt = localPoint(e.clientX, e.clientY);
    return pt ? columnAtPoint(rowLayout(), pt.x) : 0;
  };

  entryRef.current = { entry, commit };

  return (
    <div className="bit-grid-scroll">
      <div className="bit-grid-wrap">
        {canvas}
        {/* A focus and keyboard sink only: its text is never shown and its own
          layout is irrelevant, because the caret and selection are drawn on the
          canvas from column indices (bitEntry.ts owns the model). */}
        <input
          ref={inputRef}
          className="bit-grid__entry"
          aria-label="binary value"
          spellCheck={false}
          inputMode="numeric"
          enterKeyHint="done"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          value={bits}
          // Not readOnly: a read-only field raises no software keyboard. Every
          // edit is intercepted (keydown here, beforeinput below), so the field's
          // own text is never actually mutated.
          onChange={() => {
            // Controlled by `bits`; edits arrive through the interceptors.
          }}
          style={{ top: 4 + topH, height: cellH }}
          onFocus={() => {
            setFocused(true);
            setSel((cur) => cur ?? { anchor: 0, head: width });
          }}
          onBlur={() => {
            setFocused(false);
            dragging.current = false;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') {
              e.currentTarget.blur();
              return;
            }
            if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
              e.preventDefault();
              void navigator.clipboard?.writeText(copyText(entry));
              return;
            }
            const next = applyKey(entry, {
              key: e.key,
              shift: e.shiftKey,
              ctrl: e.ctrlKey || e.metaKey,
            });
            if (!next) return;
            e.preventDefault();
            commit(next);
          }}
          onPaste={(e) => {
            e.preventDefault();
            commit(applyPaste(entry, e.clipboardData.getData('text')));
          }}
          onPointerDown={(e) => {
            const col = colAt(e);
            dragging.current = true;
            moved.current = false;
            setSel({ anchor: col, head: col });
            // A synthetic pointer (tests, automation) has no active capture.
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              // capture is an optimisation, not a requirement
            }
          }}
          onPointerMove={(e) => {
            // The field covers the cells, so the row's own hover preview has to
            // be fed from here or it never fires again.
            onHoverBit?.(bitAtClient(e.clientX, e.clientY));
            if (!dragging.current) return;
            moved.current = true;
            const col = colAt(e);
            setSel((cur) => (cur ? dragTo(cur, col) : cur));
          }}
          onPointerLeave={() => onHoverBit?.(undefined)}
          onPointerUp={(e) => {
            // A click with no drag still toggles the bit, as it always has
            // (click bits, as in the prototypes).
            if (dragging.current && !moved.current) {
              const bit = bitAtClient(e.clientX, e.clientY);
              if (bit !== undefined) onToggleBit?.(bit);
            }
            dragging.current = false;
            try {
              e.currentTarget.releasePointerCapture(e.pointerId);
            } catch {
              // never captured
            }
          }}
        />
      </div>
    </div>
  );
}
