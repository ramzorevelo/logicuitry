import { describe, expect, it } from 'vitest';
import { parseStimulus, StimulusError } from './stimulus';
import { BLANK, digitOf } from './runBoard';

describe('parseStimulus', () => {
  it('fills the defaults a short step leaves out', () => {
    expect(parseStimulus({ steps: [{ ticks: 2 }] })).toEqual({
      watch: [],
      steps: [{ press: [], release: [], set: {}, ticks: 2, waitMs: 0, expect: {} }],
    });
  });

  it('takes one name or a list for press, release and watch', () => {
    const s = parseStimulus({
      clock: 'CLK',
      watch: 'U1.5',
      steps: [{ press: ['A', 'B'], release: 'C', set: { SEL: 'b', N: 3 }, wait: { ms: 2 } }],
    });
    expect(s.clock).toBe('CLK');
    expect(s.watch).toEqual(['U1.5']);
    expect(s.steps[0]).toMatchObject({
      press: ['A', 'B'],
      release: ['C'],
      set: { SEL: 'b', N: 3 },
      waitMs: 2,
    });
  });

  it.each([
    [[], 'expected a JSON object'],
    [{ steps: 1 }, 'steps: expected a list'],
    [{ steps: [], speed: 2 }, 'unknown key "speed"'],
    [{ steps: [{ tick: 1 }] }, 'steps[0]: unknown key "tick"'],
    [{ steps: [{ ticks: -1 }] }, 'steps[0].ticks'],
    [{ steps: [{ ticks: 1.5 }] }, 'steps[0].ticks'],
    [{ steps: [{ wait: 5 }] }, 'steps[0].wait'],
    [{ steps: [{ wait: { ms: 0 } }] }, 'steps[0].wait'],
    [{ steps: [{ ticks: 1, wait: { ms: 1 } }] }, 'not both'],
    [{ steps: [{ set: { A: 'c' } }] }, 'steps[0].set.A'],
    [{ steps: [{ set: { A: -1 } }] }, 'steps[0].set.A'],
    [{ steps: [{ press: '' }] }, 'steps[0].press'],
    [{ steps: [{ expect: { Y: true } }] }, 'steps[0].expect.Y'],
    [{ steps: [{ note: 3 }] }, 'steps[0].note'],
    [{ clock: '', steps: [] }, 'clock: expected a name'],
  ])('refuses %j, naming the field', (raw, message) => {
    expect(() => parseStimulus(raw)).toThrow(StimulusError);
    expect(() => parseStimulus(raw)).toThrow(message);
  });

  it('takes an expect straight after a set, refuses one after a press', () => {
    const { steps } = parseStimulus({ steps: [{ set: { A: 1 }, expect: { Y: 0 } }] });
    expect(steps[0]).toMatchObject({ set: { A: 1 }, ticks: 0, waitMs: 0, expect: { Y: 0 } });
    expect(() => parseStimulus({ steps: [{ press: 'GO', expect: { Y: 1 } }] })).toThrow(
      'press/release needs ticks or wait',
    );
    expect(() =>
      parseStimulus({ steps: [{ press: 'GO', ticks: 1, expect: { Y: 1 } }] }),
    ).not.toThrow();
    expect(() => parseStimulus({ steps: [{ expect: { Y: 1 } }] })).not.toThrow();
  });
});

describe('digitOf', () => {
  it.each([
    ['abcdef', '0'],
    ['bc', '1'],
    ['abdeg', '2'],
    ['abcdg', '3'],
    ['bcfg', '4'],
    ['acdfg', '5'],
    ['acdefg', '6'],
    ['abc', '7'],
    ['abcdefg', '8'],
    ['abcdfg', '9'],
  ])('reads %s as %s', (lit, digit) => expect(digitOf(lit)).toBe(digit));

  it("reads the '47/'48 tailless 6 and 9 and a 7 drawn with f", () => {
    expect(digitOf('cdefg')).toBe('6');
    expect(digitOf('abcfg')).toBe('9');
    expect(digitOf('abcf')).toBe('7');
  });

  it('reads a dark display as blank and any other pattern as ?', () => {
    expect(digitOf('')).toBe(BLANK);
    expect(digitOf('dg')).toBe('?');
    expect(digitOf('a')).toBe('?');
  });
});
