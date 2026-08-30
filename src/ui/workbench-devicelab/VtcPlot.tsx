import { useEffect, useRef } from 'react';
import { drawPlot, type PlotSpec } from '../../render/plotXY';
import { readTheme } from '../../render/theme';
import type { SweepResult } from '../../core/spice/types';
import type { VtcMetrics } from '../../core/spice/vtcAnalysis';

interface VtcPlotProps {
  sweep: SweepResult;
  ghost: SweepResult | null;
  metrics: VtcMetrics;
  vdd: number;
  size?: { w: number; h: number };
}

export function VtcPlot({ sweep, ghost, metrics, vdd, size = { w: 560, h: 380 } }: VtcPlotProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const theme = readTheme();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = size.w * dpr;
      canvas.height = size.h * dpr;
      canvas.style.width = `${size.w}px`;
      canvas.style.height = `${size.h}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const { vil, vih, vol, voh, vm } = metrics;
      const spec: PlotSpec = {
        size,
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
  }, [sweep, ghost, metrics, vdd, size]);

  return <canvas ref={canvasRef} className="vtc-plot" />;
}
