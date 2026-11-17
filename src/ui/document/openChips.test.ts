import { beforeEach, describe, expect, it } from 'vitest';
import { useCircuitStore } from '../workbench-circuit/circuitStore';
import { EXAMPLES } from '../../examples';
import type { ChipDef } from '../../core/model/types';
import type { DocFile } from '../../io/platform';
import { openChipFiles } from './openChips';

const st = () => useCircuitStore.getState();
const example = EXAMPLES.find((e) => e.id === 'full-adder')!;
const halfAdder = example.chips![0]!;
const file = (name: string) => new File(['{}'], name) as unknown as DocFile;

/** A chip built from two half adders: it only loads beside them. */
const wrapper: ChipDef = {
  ...halfAdder,
  id: 'two-halves',
  name: 'Two halves',
  components: [
    { id: 'h1', kind: 'chip', defId: halfAdder.id, pos: { x: 0, y: 0 } },
    { id: 'h2', kind: 'chip', defId: halfAdder.id, pos: { x: 0, y: 80 } },
  ],
  wires: [],
  junctions: [],
  pins: [],
};

beforeEach(() => {
  useCircuitStore.setState({ powered: false, running: false });
  st().loadBoard(structuredClone(example.board));
});

describe('openChipFiles', () => {
  it('opens a chip picked before the chip it uses', () => {
    const fresh = { ...halfAdder, id: 'half-copy', name: 'Half copy' };
    const user = {
      ...wrapper,
      components: wrapper.components.map((c) => ({ ...c, defId: fresh.id })),
    };
    const failed: string[] = [];
    const opened = openChipFiles(
      [
        { def: user, file: file('a.lcirc') },
        { def: fresh, file: file('b.lcirc') },
      ],
      failed,
    );
    expect(failed).toEqual([]);
    expect(opened.sort()).toEqual(['Half copy', 'Two halves']);
    expect(st().chipLib.has('two-halves')).toBe(true);
  });

  it('keeps the later file when the same chip is picked twice', () => {
    const failed: string[] = [];
    const later = { ...wrapper, name: 'Later' };
    st().loadChipDefs([halfAdder]);
    openChipFiles(
      [
        { def: wrapper, file: file('a.lcirc') },
        { def: later, file: file('b.lcirc') },
      ],
      failed,
    );
    expect(st().chipLib.get('two-halves')?.name).toBe('Later');
  });

  it('refuses a chip whose tab has unsaved edits and opens the rest', () => {
    st().loadChipDefs([halfAdder, wrapper]);
    st().openDefTab(wrapper.id, `${wrapper.id}/`, wrapper.name);
    const tab = st().tabs.find((t) => t.kind === 'def' && t.defId === wrapper.id)!;
    useCircuitStore.setState({ activeTabId: tab.id });
    st().renameComponent('h1', 'first');
    expect(st().chipTabDirty(tab.id)).toBe(true);

    const failed: string[] = [];
    const other = { ...halfAdder, id: 'other', name: 'Other' };
    const opened = openChipFiles(
      [
        { def: { ...wrapper, name: 'Replaced' }, file: file('a.lcirc') },
        { def: other, file: file('b.lcirc') },
      ],
      failed,
    );
    expect(opened).toEqual(['Other']);
    expect(failed[0]).toMatch(/unsaved edits/);
    expect(st().chipLib.get('two-halves')?.name).toBe('Two halves');
  });
});
