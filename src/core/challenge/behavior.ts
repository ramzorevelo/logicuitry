import { compile, componentPaths } from '../model/compile';
import type {
  Board,
  Challenge,
  ChallengeTruthTable,
  ChipLibrary,
  TimingSetting,
} from '../model/types';
import {
  BidirectionalPinError,
  MAX_TABLE_INPUTS,
  StoredStateError,
  buildTruthTable,
  resolveInputNet,
  resolveOutputNet,
} from '../boolean/truthTable';
import { BooleanEvalError } from '../boolean/evaluate';
import { lowerCircuit, lowerLibrary } from '../gates/lower';
import { datasheetDelay, idealDelay, type DelayModel } from '../sim/delay';
import { ledLitValue } from '../sim/primitives/stimulus';
import * as bv from '../value/busValue';
import { runBoard, type RunFailure, type RunRow } from '../runner/runBoard';
import { parseStimulus, StimulusError, type Stimulus, type StimulusStep } from '../runner/stimulus';
import { resolveName, type NameRole } from './names';

export interface TestsReport {
  total: number;
  passed: number;
  failures: RunFailure[];
  rows: RunRow[];
  /** Why the run stopped, and at which step; steps from there on did not pass. */
  error?: { step: number; message: string };
  /** Board-level component ids the failures name, for select and pan. */
  components: string[];
}

export interface TableRowResult {
  inputs: (0 | 1)[];
  expected: (0 | 1 | null)[];
  /** Per output, as read: `0`, `1`, `X` or `Z`. */
  actual: string[];
  ok: boolean;
}

export interface TableReport {
  rows: TableRowResult[];
  matched: number;
  /** Set when no table could be built; `rows` is then empty. */
  error?: string;
  components: string[];
}

export interface BehaviorReport {
  timing: TimingSetting['mode'];
  tests?: TestsReport;
  table?: TableReport;
}

export const delayOf = (t: TimingSetting): DelayModel =>
  t.mode === 'datasheet' ? datasheetDelay(t.datasheet, t.vendor) : idealDelay;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Renames every key of a step to the compiled name, or names the first that cannot resolve. */
function resolveStep(board: Board, step: StimulusStep): StimulusStep | string {
  const name = (raw: string, role: NameRole, passThrough: boolean): string => {
    const m = resolveName(board, raw, role);
    if (m.found) return m.path;
    if (passThrough && m.missing) return raw.trim();
    throw new StimulusError(m.error);
  };
  const keyed = <T>(rec: Record<string, T>, role: NameRole, passThrough: boolean) =>
    Object.fromEntries(Object.entries(rec).map(([k, v]) => [name(k, role, passThrough), v]));
  try {
    return {
      ...step,
      press: step.press.map((n) => name(n, 'input', false)),
      release: step.release.map((n) => name(n, 'input', false)),
      set: keyed(step.set, 'input', false),
      // A net label or a DIP pin is no output part: the runner reads it by name.
      expect: keyed(step.expect, 'output', true),
    };
  } catch (e) {
    if (e instanceof StimulusError) return e.message;
    throw e;
  }
}

function testsReport(board: Board, library: ChipLibrary, challenge: Challenge, delay: DelayModel) {
  const fail = (message: string, step = 0, total = 0): TestsReport => ({
    total,
    passed: 0,
    failures: [],
    rows: [],
    error: { step, message },
    components: [],
  });
  let parsed: Stimulus;
  try {
    parsed = parseStimulus(challenge.tests);
  } catch (e) {
    return fail(errorText(e));
  }
  const total = parsed.steps.length;
  let stop: { step: number; message: string } | undefined;
  const steps: StimulusStep[] = [];
  for (const [i, step] of parsed.steps.entries()) {
    const resolved = resolveStep(board, step);
    if (typeof resolved === 'string') {
      stop = { step: i, message: resolved };
      break;
    }
    steps.push(resolved);
  }
  let clock = parsed.clock;
  if (clock !== undefined) {
    const m = resolveName(board, clock, 'clock');
    if (m.found) clock = m.path;
    else if (!m.missing) return fail(m.error, 0, total);
  }
  const watch: string[] = [];
  for (const w of parsed.watch) {
    const m = resolveName(board, w, 'output');
    if (!m.found && !m.missing) return fail(m.error, 0, total);
    watch.push(m.found ? m.path : w.trim());
  }

  let result;
  try {
    result = runBoard(board, library, { ...(clock ? { clock } : {}), watch, steps }, delay);
  } catch (e) {
    return fail(errorText(e), 0, total);
  }
  if (result.error !== undefined) {
    const m = /^step (\d+): (.*)$/s.exec(result.error);
    stop = m ? { step: Number(m[1]), message: m[2]! } : { step: 0, message: result.error };
  }
  const reached = stop?.step ?? total;
  const failedSteps = new Set(result.failures.map((f) => f.step));
  let passed = 0;
  for (let i = 0; i < reached; i++) if (!failedSteps.has(i)) passed++;
  const byPath = componentPaths(board, '');
  const idOfPath = new Map([...byPath].map(([id, path]) => [path, id]));
  const components = [
    ...new Set(result.failures.map((f) => idOfPath.get(f.name)).filter((id) => id !== undefined)),
  ];
  return {
    total,
    passed,
    failures: result.failures,
    rows: result.rows,
    ...(stop ? { error: stop } : {}),
    components,
  };
}

/** The board answers a table only when it is combinational: say why when it is not. */
function tableError(e: unknown): string {
  if (e instanceof StoredStateError)
    return `The board stores state (${e.kind === 'ram' ? 'a RAM' : 'a flip-flop or latch'}), so it has no truth table`;
  if (e instanceof BidirectionalPinError)
    return 'The board has a bus transceiver or other bidirectional pin, so it has no truth table';
  if (e instanceof BooleanEvalError)
    return 'The board has a feedback loop, so it has no truth table';
  return errorText(e);
}

function tableReport(board: Board, library: ChipLibrary, table: ChallengeTruthTable): TableReport {
  const fail = (error: string, components: string[] = []): TableReport => ({
    rows: [],
    matched: 0,
    error,
    components,
  });
  if (table.inputs.length > MAX_TABLE_INPUTS)
    return fail(
      `A truth table takes up to ${MAX_TABLE_INPUTS} inputs, this one names ${table.inputs.length}`,
    );
  const resolve = (names: string[], role: NameRole) =>
    names.map((n) => {
      const m = resolveName(board, n, role);
      if (!m.found) throw new RangeError(m.error);
      return m.found;
    });
  let compiled;
  let inputs;
  let outputs;
  try {
    inputs = resolve(table.inputs, 'tableInput');
    outputs = resolve(table.outputs, 'tableOutput');
    compiled = compile(lowerCircuit(board), lowerLibrary(library));
  } catch (e) {
    return fail(errorText(e));
  }
  const paths = componentPaths(board, 'main/');
  const inPaths = inputs.map((c) =>
    c.kind === 'inport' ? `${paths.get(c.id)}.y` : paths.get(c.id)!,
  );
  const outPaths = outputs.map((c) =>
    c.kind === 'outport' ? `${paths.get(c.id)}.a` : paths.get(c.id)!,
  );
  let wide;
  try {
    wide = [
      ...inputs.map((c, i) => [c, resolveInputNet(compiled, inPaths[i]!)] as const),
      ...outputs.map((c, i) => [c, resolveOutputNet(compiled, outPaths[i]!)] as const),
    ].find(([, net]) => compiled.nets[net]!.width !== 1);
  } catch (e) {
    return fail(errorText(e));
  }
  if (wide) {
    const [c, net] = wide;
    return fail(
      `${c.label || c.id} is ${compiled.nets[net]!.width} bits: a truth table names 1-bit inputs and outputs`,
      [c.id],
    );
  }
  let built;
  try {
    built = buildTruthTable(compiled, inPaths, outPaths);
  } catch (e) {
    return fail(tableError(e));
  }
  const n = table.inputs.length;
  const rows = table.rows.map((row): TableRowResult => {
    const ins = row.slice(0, n).map((b) => (b === 1 ? 1 : 0));
    const expected = row.slice(n, n + outputs.length);
    const index = ins.reduce<number>((acc, b) => (acc << 1) | b, 0);
    const actual = built.rows[index]!.map((v, j) => {
      const lit = ledLitValue(v, 1, outputs[j]!.kind === 'led' ? (outputs[j]!.params ?? {}) : {});
      return bv.toString(lit, 1);
    });
    const ok = expected.every((want, j) => want === null || actual[j] === String(want));
    return { inputs: ins, expected, actual, ok };
  });
  const outIds = new Set(
    rows.flatMap((r) =>
      r.ok
        ? []
        : outputs
            .filter((_, j) => r.expected[j] !== null && r.actual[j] !== String(r.expected[j]))
            .map((c) => c.id),
    ),
  );
  return {
    rows,
    matched: rows.filter((r) => r.ok).length,
    components: [...outIds],
  };
}

/**
 * Runs a challenge's behavior on a fresh compile and simulator: never the live
 * one, so checking leaves the board, probes and trace as they were.
 */
export function behaviorReport(
  board: Board,
  library: ChipLibrary,
  challenge: Challenge,
  timing: TimingSetting,
): BehaviorReport {
  return {
    timing: timing.mode,
    ...(challenge.tests ? { tests: testsReport(board, library, challenge, delayOf(timing)) } : {}),
    ...(challenge.truthTable ? { table: tableReport(board, library, challenge.truthTable) } : {}),
  };
}

const TABLE_INPUT_KINDS = new Set(['toggle', 'button', 'inport']);
const TABLE_OUTPUT_KINDS = new Set(['led', 'probe', 'outport']);

/**
 * The board's own truth table as a challenge target, every row, named by
 * label. Read from a built answer, so a cell the board leaves X is don't care.
 */
export function truthTableFromBoard(
  board: Board,
  library: ChipLibrary,
): ChallengeTruthTable | string {
  const paths = componentPaths(board, '');
  const named = (kinds: Set<string>) => board.components.filter((c) => kinds.has(c.kind));
  const ins = named(TABLE_INPUT_KINDS);
  const outs = named(TABLE_OUTPUT_KINDS);
  if (ins.length === 0) return 'The board has no switch, button or input port';
  if (outs.length === 0) return 'The board has no LED, probe or output port';
  const unnamed = [...ins, ...outs].find((c) => !c.label?.trim());
  if (unnamed) return `${unnamed.id} has no label: name every input and output first`;
  const inputs = ins.map((c) => paths.get(c.id)!);
  const outputs = outs.map((c) => paths.get(c.id)!);
  if (inputs.length > MAX_TABLE_INPUTS)
    return `A truth table takes up to ${MAX_TABLE_INPUTS} inputs, the board has ${inputs.length}`;
  const rows = Array.from({ length: 2 ** inputs.length }, (_, r) => [
    ...inputs.map((_, i) => ((r >> (inputs.length - 1 - i)) & 1) as 0 | 1),
    ...outputs.map(() => null),
  ]);
  const report = tableReport(board, library, { inputs, outputs, rows });
  if (report.error !== undefined) return report.error;
  return {
    inputs,
    outputs,
    rows: report.rows.map((r) => [
      ...r.inputs,
      ...r.actual.map((a) => (a === '0' ? 0 : a === '1' ? 1 : null)),
    ]),
  };
}
