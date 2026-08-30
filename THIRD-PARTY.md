# Third-party notices

This project is MIT licensed. It bundles the following, each under its own
license:

- **eecircuit-engine** — ships ngspice compiled to WebAssembly. ngspice is
  distributed under a BSD-style license; the engine wrapper is MIT.
- **@fontsource/jetbrains-mono, syne, cinzel, chakra-petch, rajdhani** — the
  font files are SIL Open Font License 1.1; the packages themselves are MIT.
- **D-DIN** (vendored under `src/assets/fonts/d-din/`) — SIL Open Font
  License 1.1.
- **react, react-dom, zustand, ajv** - MIT.
- **Tauri** and its plugins (desktop build only) — MIT or Apache-2.0.

The committed CMOS device model (`src/core/spice/models/`) is a TSMC 0.18 um
BSIM3v3.1 card from the public MOSIS parametric archive.
