import { useEffect, useRef } from 'react';
import { readTheme, type Theme } from '../../render/theme';
import type { LevelSet } from '../../core/spice/noiseMargins';

interface DiagramProps {
  driver: LevelSet;
  receiver: LevelSet;
  maxV?: number;
  size?: { w: number; h: number };
}

// The classic noise-margin level diagram: driver output guarantees on the left,
// receiver input thresholds on the right, the two margins shaded between them.
export function NoiseMarginDiagram({
  driver,
  receiver,
  maxV = 5,
  size = { w: 460, h: 340 },
}: DiagramProps) {
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
      ctx.clearRect(0, 0, size.w, size.h);
      render(ctx, theme, driver, receiver, maxV, size);
    };

    draw();
    const observer = new MutationObserver(draw);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });
    return () => observer.disconnect();
  }, [driver, receiver, maxV, size]);

  return <canvas ref={canvasRef} className="nm-diagram" />;
}

function render(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  driver: LevelSet,
  receiver: LevelSet,
  maxV: number,
  size: { w: number; h: number },
): void {
  const top = 20;
  const bottom = size.h - 28;
  const y = (v: number) => bottom - (v / maxV) * (bottom - top);
  const barW = 90;
  const driverX = 90;
  const receiverX = size.w - 90 - barW;

  ctx.font = `${theme.canvasTextMin}px ${theme.fonts.mono}`;

  const column = (
    x: number,
    title: string,
    high: number,
    low: number,
    highLabel: string,
    lowLabel: string,
  ) => {
    ctx.strokeStyle = theme.colors.line;
    ctx.lineWidth = theme.strokes.min;
    ctx.strokeRect(x, top, barW, bottom - top);
    // Valid-high region (accent) and valid-low region (muted).
    ctx.fillStyle = theme.colors.accentFill;
    ctx.fillRect(x, y(maxV), barW, y(high) - y(maxV));
    ctx.fillStyle = theme.colors.surface;
    ctx.fillRect(x, y(low), barW, y(0) - y(low));
    for (const [v, label] of [
      [high, highLabel],
      [low, lowLabel],
    ] as const) {
      ctx.strokeStyle = theme.colors.ink;
      ctx.beginPath();
      ctx.moveTo(x, y(v));
      ctx.lineTo(x + barW, y(v));
      ctx.stroke();
      ctx.fillStyle = theme.colors.ink;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${label} ${v.toFixed(2)}`, x + 4, y(v) - 7);
    }
    ctx.fillStyle = theme.colors.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(title, x + barW / 2, bottom + 6);
  };

  column(driverX, 'driver out', driver.vohMin, driver.volMax, 'VOH', 'VOL');
  column(receiverX, 'receiver in', receiver.vihMin, receiver.vilMax, 'VIH', 'VIL');

  // Margin bands drawn across the gap between the columns.
  const gapL = driverX + barW;
  const gapR = receiverX;
  const band = (v0: number, v1: number, label: string) => {
    const ok = v1 >= v0;
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = ok ? theme.colors.ok : theme.colors.warn;
    ctx.fillRect(gapL, y(Math.max(v0, v1)), gapR - gapL, Math.abs(y(v1) - y(v0)));
    ctx.globalAlpha = 1;
    ctx.fillStyle = ok ? theme.colors.ok : theme.colors.warn;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${label} ${(v1 - v0).toFixed(2)}V`, (gapL + gapR) / 2, y((v0 + v1) / 2));
  };
  band(receiver.vihMin, driver.vohMin, 'NMH'); // VOH - VIH
  band(driver.volMax, receiver.vilMax, 'NML'); // VIL - VOL
}
