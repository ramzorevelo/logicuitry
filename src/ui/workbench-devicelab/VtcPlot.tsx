import { useEffect, useRef } from 'react';
import { drawPlot, type PlotSpec } from '../../render/plotXY';
import { readTheme } from '../../render/theme';
import { usePlotSize } from './usePlotSize';
import { useCanvasZoom } from './useCanvasZoom';
import type { SweepResult } from '../../core/spice/types';
import type { VtcMetrics } from '../../core/spice/vtcAnalysis';

interface VtcPlotProps {
  sweep: SweepResult;
  ghost: SweepResult | null;
  metrics: VtcMetrics;
  vdd: number;
}

const DESIGN_W = 560;
const DESIGN_H = 380;

export function VtcPlot({ sweep, ghost, metrics, vdd }: VtcPlotProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { ref: boxRef, box, scale } = usePlotSize(DESIGN_W, DESIGN_H);
  const { view, zoomed, fit, handlers } = useCanvasZoom(box.w, box.h);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const theme = readTheme();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = box.w * dpr;
      canvas.height = box.h * dpr;
      canvas.style.width = `${box.w}px`;
      canvas.style.height = `${box.h}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      // Two scales in one transform. `scale` fits the design-size figure to
      // the box, and is why the plot is laid out at its design size below: a
      // plot composed at 340px instead would put its own labels on top of each
      // other, as the noise diagram did. `zoom` magnifies on top of that.
      // Both go through the transform rather than onto the bitmap, so the
      // figure is redrawn at the final size and stays sharp.
      const k = scale * view.zoom;
      ctx.setTransform(dpr * k, 0, 0, dpr * k, -view.panX * dpr, -view.panY * dpr);

      const { vil, vih, vol, voh, vm } = metrics;
      const spec: PlotSpec = {
        size: { w: DESIGN_W, h: DESIGN_H },
        x: { min: 0, max: vdd, label: 'Vin (V)' },
        y: { min: 0, max: vdd, label: 'Vout (V)' },
        bands: [{ x0: vil, x1: vih, color: theme.colors.warn }], // forbidden zone
        rects: [
          { x0: 0, x1: vil, y0: vol, y1: 0, color: theme.colors.ok }, // NML
          { x0: vih, x1: vdd, y0: voh, y1: vdd, color: theme.colors.ok }, // NMH
        ],
        series: [
          ...(ghost
            ? [{ xs: ghost.vin, ys: ghost.vout, color: theme.colors.muted, dashed: true }]
            : []),
          { xs: sweep.vin, ys: sweep.vout, color: theme.colors.accent, widthPx: theme.strokes.bus },
        ],
        markers: [
          { x: vil, y: voh, label: `VIL ${vil.toFixed(2)}` },
          { x: vih, y: vol, label: `VIH ${vih.toFixed(2)}` },
          { x: vm, y: vm, label: `VM ${vm.toFixed(2)}` },
        ],
      };
      drawPlot(ctx, theme, spec);
    };

    draw();
    const observer = new MutationObserver(draw);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });
    return () => observer.disconnect();
  }, [sweep, ghost, metrics, vdd, box, scale, view]);

  // touch-action none so a drag zooms the plot instead of scrolling the page
  // out from under it: the surrounding controls stay where they are.
  return (
    <div className="plot-box" ref={boxRef}>
      <canvas ref={canvasRef} className="vtc-plot" {...handlers} />
      {zoomed && (
        <button type="button" className="plot-box__fit tool-btn" onClick={fit}>
          Fit
        </button>
      )}
    </div>
  );
}
