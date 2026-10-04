// The Chapter 4 laws table, row numbers and names as the course prints them.
// X, Y, Z are pattern variables.

export type LawId =
  | '1a'
  | '1b'
  | '2a'
  | '2b'
  | '3a'
  | '3b'
  | '4a'
  | '4b'
  | '5'
  | '6a'
  | '6b'
  | '7a'
  | '7b'
  | '8a'
  | '8b'
  | '9a'
  | '9b'
  | '10a'
  | '10b'
  | '11a'
  | '11b'
  | '12a'
  | '12b'
  | '13a'
  | '13b'
  | '14a'
  | '14b'
  | '15a'
  | '15b';

export interface Law {
  id: LawId;
  name: string;
  alsoCalled: string[];
  lhs: string;
  rhs: string;
  dual: LawId | null;
}

const law = (
  id: LawId,
  name: string,
  lhs: string,
  rhs: string,
  dual: LawId | null,
  alsoCalled: string[] = [],
): Law => ({ id, name, alsoCalled, lhs, rhs, dual });

export const LAWS: readonly Law[] = [
  law('1a', 'Annulment Law', 'X·0', '0', '1b', ['operations with 0 and 1']),
  law('1b', 'Annulment Law', 'X + 1', '1', '1a', ['operations with 0 and 1']),
  law('2a', 'Identity Law', 'X·1', 'X', '2b'),
  law('2b', 'Identity Law', 'X + 0', 'X', '2a'),
  law('3a', 'Idempotent Law', 'X·X', 'X', '3b'),
  law('3b', 'Idempotent Law', 'X + X', 'X', '3a'),
  law('4a', 'Complement Law', "X·X'", '0', '4b', ['complementarity']),
  law('4b', 'Complement Law', "X + X'", '1', '4a', ['complementarity']),
  law('5', 'Double Negation Law', "X''", 'X', null, ['involution']),
  law('6a', 'Commutative Law', 'X·Y', 'Y·X', '6b'),
  law('6b', 'Commutative Law', 'X + Y', 'Y + X', '6a'),
  law('7a', 'Associative Law', 'X(YZ)', '(XY)Z', '7b'),
  law('7b', 'Associative Law', 'X + (Y + Z)', '(X + Y) + Z', '7a'),
  law('8a', 'Distributive Law', 'X(Y + Z)', 'XY + XZ', '8b'),
  law('8b', 'Distributive Law', 'X + YZ', '(X + Y)(X + Z)', '8a'),
  law('9a', "De Morgan's Theorem", "(XY)'", "X' + Y'", '9b', ["De Morgan's law"]),
  law('9b', "De Morgan's Theorem", "(X + Y)'", "X'Y'", '9a', ["De Morgan's law"]),
  law('10a', 'Absorption Law', 'X(X + Y)', 'X', '10b'),
  law('10b', 'Absorption Law', 'X + XY', 'X', '10a'),
  law('11a', 'Redundancy Law', "(X + Y)(X + Y')", 'X', '11b', ['uniting']),
  law('11b', 'Redundancy Law', "XY + XY'", 'X', '11a', ['uniting']),
  law('12a', 'Redundancy Law', "(X + Y')Y", 'XY', '12b', ['elimination']),
  law('12b', 'Redundancy Law', "XY' + Y", 'X + Y', '12a', ['elimination']),
  law('13a', 'Consensus Law', "(X + Y)(X' + Z)(Y + Z)", "(X + Y)(X' + Z)", '13b'),
  law('13b', 'Consensus Law', "XY + X'Z + YZ", "XY + X'Z", '13a'),
  law('14a', 'Exclusive-OR', 'X ⊕ Y', "(X + Y)(X' + Y')", null),
  law('14b', 'Exclusive-OR', 'X ⊕ Y', "X'Y + XY'", null),
  law('15a', 'Equivalence', 'X ⊙ Y', "(X + Y')(X' + Y)", null),
  law('15b', 'Equivalence', 'X ⊙ Y', "X'Y' + XY", null),
];

const LABEL_OVERRIDES: Partial<Record<LawId, string>> = {
  '8a': 'first distributive law',
  '8b': 'second distributive law',
  '9a': "De Morgan's theorem",
  '9b': "De Morgan's theorem",
  '11a': 'redundancy law, uniting form',
  '11b': 'redundancy law, uniting form',
  '12a': 'redundancy law, elimination form',
  '12b': 'redundancy law, elimination form',
  '14a': 'exclusive-OR',
  '14b': 'exclusive-OR',
  '15a': 'equivalence',
  '15b': 'equivalence',
};

/** `10b (absorption law)`: the row plus its name, as the lesson writes a citation. */
export function lawLabel(id: LawId): string {
  const name = LABEL_OVERRIDES[id] ?? LAWS.find((l) => l.id === id)!.name.toLowerCase();
  return `${id} (${name})`;
}
