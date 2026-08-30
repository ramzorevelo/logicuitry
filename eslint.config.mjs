import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['src/core/**/*.ts'],
    rules: {
      // Core purity: no DOM/React/canvas in src/core (CLAUDE.md invariant).
      'no-restricted-imports': ['error', { patterns: ['react*', '*react*'] }],
      'no-restricted-globals': ['error', 'window', 'document', 'navigator'],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Determinism rule: use core/sim/prng.ts.' },
      ],
    },
  },
  {
    // No em dashes in user-visible text. They eat horizontal room a phone does
    // not have, and the house style is a colon or a full stop instead. Comments
    // are covered by the same convention but not by this rule, which reads the
    // AST rather than the trivia.
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value=/\u2014/]",
          message: 'No em dash in user-visible text; use a colon, a comma or a full stop.',
        },
        {
          selector: "TemplateElement[value.raw=/\u2014/]",
          message: 'No em dash in user-visible text; use a colon, a comma or a full stop.',
        },
        {
          selector: "JSXText[value=/\u2014/]",
          message: 'No em dash in user-visible text; use a colon, a comma or a full stop.',
        },
      ],
    },
  },
  { ignores: ['dist/', 'node_modules/'] },
);
