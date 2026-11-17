import { beforeEach, describe, expect, it } from 'vitest';
import { EXAMPLES } from '../../examples';
import { BUILTIN_LESSONS } from '../../examples/lessons';
import { useCircuitStore } from '../workbench-circuit/circuitStore';
import { useLessonStore } from './lessonStore';

const cs = () => useCircuitStore.getState();
const ls = () => useLessonStore.getState();
const computer = EXAMPLES.find((e) => e.id === 'eight-bit-bus-computer')!;
const lesson = BUILTIN_LESSONS.find((l) => l.id === 'bus-computer-program')!;

/** An eight-lane LED read MSB first, as on the board; NaN when a lane is not a known bit. */
function ledByte(id: string): number {
  let n = 0;
  for (let bit = 7; bit >= 0; bit--) {
    const lane = cs().pinRawValue(id, `a${bit}`);
    if (!lane || lane.x || lane.z) return NaN;
    n = (n << 1) | (lane.v & 1);
  }
  return n;
}
const flag = (id: string) => cs().pinRawValue(id, 'a')?.v;

function reading() {
  return {
    a: ledByte('leda'),
    b: ledByte('ledb'),
    bus: ledByte('bus'),
    cf: flag('ledcf'),
    zf: flag('ledzf'),
  };
}

// The prose states these; a lesson edit that breaks one is caught here.
const AFTER_STEP: Record<number, Partial<ReturnType<typeof reading>>> = {
  3: { a: 0, b: 0, bus: 0 },
  4: { a: 28, bus: 28 },
  5: { a: 28, bus: 1 },
  6: { a: 28, b: 14 },
  7: { a: 42, b: 14, bus: 56, cf: 0, zf: 0 },
  9: { a: 42, bus: 28 },
  10: { a: 28, cf: 1, zf: 0 },
  11: { a: 14, cf: 1, zf: 0 },
  12: { a: 0, cf: 1, zf: 1 },
  13: { a: 242, cf: 0, zf: 0 },
};

beforeEach(() => {
  ls().close();
  if (computer.chips?.length) cs().loadChipDefs(structuredClone(computer.chips));
  cs().loadBoard(structuredClone(computer.board));
});

describe('the bus computer program lesson', () => {
  it('reads what each step says, played straight through with every reveal', () => {
    ls().open(lesson);
    const seen: Record<number, ReturnType<typeof reading>> = {};
    for (let k = 0; k < lesson.steps.length; k++) {
      if (k > 0) ls().next();
      expect(ls().step).toBe(k);
      if (lesson.steps[k]!.kind === 'predict') ls().reveal();
      expect(ls().notes, `step ${k + 1}`).toEqual([]);
      seen[k] = reading();
    }
    for (const [k, want] of Object.entries(AFTER_STEP))
      expect(seen[Number(k)], `step ${Number(k) + 1}`).toMatchObject(want);
  });

  it('a predict step holds its pulse until Reveal', () => {
    ls().open(lesson);
    ls().jump(4);
    expect(reading()).toMatchObject({ a: 0, bus: 28 });
    ls().reveal();
    expect(reading()).toMatchObject({ a: 28 });
  });

  it('shows what the open-phase prose states before each reveal', () => {
    ls().open(lesson);
    ls().jump(7);
    expect(reading()).toMatchObject({ a: 28, b: 14, bus: 42 });
    ls().jump(9);
    expect(reading()).toMatchObject({ a: 42, bus: 28 });
  });

  it('refuses a part that is not a clock, and an unpowered board', () => {
    ls().open(lesson);
    ls().jump(3);
    const before = reading();
    expect(cs().pulseClockOnce('leda')).toBe('missing');
    expect(reading()).toEqual(before);
    cs().power();
    expect(cs().pulseClockOnce('clk')).toBe('off');
  });

  it('a jump replays the same board as playing through', () => {
    ls().open(lesson);
    ls().jump(12);
    ls().reveal();
    expect(reading()).toMatchObject(AFTER_STEP[12]!);
    ls().back();
    expect(reading()).toMatchObject(AFTER_STEP[11]!);
  });

  it('skips a pulse with a note while Run is on', () => {
    ls().open(lesson);
    ls().jump(2);
    cs().toggleRun();
    ls().next();
    expect(ls().notes).toEqual(['Clock pulse skipped: Run is on, so the clock is already running']);
    cs().toggleRun();
  });
});
