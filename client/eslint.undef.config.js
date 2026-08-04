// Narrow, build-blocking safety net: catches "used but never imported"
// identifiers (e.g. a lucide-react icon referenced in JSX without an
// import) before they ship as a production ReferenceError.
//
// Deliberately scoped to ONLY `no-undef` — the full `npm run lint` config
// (eslint.config.js) has ~50 pre-existing, unrelated errors/warnings
// (react-hooks rules, etc.) that are out of scope here and would block
// every deploy if this gate ran the full ruleset. This file exists so
// `npm run build` can enforce just the one rule class that caused the
// Follow-ups page outage (missing `Download`/`ExternalLink` imports)
// without being coupled to the broader lint backlog.
import globals from 'globals';

export default [
  { ignores: ['dist', 'node_modules'] },
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      'no-undef': 'error',
    },
  },
];
