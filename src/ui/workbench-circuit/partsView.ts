import type { Bom, BomGateRow } from '../../core/parts/bom';

/** The choices with one key set or cleared; undefined once none are left, so the board stays free of an empty map. */
export function withPartChoice(
  choices: Readonly<Record<string, string>> | undefined,
  key: string,
  part: string | undefined,
): Record<string, string> | undefined {
  const next = Object.fromEntries(Object.entries(choices ?? {}).filter(([k]) => k !== key));
  if (part !== undefined) next[key] = part;
  return Object.keys(next).length > 0 ? next : undefined;
}

export function gateLabel(g: Pick<BomGateRow, 'kind' | 'inputs'>): string {
  return g.inputs === 1 ? g.kind.toUpperCase() : `${g.inputs}-input ${g.kind.toUpperCase()}`;
}

export function optionLabel(o: { part: string; perPackage: number }): string {
  return `${o.part} (${o.perPackage} per package)`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a chosen package costs: ICs and the gates left unused. */
export function packingSummary(g: Pick<BomGateRow, 'ics' | 'spare' | 'choice'>): string {
  if (g.choice === undefined) return '';
  return `${plural(g.ics ?? 0, 'IC', 'ICs')}, ${g.spare ?? 0} spare ${(g.spare ?? 0) === 1 ? 'gate' : 'gates'}`;
}

export function problemsLine(problems: Bom['problems']): string | null {
  if (problems.length === 0) return null;
  const names = [...new Set(problems.map((p) => p.name || p.defId))].join(', ');
  const missing = problems.filter((p) => p.kind === 'missing').length;
  const loops = problems.length - missing;
  const parts: string[] = [];
  if (missing > 0) parts.push(`${plural(missing, 'chip', 'chips')} not loaded`);
  if (loops > 0) parts.push(`${plural(loops, 'chip', 'chips')} contain themselves`);
  return `${parts.join(', ')}: ${names}`;
}
