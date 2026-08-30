// I/O component glyphs: switch, LED, button,
// clock source, 7-segment (raw + decoded-hex), bit probe, bus value display.
// Same rule as gates.ts/chip.ts: body proportions are literal to the shared
// constants, only each pin's wire-attach tip is snapped onto the grid via
// symbol.ts's snap() -- several of these housings (switch/button at 1.5G x
// 2.5G) have an odd-G center, so their stub length ends up a bit longer or
// shorter than the nominal 1G. That's the same policy gates.ts documents, not
// a one-off fudge.

import type { Rect, Vec2 } from '../scene';
import { bodyRectPath, paintBody, paintEmphasis } from './relief';
import { signalStyle, type SignalState, type Theme } from '../theme';
import {
  bitState,
  drawStub,
  drawUprightText,
  measureMonoText,
  registerGlyphGeometry,
  snap,
  textRowCenter,
  textRowH,
  textRowTop,
  withPlacement,
  type GeometryInput,
  type Placement,
  type ResolvedPin,
  type SymbolGeometry,
} from './symbol';

// Shared-label text for IO devices: drawn
// only when the user named the device (label sharing); default ids never
// render. Placed on the side away from the pin stub, upright at any rotation.
export function drawDeviceLabel(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  placement: Placement,
  label: string | undefined,
  anchor: Vec2,
  inward: Vec2,
): void {
  if (!label) return;
  ctx.font = `${theme.glyphText}px ${theme.fonts.mono}`;
  ctx.fillStyle = theme.colors.ink;
  drawUprightText(ctx, placement, label, anchor, inward);
}

// --- Switch (DIP-style bit source) ---

export interface SwitchLayout {
  g: number;
  housing: Rect;
  lever: Rect; // rest position (off); on-state lever is drawn at the mirrored offset
  pinY: number;
  tipX: number;
  bounds: Rect;
  pins: Map<string, Vec2>;
}

export function switchLayout(g: number, outName: string): SwitchLayout {
  // Housing height matches a 2-bit DIP-bank switch (2 * 2G row pitch) so a
  // 1-bit switch reads as the same-height instrument, not a taller outlier
  // next to a bank. The lever itself (the part that actually moves on/off)
  // keeps that same 1.5G height and is kept SQUARE (width = height); housing
  // width is narrowed to just fit it with the usual 0.5G margin each side
  // (lever.w + g). Its travel divides the remaining vertical space evenly
  // in half between the two positions.
  const leverSide = 1.5 * g;
  const housing: Rect = { x: 0, y: 0, w: leverSide + g, h: 4 * g };
  const lever: Rect = { x: 0.5 * g, y: housing.h - 2 * g, w: leverSide, h: leverSide }; // resting (off)
  const pinY = snap(housing.h / 2, g);
  const tipX = snap(housing.w + 2 * g, g);
  const bounds: Rect = { x: 0, y: 0, w: tipX, h: housing.h };
  const pins = new Map<string, Vec2>([[outName, { x: tipX, y: pinY }]]);
  return { g, housing, lever, pinY, tipX, bounds, pins };
}

/** A toggle/led with more than one 'out'/'in' pin is lane-expanded: row
 *  order matches the primitive's own `order` (already bit-0-topmost, per
 *  `busPins.expandPin`). Collapsed (the common case) is exactly one pin,
 *  possibly width > 1. */
function outsSorted(input: GeometryInput): ResolvedPin[] {
  return input.pins.filter((p) => p.dir === 'out').sort((a, b) => a.order - b.order);
}
function insSorted(input: GeometryInput): ResolvedPin[] {
  return input.pins.filter((p) => p.dir === 'in').sort((a, b) => a.order - b.order);
}

registerGlyphGeometry('toggle', (input, theme) => {
  const outs = outsSorted(input);
  const width = outs.length > 1 ? outs.length : outs[0]!.width;
  if (width > 1) {
    const l = dipBankLayout(
      theme.gridSchematic,
      width,
      outs.map((p) => p.name),
    );
    return { bounds: l.bounds, pins: l.pins };
  }
  const l = switchLayout(theme.gridSchematic, outs[0]!.name);
  return { bounds: l.bounds, pins: l.pins };
});

/** width=1 keeps a single lever; width>1 dispatches to the DIP-bank, whether
 *  collapsed (one wide pin) or lane-expanded into individual bit pins.
 *  `rawOf` looks up a pin's own live BusValue by name -- both paths derive
 *  their fill from it via bitState. */
export function drawSwitch(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  input: GeometryInput,
  placement: Placement,
  rawOf: (pin: string) => { v: number; x: number; z: number },
  label?: string,
  // False when no simulation is running: the stub then draws in ink like every
  // other unpowered glyph, instead of colouring an all-X placeholder amber.
  live = true,
): void {
  const outs = outsSorted(input);
  const width = outs.length > 1 ? outs.length : outs[0]!.width;
  if (width > 1) {
    drawDipBank(ctx, theme, input, placement, rawOf, label, live);
    return;
  }
  const out = outs[0]!;
  const l = switchLayout(theme.gridSchematic, out.name);
  const state = bitState(rawOf(out.name));
  const on = state === '1';
  withPlacement(ctx, l.bounds, placement, () => {
    paintBody(ctx, theme, () => bodyRectPath(ctx, theme, l.housing), { rect: l.housing });

    const leverY = on ? l.housing.y + 0.5 * l.g : l.lever.y; // slides toward the top when actuated (bit = 1)
    ctx.beginPath();
    ctx.rect(l.lever.x, leverY, l.lever.w, l.lever.h);
    ctx.fillStyle = on ? signalStyle(theme, '1').color : theme.colors.surface;
    ctx.fill();
    ctx.strokeStyle = theme.colors.ink;
    ctx.stroke();

    drawStub(
      ctx,
      theme,
      { x: l.housing.w, y: l.pinY },
      { x: l.tipX, y: l.pinY },
      live ? state : undefined,
    );
    // Pin stub exits right, so the label sits left of the housing.
    drawDeviceLabel(ctx, theme, placement, label, { x: -0.5 * l.g, y: l.pinY }, { x: -1, y: 0 });
  });
}

// --- DIP-bank switch (width>1 toggle): a vertical stack of per-bit cells,
// MSB topmost per the bit-ordering rule, 2G pitch. ---

export interface DipBankLayout {
  g: number;
  width: number;
  housing: Rect;
  cellH: number;
  pinY: number;
  tipX: number;
  bounds: Rect;
  pins: Map<string, Vec2>;
}

/** Shared vertical-stack-of-`width`-1-bit-cells geometry (MSB topmost):
 *  the DIP-bank switch (pin on the right, interactive, 2G row pitch) and the
 *  LED array (pin on the left, display-only, slightly taller/wider rows for
 *  its per-cell arrows) are the same shape mirrored at different scale.
 *  `names` is either one collapsed bus pin name (one shared stub at the
 *  bank's vertical center) or `width` individual pin names in bit-0-topmost
 *  row order (each cell gets its own stub, wirable on its own). */
function bitBankLayout(
  g: number,
  width: number,
  names: readonly string[],
  pinSide: 'left' | 'right',
  cellH: number,
  housingW: number,
): DipBankLayout {
  const stub = 2 * g;
  const housingX = pinSide === 'right' ? 0 : stub;
  const housing: Rect = { x: housingX, y: 0, w: housingW, h: width * cellH };
  const pinY = snap(housing.h / 2, g);
  const tipX = pinSide === 'right' ? snap(housing.x + housing.w + stub, g) : 0;
  const boundsW = pinSide === 'right' ? tipX : housing.x + housing.w;
  const bounds: Rect = { x: 0, y: 0, w: boundsW, h: housing.h };
  const pins = new Map<string, Vec2>();
  if (names.length > 1) {
    names.forEach((name, row) => {
      const rowY = snap(row * cellH + cellH / 2, g);
      pins.set(name, { x: tipX, y: rowY });
    });
  } else {
    pins.set(names[0]!, { x: tipX, y: pinY });
  }
  return { g, width, housing, cellH, pinY, tipX, bounds, pins };
}

export function dipBankLayout(g: number, width: number, names: readonly string[]): DipBankLayout {
  return bitBankLayout(g, width, names, 'right', 2 * g, 3 * g); // 2G row pitch, same 3G width as the 1-bit housing
}

export function ledBankLayout(g: number, width: number, names: readonly string[]): DipBankLayout {
  return bitBankLayout(g, width, names, 'left', 3 * g, 3.5 * g); // taller/wider: room for each cell's own diode arrows
}

/** Bit index (MSB topmost) hit by a local Y in a DIP-bank's housing, or
 *  undefined outside it -- the store/canvas click handler resolves the
 *  toggled bit through this, kept pure for testing. Matches expandPin's own
 *  MSB-first row order (busPins.ts) -- row 0 (top) is the MSB. */
export function dipCellIndexAt(l: DipBankLayout, localY: number): number | undefined {
  if (localY < l.housing.y || localY >= l.housing.y + l.housing.h) return undefined;
  const row = Math.floor((localY - l.housing.y) / l.cellH);
  if (row < 0 || row >= l.width) return undefined;
  return l.width - 1 - row;
}

function drawDipBank(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  input: GeometryInput,
  placement: Placement,
  rawOf: (pin: string) => { v: number; x: number; z: number },
  label?: string,
  live = true,
): void {
  const outs = outsSorted(input);
  const expanded = outs.length > 1;
  const width = expanded ? outs.length : outs[0]!.width;
  const names = expanded ? outs.map((p) => p.name) : [outs[0]!.name];
  const l = dipBankLayout(theme.gridSchematic, width, names);
  const g = l.g;
  withPlacement(ctx, l.bounds, placement, () => {
    paintBody(ctx, theme, () => bodyRectPath(ctx, theme, l.housing), { rect: l.housing });

    for (let row = 0; row < l.width; row++) {
      const bit = l.width - 1 - row; // row 0 (top) is the MSB, per the bit-ordering rule
      const cellY = row * l.cellH;
      const state = expanded
        ? bitState(rawOf(names[row]!))
        : bitState(
            (({ v, x, z }) => ({ v: v >>> bit, x: x >>> bit, z: z >>> bit }))(rawOf(names[0]!)),
          );
      const on = state === '1';
      // A square lever, same 0.5G margin convention as the single switch's
      // 2G-square lever, but sliding horizontally (toward the pin side when
      // on) rather than vertically -- reads as that same switch rotated 90°.
      const side = l.cellH - g;
      const leverX = l.housing.x + (on ? l.housing.w - g - 0.5 * g : 0.5 * g);
      const leverY = cellY + 0.5 * g;
      ctx.beginPath();
      ctx.rect(leverX, leverY, side, side);
      ctx.fillStyle = on ? signalStyle(theme, '1').color : theme.colors.surface;
      ctx.fill();
      ctx.strokeStyle = theme.colors.ink;
      ctx.lineWidth = theme.strokes.wire;
      ctx.stroke();
      if (row > 0) {
        // Divider between cells.
        ctx.beginPath();
        ctx.moveTo(l.housing.x, cellY);
        ctx.lineTo(l.housing.x + l.housing.w, cellY);
        ctx.strokeStyle = theme.colors.line;
        ctx.lineWidth = theme.strokes.min;
        ctx.stroke();
      }
      if (expanded) {
        // Each expanded row is its own real pin -- its own wire-attach stub
        // at the row's center, colored by that row's own state.
        const rowY = snap(cellY + l.cellH / 2, g);
        drawStub(
          ctx,
          theme,
          { x: l.housing.w, y: rowY },
          { x: l.tipX, y: rowY },
          live ? state : undefined,
        );
      }
    }

    if (!expanded) {
      // Collapsed bus form: one shared stub, deliberately uncolored (no
      // single bit represents a whole bus).
      drawStub(ctx, theme, { x: l.housing.w, y: l.pinY }, { x: l.tipX, y: l.pinY });
    }
    // Pin stub exits right, so the label sits left of the housing.
    drawDeviceLabel(ctx, theme, placement, label, { x: -0.5 * g, y: l.pinY }, { x: -1, y: 0 });
  });
}

// --- Button (momentary) ---

/** Square housing (same 3G width as the switch, but 3G tall instead of 5G --
 *  the switch's lever needs travel room, the button's cap doesn't). `lever`
 *  is unused (drawButton draws its own circle cap directly) but kept on the
 *  shared SwitchLayout shape. */
export function buttonLayout(g: number, outName: string): SwitchLayout {
  const housing: Rect = { x: 0, y: 0, w: 3 * g, h: 3 * g };
  const lever: Rect = { x: 0, y: 0, w: 0, h: 0 };
  const pinY = snap(housing.h / 2, g);
  const tipX = snap(housing.w + 2 * g, g);
  const bounds: Rect = { x: 0, y: 0, w: tipX, h: housing.h };
  const pins = new Map<string, Vec2>([[outName, { x: tipX, y: pinY }]]);
  return { g, housing, lever, pinY, tipX, bounds, pins };
}

/** Center + radius of the button's circular cap, in the glyph's own local
 *  space -- the click target is the cap itself, not the square housing
 *  around it (the UI hit-test resolves world -> local first). */
export function buttonCapCircle(l: SwitchLayout): { cx: number; cy: number; r: number } {
  return { cx: l.housing.x + l.housing.w / 2, cy: l.housing.y + l.housing.h / 2, r: l.g };
}

registerGlyphGeometry('button', (input, theme) => {
  const out = input.pins.find((p) => p.dir === 'out')!;
  const l = buttonLayout(theme.gridSchematic, out.name);
  return { bounds: l.bounds, pins: l.pins };
});

export function drawButton(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  input: GeometryInput,
  placement: Placement,
  held: boolean,
  label?: string,
  // False when no simulation is running: the stub then draws in ink like every
  // other unpowered glyph, instead of colouring a synthesised 0 muted.
  live = true,
): void {
  const out = input.pins.find((p) => p.dir === 'out')!;
  const l = buttonLayout(theme.gridSchematic, out.name);
  withPlacement(ctx, l.bounds, placement, () => {
    paintBody(ctx, theme, () => bodyRectPath(ctx, theme, l.housing), { rect: l.housing });

    const { cx, cy, r } = buttonCapCircle(l);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2); // 2G-diameter cap per §4
    ctx.fillStyle = held ? signalStyle(theme, '1').color : theme.colors.surface;
    ctx.fill();
    ctx.strokeStyle = theme.colors.ink;
    ctx.stroke();

    drawStub(
      ctx,
      theme,
      { x: l.housing.w, y: l.pinY },
      { x: l.tipX, y: l.pinY },
      live ? (held ? '1' : '0') : undefined,
    );
    drawDeviceLabel(ctx, theme, placement, label, { x: -0.5 * l.g, y: l.pinY }, { x: -1, y: 0 });
  });
}

// --- LED (diode + cathode bar + two arrow strokes; the actual ANSI mark) ---

export interface LedLayout {
  g: number;
  H: number;
  topPad: number; // room above the triangle for the radiating arrows
  tipX: number; // apex/cathode side connecting tip
  pinY: number;
  anodeTipX: number; // input stub tip on the flat (anode) side
  bounds: Rect;
  pins: Map<string, Vec2>;
}

export function ledLayout(g: number, inName: string): LedLayout {
  const H = 4 * g; // same single-input height convention as NOT/BUF (H = 2G*2)
  const topPad = g; // arrows (shaft 1.5G + head, 0.5G clear of the edge) live here
  const apexRaw = 2 * g + 0.9 * H;
  const anodeTipX = 0; // input pin sits at the local origin, like every gate input
  // Bounds stop at the cathode bar: an LED has no output pin, so trailing stub
  // room would only be dead space in the hit box. The label draws outside, as
  // every device label does.
  const tipX = snap(apexRaw, g);
  const pinY = topPad + snap(H / 2, g);
  const bounds: Rect = { x: 0, y: 0, w: tipX, h: topPad + H };
  const pins = new Map<string, Vec2>([[inName, { x: anodeTipX, y: pinY }]]);
  return { g, H, topPad, tipX, pinY, anodeTipX, bounds, pins };
}

registerGlyphGeometry('led', (input, theme) => {
  const ins = insSorted(input);
  const width = ins.length > 1 ? ins.length : ins[0]!.width;
  if (width > 1) {
    const l = ledBankLayout(
      theme.gridSchematic,
      width,
      ins.map((p) => p.name),
    );
    return { bounds: l.bounds, pins: l.pins };
  }
  const l = ledLayout(theme.gridSchematic, ins[0]!.name);
  return { bounds: l.bounds, pins: l.pins };
});

/** width>1 draws a vertical bank of per-bit cells, MSB topmost, reusing the
 *  DIP-bank's shared geometry, whether collapsed (one wide pin) or
 *  lane-expanded into individual bit pins; width=1 keeps a single
 *  diode-arrow glyph. `rawOf` looks up a pin's own live BusValue by name --
 *  both paths derive their fill from it via bitState. */
export function drawLed(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  input: GeometryInput,
  placement: Placement,
  rawOf: (pin: string) => { v: number; x: number; z: number },
  label?: string,
  live = true,
): void {
  const ins = insSorted(input);
  const width = ins.length > 1 ? ins.length : ins[0]!.width;
  if (width > 1) {
    drawLedBank(ctx, theme, input, placement, rawOf, label, live);
    return;
  }
  const a = ins[0]!;
  const on = bitState(rawOf(a.name)) === '1';
  const l = ledLayout(theme.gridSchematic, a.name);
  const g = l.g;
  const bodyX0 = 2 * g; // one pitch of stub reserved on the input side
  const top = l.topPad;
  const apexX = bodyX0 + 0.9 * l.H;
  const midY = top + l.H / 2;
  withPlacement(ctx, l.bounds, placement, () => {
    const diode = () => {
      ctx.moveTo(bodyX0, top);
      ctx.lineTo(bodyX0, top + l.H);
      ctx.lineTo(apexX, midY);
      ctx.closePath();
    };
    ctx.beginPath();
    diode();
    ctx.fillStyle = on ? signalStyle(theme, '1').color : theme.colors.surface;
    ctx.strokeStyle = theme.colors.ink;
    ctx.lineWidth = theme.strokes.wire;
    ctx.fill();
    ctx.stroke();
    // A lit output is where emission earns its cost; unlit stays flat.
    if (on) paintEmphasis(ctx, theme, signalStyle(theme, '1').color, diode);

    // Cathode bar, perpendicular to the apex, same height as the triangle's base.
    ctx.beginPath();
    ctx.moveTo(apexX, top);
    ctx.lineTo(apexX, top + l.H);
    ctx.stroke();

    // Two parallel arrows radiating 45 degrees up-right, away from the body
    // (light leaves an LED): shaft ~1.5G plus an open head at the far end,
    // near end >= 0.5G clear of the triangle's upper edge.
    const u = Math.SQRT1_2; // unit 45-degree components
    const shaft = 1.5 * g;
    const head = 0.5 * g;
    for (const along of [0.25 * l.H, 0.5 * l.H]) {
      // Point on the upper edge at this x, then back off 0.5G perpendicular.
      const ex = bodyX0 + along;
      const edgeY = top + (along / (0.9 * l.H)) * (l.H / 2);
      const sx = ex + 0.5 * g * u;
      const sy = edgeY - 0.5 * g * u;
      const fx = sx + shaft * u;
      const fy = sy - shaft * u;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(fx, fy);
      // Open arrowhead: two strokes back from the far end.
      ctx.moveTo(fx - head, fy);
      ctx.lineTo(fx, fy);
      ctx.lineTo(fx, fy + head);
      ctx.stroke();
    }

    drawStub(
      ctx,
      theme,
      { x: l.anodeTipX, y: l.pinY },
      { x: bodyX0, y: l.pinY },
      live ? (on ? '1' : '0') : undefined,
    );
    // Pin stub enters on the left, so the label sits right of the cathode bar.
    drawDeviceLabel(
      ctx,
      theme,
      placement,
      label,
      { x: apexX + 0.5 * g, y: l.pinY },
      { x: 1, y: 0 },
    );
  });
}

// --- LED array (width>1 led): a vertical stack of per-bit cells, MSB
// topmost per the bit-ordering rule, mirroring the DIP-bank switch's shape
// (pin on the left since it's an input device) but display-only -- no
// per-cell hit-test (dipCellIndexAt stays switch-only). ---

function drawLedBank(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  input: GeometryInput,
  placement: Placement,
  rawOf: (pin: string) => { v: number; x: number; z: number },
  label?: string,
  live = true,
): void {
  const ins = insSorted(input);
  const expanded = ins.length > 1;
  const width = expanded ? ins.length : ins[0]!.width;
  const names = expanded ? ins.map((p) => p.name) : [ins[0]!.name];
  const l = ledBankLayout(theme.gridSchematic, width, names);
  const g = l.g;
  withPlacement(ctx, l.bounds, placement, () => {
    paintBody(ctx, theme, () => bodyRectPath(ctx, theme, l.housing), { rect: l.housing });

    for (let row = 0; row < l.width; row++) {
      const bit = l.width - 1 - row; // row 0 (top) is the MSB, per the bit-ordering rule
      const cellY = row * l.cellH;
      const state = expanded
        ? bitState(rawOf(names[row]!))
        : bitState(
            (({ v, x, z }) => ({ v: v >>> bit, x: x >>> bit, z: z >>> bit }))(rawOf(names[0]!)),
          );
      const on = state === '1';
      // The base (left edge) stays put; depth = halfH * sqrt(3) keeps the
      // single LED's own ~equilateral proportions at this smaller scale.
      const symMidY = cellY + l.cellH / 2;
      const triLeftX = l.housing.x + 0.5 * g;
      const triHalfH = 0.75 * g;
      const triRightX = triLeftX + triHalfH * Math.sqrt(3);
      const triTopY = symMidY - triHalfH;
      // Diode triangle+bar (the ANSI LED mark, scaled to the cell) --
      // distinguishes each cell as an LED, not a switch lever's plain rect.
      ctx.beginPath();
      ctx.moveTo(triLeftX, triTopY);
      ctx.lineTo(triLeftX, symMidY + triHalfH);
      ctx.lineTo(triRightX, symMidY);
      ctx.closePath();
      ctx.fillStyle = on ? signalStyle(theme, '1').color : theme.colors.surface;
      ctx.fill();
      ctx.strokeStyle = theme.colors.ink;
      ctx.lineWidth = theme.strokes.min;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(triRightX, symMidY - triHalfH);
      ctx.lineTo(triRightX, symMidY + triHalfH);
      ctx.stroke();

      // Two short arrows radiating up-right, staggered starting points to
      // the right of the cathode bar (never crossing its vertical line).
      const u = Math.SQRT1_2;
      const shaft = 0.8 * g;
      const head = 0.3 * g;
      const starts: Vec2[] = [
        { x: triRightX + 0.15 * g, y: symMidY - 0.55 * g },
        { x: triRightX + 0.45 * g, y: symMidY - 0.25 * g },
      ];
      for (const s of starts) {
        const fx = s.x + shaft * u;
        const fy = s.y - shaft * u;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(fx, fy);
        ctx.moveTo(fx - head, fy);
        ctx.lineTo(fx, fy);
        ctx.lineTo(fx, fy + head);
        ctx.stroke();
      }
      if (row > 0) {
        // Divider between cells.
        ctx.beginPath();
        ctx.moveTo(l.housing.x, cellY);
        ctx.lineTo(l.housing.x + l.housing.w, cellY);
        ctx.strokeStyle = theme.colors.line;
        ctx.lineWidth = theme.strokes.min;
        ctx.stroke();
      }
      if (expanded) {
        // Each expanded row is its own real pin -- its own wire-attach stub,
        // colored by that row's own state.
        const rowY = snap(cellY + l.cellH / 2, g);
        drawStub(
          ctx,
          theme,
          { x: 0, y: rowY },
          { x: l.housing.x, y: rowY },
          live ? state : undefined,
        );
      }
    }

    if (!expanded) {
      // No single bit state represents the whole bus (DIP-bank leaves its
      // stub uncolored the same way); each cell already shows its own bit.
      drawStub(ctx, theme, { x: 0, y: l.pinY }, { x: l.housing.x, y: l.pinY });
    }
    // Pin stub enters on the left, so the label sits right of the housing.
    drawDeviceLabel(
      ctx,
      theme,
      placement,
      label,
      { x: l.housing.x + l.housing.w + 0.5 * g, y: l.pinY },
      { x: 1, y: 0 },
    );
  });
}

// --- Clock source ---

export interface ClockLayout {
  g: number;
  boxW: number;
  boxH: number;
  pinY: number;
  tipX: number;
  bounds: Rect;
  pins: Map<string, Vec2>;
}

export function clockLayout(g: number, outName: string): ClockLayout {
  const boxW = 6 * g; // >= §4's 4G minimum; 1G margin around the 4G wave glyph
  const boxH = 4 * g;
  const pinY = snap(boxH / 2, g);
  const tipX = boxW + 2 * g; // already grid-clean, no rounding needed
  const bounds: Rect = { x: 0, y: 0, w: tipX, h: boxH };
  const pins = new Map<string, Vec2>([[outName, { x: tipX, y: pinY }]]);
  return { g, boxW, boxH, pinY, tipX, bounds, pins };
}

registerGlyphGeometry('clock', (input, theme) => {
  const out = input.pins.find((p) => p.dir === 'out')!;
  const l = clockLayout(theme.gridSchematic, out.name);
  return { bounds: l.bounds, pins: l.pins };
});

export function drawClock(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  input: GeometryInput,
  placement: Placement,
  label?: string,
): void {
  const out = input.pins.find((p) => p.dir === 'out')!;
  const l = clockLayout(theme.gridSchematic, out.name);
  withPlacement(ctx, l.bounds, placement, () => {
    const box = { x: 0, y: 0, w: l.boxW, h: l.boxH };
    paintBody(ctx, theme, () => bodyRectPath(ctx, theme, box), { rect: box });

    // Static square-wave silkscreen: two periods, half-period 1G, amplitude 2G.
    const cx = l.boxW / 2;
    const cy = l.boxH / 2;
    const half = l.g;
    const amp = l.g; // half-amplitude: 2G peak-to-peak inside the 4G box
    ctx.beginPath();
    ctx.strokeStyle = theme.colors.ink;
    ctx.lineWidth = theme.strokes.wire;
    let x = cx - 2 * half;
    ctx.moveTo(x, cy + amp);
    for (let i = 0; i < 4; i++) {
      const y = i % 2 === 0 ? cy - amp : cy + amp;
      ctx.lineTo(x, y);
      x += half;
      ctx.lineTo(x, y);
    }
    ctx.stroke();

    drawStub(ctx, theme, { x: l.boxW, y: l.pinY }, { x: l.tipX, y: l.pinY });
    // Pin stub exits right, so the label sits left of the box.
    drawDeviceLabel(ctx, theme, placement, label, { x: -0.5 * l.g, y: l.pinY }, { x: -1, y: 0 });
  });
}

// --- 7-segment display (raw a..g, and the decoded-hex variant) ---

const SEGMENT_ORDER = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const;
// Segment -> lit for hex digits 0-F, standard mapping.
const HEX_SEGMENTS: Record<number, string> = {
  0: 'abcdef',
  1: 'bc',
  2: 'abged',
  3: 'abgcd',
  4: 'fgbc',
  5: 'afgcd',
  6: 'afgedc',
  7: 'abc',
  8: 'abcdefg',
  9: 'abcfgd',
  10: 'abcefg',
  11: 'fgedc',
  12: 'afed',
  13: 'bgedc',
  14: 'afged',
  15: 'afge',
};

export interface SevenSegLayout {
  g: number;
  pinColumnHeight: number;
  digitW: number;
  digitH: number;
  digitX: number;
  digitY: number;
  bounds: Rect;
  pins: Map<string, Vec2>;
}

function sevenSegLayoutRaw(g: number, pinNames: string[]): SevenSegLayout {
  const pinColumnHeight = Math.max(1, pinNames.length) * g;
  const digitW = 2 * g;
  const digitH = 3 * g;
  const bodyX0 = g;
  const digitX = bodyX0;
  const digitY = snap((pinColumnHeight - digitH) / 2, g); // centered when the pin column is taller
  const height = Math.max(pinColumnHeight, digitH);
  const width = bodyX0 + digitW + g;
  const bounds: Rect = { x: 0, y: 0, w: width, h: height };
  const pins = new Map<string, Vec2>();
  pinNames.forEach((name, i) => pins.set(name, { x: 0, y: i * g }));
  return { g, pinColumnHeight, digitW, digitH, digitX, digitY: Math.max(0, digitY), bounds, pins };
}

registerGlyphGeometry('sevenseg', (input, theme) => {
  const ins = input.pins.filter((p) => p.dir === 'in').sort((a, b) => a.order - b.order);
  const l = sevenSegLayoutRaw(
    theme.gridSchematic,
    ins.map((p) => p.name),
  );
  return { bounds: l.bounds, pins: l.pins };
});
registerGlyphGeometry('sevenseghex', (input, theme) => {
  const ins = input.pins.filter((p) => p.dir === 'in').sort((a, b) => a.order - b.order);
  const l = sevenSegLayoutRaw(
    theme.gridSchematic,
    ins.map((p) => p.name),
  );
  return { bounds: l.bounds, pins: l.pins };
});

/** Bar geometry for each of the 7 segments, clipped-end rectangles around a digitW x digitH cell. */
function segmentBar(
  seg: string,
  x: number,
  y: number,
  w: number,
  h: number,
  thick: number,
): [Vec2, Vec2, number, number] {
  const half = w / 2;
  switch (seg) {
    case 'a':
      return [{ x: x + thick, y }, { x: x + w - thick, y }, w - 2 * thick, thick];
    case 'g':
      return [
        { x: x + thick, y: y + h / 2 },
        { x: x + w - thick, y: y + h / 2 },
        w - 2 * thick,
        thick,
      ];
    case 'd':
      return [{ x: x + thick, y: y + h }, { x: x + w - thick, y: y + h }, w - 2 * thick, thick];
    case 'f':
      return [{ x, y: y + thick }, { x, y: y + h / 2 - thick }, thick, h / 2 - 2 * thick];
    case 'b':
      return [
        { x: x + w, y: y + thick },
        { x: x + w, y: y + h / 2 - thick },
        thick,
        h / 2 - 2 * thick,
      ];
    case 'e':
      return [{ x, y: y + h / 2 + thick }, { x, y: y + h - thick }, thick, h / 2 - 2 * thick];
    case 'c':
      return [
        { x: x + w, y: y + h / 2 + thick },
        { x: x + w, y: y + h - thick },
        thick,
        h / 2 - 2 * thick,
      ];
    default:
      return [{ x, y }, { x, y }, 0, half];
  }
}

function drawDigit(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  l: SevenSegLayout,
  lit: Set<string>,
): void {
  const thick = 0.15 * l.g;
  for (const seg of SEGMENT_ORDER) {
    const [p0, , w, h] = segmentBar(seg, l.digitX, l.digitY, l.digitW, l.digitH, thick);
    ctx.beginPath();
    if (seg === 'a' || seg === 'd' || seg === 'g') ctx.rect(p0.x, p0.y - thick / 2, w, thick);
    else ctx.rect(p0.x - thick / 2, p0.y, thick, h);
    ctx.fillStyle = lit.has(seg) ? signalStyle(theme, '1').color : theme.colors.surface;
    ctx.fill();
    ctx.strokeStyle = theme.colors.ink;
    ctx.lineWidth = theme.strokes.min;
    ctx.stroke();
  }
  // Decimal point, lower right -- no driving pin on the raw primitive, static unlit.
  ctx.beginPath();
  ctx.arc(l.digitX + l.digitW + thick, l.digitY + l.digitH, thick, 0, Math.PI * 2);
  ctx.fillStyle = theme.colors.surface;
  ctx.fill();
  ctx.strokeStyle = theme.colors.ink;
  ctx.stroke();
}

export function drawSevenSeg(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  input: GeometryInput,
  placement: Placement,
  litSegments: ReadonlySet<string>,
): void {
  const ins = input.pins.filter((p) => p.dir === 'in').sort((a, b) => a.order - b.order);
  const l = sevenSegLayoutRaw(
    theme.gridSchematic,
    ins.map((p) => p.name),
  );
  withPlacement(ctx, l.bounds, placement, () => {
    drawDigit(ctx, theme, l, new Set(litSegments));
    ins.forEach((p, i) =>
      drawStub(
        ctx,
        theme,
        { x: 0, y: i * l.g },
        { x: l.g, y: i * l.g },
        litSegments.has(p.name) ? '1' : '0',
      ),
    );
  });
}

export function drawSevenSegHex(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  input: GeometryInput,
  placement: Placement,
  value: number | undefined,
): void {
  const ins = input.pins.filter((p) => p.dir === 'in').sort((a, b) => a.order - b.order);
  const l = sevenSegLayoutRaw(
    theme.gridSchematic,
    ins.map((p) => p.name),
  );
  const lit = new Set(value !== undefined ? HEX_SEGMENTS[value & 0xf]!.split('') : []);
  withPlacement(ctx, l.bounds, placement, () => {
    drawDigit(ctx, theme, l, lit);
    const pin = ins[0];
    if (pin) drawStub(ctx, theme, { x: 0, y: 0 }, { x: l.g, y: 0 });
  });
}

// --- Bit probe / bus value display: a stub into a narrow ink-outlined tag ---

export interface TagLayout {
  g: number;
  /** Row pitch: grows with the glyph text so presentation fits its own label. */
  rowH: number;
  /** Top edge of the row band (see symbol.ts's textRowTop); negative once a
   *  row is taller than 2G, so the band grows around the pin, not below it. */
  top: number;
  pinY: number;
  rectX: number;
  rectW: number;
  rectH: number;
  bounds: Rect;
  pins: Map<string, Vec2>;
}

/** Per-row display label: divider lines already separate the rows visually,
 *  so each gets its own bracket-indexed label instead of one shared centered
 *  one -- a single (collapsed) row keeps the plain, unbracketed text. Row 0
 *  is the MSB, so the index counts down. */
function rowLabel(text: string, rowCount: number, row: number): string {
  return rowCount > 1 ? `${text}[${rowCount - 1 - row}]` : text;
}

/** `pinNames.length > 1` (pinView-expanded) stacks one row per bit -- MSB
 *  topmost, same convention as the DIP-bank/LED-bank -- each with its own
 *  wireable stub and its own `name[i]` label; collapsed (the common case)
 *  is the original single-row shape. Box width is sized off the WIDEST row
 *  label (name[N-1], the longest bracket suffix), not the bare text. */
function tagLayout(
  g: number,
  pinNames: readonly string[],
  text: string,
  fontPx: number,
): TagLayout {
  const rowH = textRowH(g, fontPx);
  const rectH = pinNames.length * rowH;
  const top = textRowTop(g, rowH);
  const rectX = g;
  const widest = rowLabel(text, pinNames.length, 0); // row 0 holds the highest bit index
  const rectW = Math.max(2 * g, Math.ceil((measureMonoText(widest, fontPx) + g) / g) * g);
  const bounds: Rect = { x: 0, y: top, w: rectX + rectW, h: rectH };
  const pins = new Map<string, Vec2>();
  pinNames.forEach((name, row) => pins.set(name, { x: 0, y: textRowCenter(g, rowH, row) }));
  return { g, rowH, top, pinY: textRowCenter(g, rowH, 0), rectX, rectW, rectH, bounds, pins };
}

function tagPinNames(input: GeometryInput): string[] {
  return input.pins
    .filter((p) => p.dir === 'in')
    .sort((a, b) => a.order - b.order)
    .map((p) => p.name);
}

// Bounds text must match drawProbe's actual fallback (comp.label ?? comp.id)
// so geometry (hit-test/lasso/routing) never drifts from the drawn tag rect.
registerGlyphGeometry('probe', (input, theme) => {
  const names = tagPinNames(input);
  const l = tagLayout(
    theme.gridSchematic,
    names,
    input.name ?? input.id ?? names[0]!,
    theme.glyphText,
  );
  return { bounds: l.bounds, pins: l.pins };
});
registerGlyphGeometry('busdisplay', (input, theme) => {
  const names = tagPinNames(input);
  const l = tagLayout(
    theme.gridSchematic,
    names,
    input.name ?? input.id ?? names[0]!,
    theme.glyphText,
  );
  return { bounds: l.bounds, pins: l.pins };
});

/** `stateOf` looks up a row's own live state by its pin name -- a collapsed
 *  (width=1 or un-expanded bus) tag has exactly one row, so this degrades to
 *  the old single-state behavior automatically. */
function drawTag(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  input: GeometryInput,
  placement: Placement,
  label: string,
  stateOf: (pin: string) => SignalState | undefined,
): void {
  const names = tagPinNames(input);
  const l = tagLayout(theme.gridSchematic, names, label, theme.glyphText);
  const rowH = l.rowH;
  withPlacement(ctx, l.bounds, placement, () => {
    // One shared tag box tall enough for every row, one stub per row.
    ctx.beginPath();
    ctx.rect(l.rectX, l.top, l.rectW, l.rectH);
    ctx.fillStyle = theme.colors.surface;
    ctx.fill();
    ctx.strokeStyle = theme.colors.ink;
    ctx.lineWidth = theme.strokes.wire;
    ctx.stroke();
    names.forEach((name, row) => {
      const rowY = textRowCenter(l.g, rowH, row);
      const state = stateOf(name);
      drawStub(ctx, theme, { x: 0, y: rowY }, { x: l.rectX, y: rowY }, state);
      if (row > 0) {
        ctx.beginPath();
        ctx.moveTo(l.rectX, l.top + row * rowH);
        ctx.lineTo(l.rectX + l.rectW, l.top + row * rowH);
        ctx.strokeStyle = theme.colors.line;
        ctx.lineWidth = theme.strokes.min;
        ctx.stroke();
      }
    });
    // A single row still fills/dashes the whole box by its own state, same
    // as before this fix; multiple rows leave the shared box neutral (no
    // one bit represents the whole group), matching the DIP-bank convention.
    if (names.length === 1) {
      const rowState = stateOf(names[0]!);
      const style = rowState ? signalStyle(theme, rowState) : undefined;
      if (style) {
        ctx.beginPath();
        ctx.rect(l.rectX, l.top, l.rectW, l.rectH);
        ctx.fillStyle = style.color;
        ctx.globalAlpha = 0.25;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.setLineDash(style.dashed ? [5, 4] : []);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    ctx.font = `${theme.glyphText}px ${theme.fonts.mono}`;
    ctx.fillStyle = theme.colors.ink;
    names.forEach((_, row) => {
      const rowY = textRowCenter(l.g, rowH, row);
      drawUprightText(
        ctx,
        placement,
        rowLabel(label, names.length, row),
        // 'middle' textBaseline aligns to the font's metric mid-point, which
        // reads visibly above the divider-to-divider optical center for this
        // mono font -- a small downward nudge corrects it without touching
        // drawUprightText's shared baseline logic (used by every other glyph).
        { x: l.rectX + l.rectW / 2, y: rowY + theme.glyphText * 0.1 },
        { x: 0, y: 0 },
      );
    });
  });
}

/** Bit probe: names a net, fills by its live state (accent 1 / muted 0 / warn X / dashed Z).
 *  `stateOf` resolves a row's state by its own pin name (a0/a1/... when
 *  pinView-expanded, else the single collapsed pin). */
export function drawProbe(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  input: GeometryInput,
  placement: Placement,
  netName: string,
  stateOf: (pin: string) => SignalState | undefined,
): void {
  drawTag(ctx, theme, input, placement, netName, stateOf);
}

/** Bus value display: shows the live value text in the chosen radix (caller formats it). */
export function drawBusDisplay(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  input: GeometryInput,
  placement: Placement,
  label: string,
  stateOf: (pin: string) => SignalState | undefined,
): void {
  drawTag(ctx, theme, input, placement, label, stateOf);
}

// --- Board I/O pins (In port / Out port): KiCad-port style 5-sided polygon ---

export interface PortLayout {
  g: number;
  /** Row pitch: grows with the glyph text so presentation fits its own label. */
  rowH: number;
  /** Top edge of the row band (see symbol.ts's textRowTop); negative once a
   *  row is taller than 2G, so the body grows around the pin, not below it. */
  top: number;
  bodyX0: number; // left edge of the polygon body
  bodyX1: number; // right edge of the polygon body (tip included)
  tipDepth: number;
  pinY: number;
  tipX: number; // wire-attach tip (stub end)
  labelX: number; // horizontal center of the flat (non-tip) part
  height: number;
  isInput: boolean; // input primitive: tip + stub on the right
  bounds: Rect;
  pins: Map<string, Vec2>;
}

/** `pinNames.length > 1` (pinView-expanded) stacks one row per bit, MSB
 *  topmost -- same convention as every other bank glyph -- each with its
 *  own wireable stub on the tip side; collapsed keeps the single pointed
 *  5-sided port shape. Multi-row drops the pointed tip decoration in favor
 *  of a plain rect edge (like the DIP-bank simplifying its per-row shape),
 *  one stub per row instead of one shared tip vertex. */
export function portLayout(
  g: number,
  pinNames: readonly string[],
  label: string,
  isInput: boolean,
  fontPx: number,
): PortLayout {
  const rowH = textRowH(g, fontPx);
  const height = pinNames.length * rowH;
  const top = textRowTop(g, rowH);
  // Row 0's centre, which is where the tip vertex, the stub and the label all
  // sit. Constant across text scales by construction: the band grows around
  // it rather than pushing it down.
  const pinY = textRowCenter(g, rowH, 0);
  const tipDepth = g;
  // §3 box-width formula applied to the widest per-row label (name[N-1]),
  // plus the pointed tip.
  const widest = rowLabel(label, pinNames.length, 0); // row 0 holds the highest bit index
  const contentW = Math.max(2 * g, Math.ceil((measureMonoText(widest, fontPx) + g) / g) * g);
  const bodyW = contentW + tipDepth;
  const stub = 2 * g;
  let bodyX0: number;
  let bodyX1: number;
  let tipX: number;
  if (isInput) {
    bodyX0 = 0;
    bodyX1 = bodyW;
    tipX = bodyW + stub;
  } else {
    bodyX0 = stub;
    bodyX1 = stub + bodyW;
    tipX = 0;
  }
  const labelX = isInput ? bodyX0 + contentW / 2 : bodyX0 + tipDepth + contentW / 2;
  const bounds: Rect = { x: 0, y: top, w: isInput ? tipX : bodyX1, h: height };
  const pins = new Map<string, Vec2>();
  pinNames.forEach((name, row) => pins.set(name, { x: tipX, y: textRowCenter(g, rowH, row) }));
  return {
    g,
    rowH,
    top,
    bodyX0,
    bodyX1,
    tipDepth,
    pinY,
    tipX,
    labelX,
    height,
    isInput,
    bounds,
    pins,
  };
}

function portPinNames(input: GeometryInput, isInput: boolean): string[] {
  return input.pins
    .filter((p) => (isInput ? p.dir === 'out' : p.dir === 'in'))
    .sort((a, b) => a.order - b.order)
    .map((p) => p.name);
}

registerGlyphGeometry('inport', (input, theme) => {
  const names = portPinNames(input, true);
  const l = portLayout(theme.gridSchematic, names, input.name ?? input.kind, true, theme.glyphText);
  return { bounds: l.bounds, pins: l.pins };
});
registerGlyphGeometry('outport', (input, theme) => {
  const names = portPinNames(input, false);
  const l = portLayout(
    theme.gridSchematic,
    names,
    input.name ?? input.kind,
    false,
    theme.glyphText,
  );
  return { bounds: l.bounds, pins: l.pins };
});

export function drawPort(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  input: GeometryInput,
  placement: Placement,
  stateOf: (pin: string) => SignalState | undefined,
): void {
  const isInput = input.kind === 'inport';
  const names = portPinNames(input, isInput);
  const label = input.name ?? input.kind;
  const l = portLayout(theme.gridSchematic, names, label, isInput, theme.glyphText);
  const rowH = l.rowH;
  withPlacement(ctx, l.bounds, placement, () => {
    // P0.3 (M4.2): body fill stays neutral; only the pin stub color-codes the
    // live signal (drawStub below), matching every other primitive's glyph.
    const silhouette = () => {
      const yTop = l.top;
      const yBot = l.top + l.height;
      if (names.length > 1) {
        // Plain rect edge for the multi-row bank form (no single tip vertex
        // makes sense once there's more than one row).
        ctx.rect(l.bodyX0, yTop, l.bodyX1 - l.bodyX0, l.height);
      } else if (isInput) {
        // Flat left edge, pointed tip on the right (feeds the circuit).
        ctx.moveTo(l.bodyX0, yTop);
        ctx.lineTo(l.bodyX1 - l.tipDepth, yTop);
        ctx.lineTo(l.bodyX1, l.pinY);
        ctx.lineTo(l.bodyX1 - l.tipDepth, yBot);
        ctx.lineTo(l.bodyX0, yBot);
      } else {
        // Pointed tip on the left (reads from the circuit).
        ctx.moveTo(l.bodyX1, yTop);
        ctx.lineTo(l.bodyX0 + l.tipDepth, yTop);
        ctx.lineTo(l.bodyX0, l.pinY);
        ctx.lineTo(l.bodyX0 + l.tipDepth, yBot);
        ctx.lineTo(l.bodyX1, yBot);
      }
      ctx.closePath();
    };
    paintBody(ctx, theme, silhouette);

    names.forEach((name, row) => {
      const rowY = textRowCenter(l.g, rowH, row);
      const bodyEdge = isInput ? l.bodyX1 : l.bodyX0;
      drawStub(ctx, theme, { x: bodyEdge, y: rowY }, { x: l.tipX, y: rowY }, stateOf(name));
      if (row > 0) {
        ctx.beginPath();
        ctx.moveTo(l.bodyX0, l.top + row * rowH);
        ctx.lineTo(l.bodyX1, l.top + row * rowH);
        ctx.strokeStyle = theme.colors.line;
        ctx.lineWidth = theme.strokes.min;
        ctx.stroke();
      }
    });

    ctx.font = `${theme.glyphText}px ${theme.fonts.mono}`;
    ctx.fillStyle = theme.colors.ink;
    names.forEach((_, row) => {
      const rowY = textRowCenter(l.g, rowH, row);
      drawUprightText(
        ctx,
        placement,
        rowLabel(label, names.length, row),
        // Same optical-center nudge as the tag glyph's per-row labels.
        { x: l.labelX, y: rowY + theme.glyphText * 0.1 },
        { x: 0, y: 0 },
      );
    });
  });
}

export type { SymbolGeometry };
export { bitState };

// --- net label (KiCad local label) ------------------------------------------
//
// Deliberately NOT the port's pointed pentagon: a port is a boundary, a label
// is a join, and confusing the two is the mistake the shape exists to prevent.
// Plain text on a baseline rule with a small open anchor square at the attach
// point, which is where the wire meets it -- KiCad's own local-label form.

export interface NetLabelLayout {
  g: number;
  /** Half-side of the anchor square at the attach point. */
  anchor: number;
  textX: number;
  textY: number;
  /** Top edge of the row band; the name grows around the anchor, not below it. */
  top: number;
  width: number;
  height: number;
  bounds: Rect;
  pins: Map<string, Vec2>;
}

export function netLabelLayout(g: number, text: string, fontPx: number): NetLabelLayout {
  const rowH = textRowH(g, fontPx);
  const anchor = Math.max(2, Math.round(g / 4));
  // The pin sits at x=0 so a wire arriving from the left meets the anchor; the
  // text runs right from there, clear of the square.
  const textX = 2 * g;
  const contentW = Math.ceil((measureMonoText(text, fontPx) + g) / g) * g;
  const width = textX + Math.max(2 * g, contentW);
  const top = textRowTop(g, rowH);
  const textY = textRowCenter(g, rowH, 0);
  const pins = new Map<string, Vec2>([['a', { x: 0, y: textY }]]);
  return {
    g,
    anchor,
    textX,
    textY,
    top,
    width,
    height: rowH,
    bounds: { x: 0, y: top, w: width, h: rowH },
    pins,
  };
}

const netLabelText = (input: GeometryInput): string => input.name ?? input.id ?? '?';

registerGlyphGeometry('netlabel', (input, theme) => {
  const l = netLabelLayout(theme.gridSchematic, netLabelText(input), theme.glyphText);
  return { bounds: l.bounds, pins: l.pins };
});

export function drawNetLabel(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  input: GeometryInput,
  placement: Placement,
  stateOf: (pin: string) => SignalState | undefined,
): void {
  const text = netLabelText(input);
  const l = netLabelLayout(theme.gridSchematic, text, theme.glyphText);
  withPlacement(ctx, l.bounds, placement, () => {
    const state = stateOf('a');
    drawStub(ctx, theme, { x: l.textX, y: l.textY }, { x: 0, y: l.textY }, state);

    // Open anchor square: hollow so it reads as "attach here", not as a pin.
    ctx.beginPath();
    ctx.rect(-l.anchor, l.textY - l.anchor, l.anchor * 2, l.anchor * 2);
    ctx.fillStyle = theme.colors.surface;
    ctx.fill();
    ctx.strokeStyle = state ? signalStyle(theme, state).color : theme.colors.ink;
    ctx.lineWidth = theme.strokes.min;
    ctx.stroke();

    // Baseline rule under the name: the one mark that says "this is a net
    // name" rather than a stray caption.
    ctx.beginPath();
    ctx.moveTo(l.textX, l.top + l.height);
    ctx.lineTo(l.width, l.top + l.height);
    ctx.strokeStyle = theme.colors.line;
    ctx.lineWidth = theme.strokes.min;
    ctx.stroke();

    ctx.font = `${theme.glyphText}px ${theme.fonts.mono}`;
    ctx.fillStyle = theme.colors.ink;
    drawUprightText(
      ctx,
      placement,
      text,
      // Same optical-centre nudge the port and tag labels use.
      { x: l.textX + (l.width - l.textX) / 2, y: l.textY + theme.glyphText * 0.1 },
      { x: 0, y: 0 },
    );
  });
}
