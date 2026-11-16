import { componentPaths } from '../model/compile';
import type { Board, Component, ComponentKind } from '../model/types';

export type NameRole = 'input' | 'output' | 'clock' | 'tableInput' | 'tableOutput';

const ROLE_KINDS: Record<NameRole, ReadonlySet<ComponentKind>> = {
  input: new Set(['toggle', 'button', 'spdt']),
  output: new Set(['led', 'sevenseg', 'probe', 'outport']),
  clock: new Set(['clock', 'timer555']),
  tableInput: new Set(['toggle', 'button', 'inport']),
  tableOutput: new Set(['led', 'probe', 'outport']),
};

const ROLE_WORD: Record<NameRole, string> = {
  input: 'input',
  output: 'output',
  clock: 'clock',
  tableInput: 'input',
  tableOutput: 'output',
};

export type NameMatch =
  | { found: Component; path: string }
  | { found: null; error: string; missing: boolean };

function listed(names: readonly string[]): string {
  return names.length <= 2
    ? names.join(' and ')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Finds the part a challenge names. Matching is exact after trimming. A name
 * with a `/` is group-qualified; a bare name prefers the board level, then a
 * group, and is refused when either level holds two. `path` is the compiled
 * name below `main/`, the spelling the runner reads.
 */
export function resolveName(board: Board, raw: string, role: NameRole): NameMatch {
  const name = raw.trim();
  const paths = componentPaths(board, '');
  const kinds = ROLE_KINDS[role];
  const candidates = board.components.filter((c) => kinds.has(c.kind));
  const pathOf = (c: Component) => paths.get(c.id)!;
  const bare = (c: Component) => (c.label || c.id).trim();
  let hits: Component[];
  if (name.includes('/')) hits = candidates.filter((c) => pathOf(c) === name);
  else {
    const top = candidates.filter((c) => !c.group && bare(c) === name);
    hits = top.length > 0 ? top : candidates.filter((c) => c.group && bare(c) === name);
  }
  if (hits.length === 1) return { found: hits[0]!, path: pathOf(hits[0]!) };
  if (hits.length === 0)
    return {
      found: null,
      missing: true,
      error: `No ${ROLE_WORD[role]} named ${name} on this board`,
    };
  const count = hits.length === 2 ? 'Two' : String(hits.length);
  return {
    found: null,
    missing: false,
    error: `${count} parts named ${name}: ${listed(hits.map(pathOf))}`,
  };
}
