// The Boolean-algebra boards each claim an identity from Roth Unit 2 section
// 2.6: two ISOLATED circuits, one per form, sharing nothing, each with its
// own switches and its own LED. Set both groups' switches alike and the LEDs
// must agree for EVERY input combination. That is the whole teaching point, so it is asserted by
// simulation rather than trusted to the netlist having been typed correctly.

import { describe, expect, it } from 'vitest';
import { compile } from '../core/model/compile';
import { idealDelay } from '../core/sim/delay';
import { Simulator } from '../core/sim/kernel';
import { toString } from '../core/value/busValue';
import { componentPaths } from '../core/model/compile';
import { analysisTablesOf } from '../core/gates/verify';
import { EXAMPLES } from './index';
import '../core/sim/primitives/registry';

/** Per board: LED pairs that must always read the same, and LEDs pinned to a
 *  constant. Keyed by board id, values are component ids. */
const CLAIMS: Record<string, { agree: [string, string][]; always?: [string, string][] }> = {
  absorption: { agree: [['lhs', 'rhs']] },
  elimination: { agree: [['lhs', 'rhs']] },
  consensus: { agree: [['lhs', 'rhs']] },
  'distributive-law': { agree: [['lhs', 'rhs']] },
  // Two identities on one board: covering follows A, complementarity is 1.
  'complement-and-covering': { agree: [['lcover', 'la']], always: [['lcomp', '1']] },
};

describe('Boolean algebra boards', () => {
  for (const [id, claim] of Object.entries(CLAIMS)) {
    it(`${id} holds for every input combination`, () => {
      const example = EXAMPLES.find((e) => e.id === id);
      expect(example, `no bundled example ${id}`).toBeDefined();
      const board = example!.board;
      const compiled = compile(board, new Map());

      // Each group carries its OWN switches, so the boards repeat labels: the
      // claim is that setting both groups' `A` alike makes their LEDs agree.
      // Driving by label rather than by component is what tests that.
      const toggles = board.components.filter((c) => c.kind === 'toggle');
      expect(toggles.length).toBeGreaterThan(0);
      const names = [...new Set(toggles.map((t) => t.label ?? t.id))].sort();
      expect(names.length).toBeGreaterThan(0);
      // Two isolated circuits means every input name appears more than once.
      expect(toggles.length).toBeGreaterThan(names.length);

      /** An LED reads the net on its single input pin. */
      const ledNet = (componentId: string): number => {
        const pi = compiled.componentToPrimitive.get(`main/${componentId}`);
        expect(pi, `no primitive for ${componentId}`).toBeDefined();
        const net = compiled.primitives[pi!]!.inputs[0];
        expect(net, `no input net on ${componentId}`).toBeDefined();
        return net!;
      };

      const seen = new Set<string>();
      for (let combo = 0; combo < 1 << names.length; combo++) {
        const sim = new Simulator(compiled, idealDelay);
        sim.powerOn();
        toggles.forEach((t) => {
          const bit = (combo >> (names.length - 1 - names.indexOf(t.label ?? t.id))) & 1;
          // By primitive index, not by path: these boards deliberately label an
          // LED after the net it reads, and repeat switch labels across groups,
          // so a path lookup is ambiguous twice over. The per-component map is
          // the unambiguous one.
          const pi = compiled.componentToPrimitive.get(`main/${t.id}`);
          expect(pi, `no primitive for toggle ${t.id}`).toBeDefined();
          sim.setPrimitiveStateAt(pi!, { value: bit });
        });
        expect(sim.settle().settled).toBe(true);

        const read = (componentId: string) => toString(sim.netValue(ledNet(componentId)), 1);

        for (const [left, right] of claim.agree) {
          const a = read(left);
          const b = read(right);
          seen.add(`${left}=${a}`);
          expect({ combo, left, right, a, b }).toEqual({ combo, left, right, a: b, b });
        }
        for (const [led, want] of claim.always ?? []) {
          expect({ combo, led, value: read(led) }).toEqual({ combo, led, value: want });
        }
      }

      // A board whose LEDs never change would pass every assertion vacuously.
      expect(seen.size).toBeGreaterThan(1);
    });
  }
});

describe('Boolean algebra boards analyze per group', () => {
  // The reason a board carries both forms is comparison, so Analyze has to
  // give each group its own truth table. Before groups scoped the terminal
  // paths, both circuits' switches resolved to one ambiguous `main/A` and
  // Analyze failed outright with "truth table needs at least one input".
  for (const id of ['absorption', 'elimination', 'consensus', 'distributive-law']) {
    it(`${id} yields one table per group, over that group's own inputs`, () => {
      const example = EXAMPLES.find((e) => e.id === id)!;
      const board = example.board;
      const analyses = analysisTablesOf(board, new Map());

      const scopeOf = (path: string) => {
        const rest = path.replace(/\.(y|a)$/, '').replace(/^main\//, '');
        const cut = rest.lastIndexOf('/');
        return cut < 0 ? '' : rest.slice(0, cut);
      };

      const groups = new Set((board.groups ?? []).map((g) => g.name));
      expect(groups.size).toBe(2);

      for (const a of analyses) {
        expect({ output: a.outputPath, error: a.error }).toEqual({
          output: a.outputPath,
          error: null,
        });
        const scope = scopeOf(a.outputPath);
        expect(groups.has(scope)).toBe(true);
        // Every input feeding this output comes from the SAME group: nothing
        // crosses, which is what "isolated" means.
        for (const p of a.table!.inputPaths) expect(scopeOf(p)).toBe(scope);
        expect(a.table!.inputPaths.length).toBeGreaterThan(0);
      }

      // Both groups actually produced a table, so the comparison is possible.
      expect(new Set(analyses.map((a) => scopeOf(a.outputPath)))).toEqual(groups);
    });
  }
});

describe('Boolean algebra board naming', () => {
  // A group is named for the ROLE its circuit plays, the LED for the
  // expression it shows. Naming both after the expression made Analyze read
  // "A + AB: A + AB" -- the same thing twice, which tells the reader nothing.
  it('never names a group after the expression its own LED carries', () => {
    for (const e of EXAMPLES) {
      for (const g of e.board.groups ?? []) {
        const labels = e.board.components
          .filter((c) => c.group === g.id && c.label)
          .map((c) => c.label!);
        expect({ board: e.id, group: g.name, clash: labels.includes(g.name) }).toEqual({
          board: e.id,
          group: g.name,
          clash: false,
        });
      }
    }
  });

  // A path may fall back to a component id to stay unique, but the reader must
  // still see the label. Every terminal on these boards carries one.
  it('labels every terminal, so no id ever reaches the screen', () => {
    const TERMINALS = new Set(['toggle', 'led', 'probe', 'inport', 'outport', 'button']);
    for (const id of ['absorption', 'complement-and-covering']) {
      const board = EXAMPLES.find((e) => e.id === id)!.board;
      for (const c of board.components.filter((x) => TERMINALS.has(x.kind)))
        expect({ board: id, component: c.id, labelled: !!c.label }).toEqual({
          board: id,
          component: c.id,
          labelled: true,
        });
    }
  });
});

describe('Analyze shows labels, never component ids', () => {
  // The owner saw `A: rhs` and `Covering: la` in the tabs and `rhs` as a truth
  // table column: a path may fall back to a component id to stay unique, and
  // the display was being parsed out of the path. Every column header and
  // every tab must resolve back to a component's own label.
  const base = (p: string) => p.replace(/\.(y|a)(\[\d+\])?$/, '');

  for (const e of EXAMPLES) {
    if (!e.board.groups?.length) continue;
    it(`${e.id} resolves every analysis path to a label`, () => {
      const paths = componentPaths(e.board, 'main/');
      const nameByPath = new Map<string, string>();
      const idByPath = new Map<string, string>();
      for (const c of e.board.components) {
        nameByPath.set(paths.get(c.id)!, c.label || c.id);
        idByPath.set(paths.get(c.id)!, c.id);
      }

      for (const a of analysisTablesOf(e.board, new Map())) {
        for (const path of [a.outputPath, ...(a.table?.inputPaths ?? [])]) {
          const shown = nameByPath.get(base(path));
          expect({ path, resolved: shown !== undefined }).toEqual({ path, resolved: true });
          // The displayed name is the label, even where the PATH had to fall
          // back to the id to stay unique.
          expect({ path, shown, isBareId: shown === idByPath.get(base(path)) }).toEqual({
            path,
            shown,
            isBareId: false,
          });
        }
      }
    });
  }
});
