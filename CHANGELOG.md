# Changelog

All notable changes to Logicuitry are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/) (pre-1.0: the minor digit marks a release worth
updating for, the patch digit is reserved for a critical one-off fix).

## [0.3.0] - 2026-09-12

### Added

- LED colour and shape: red, green, amber, blue or white, diode symbol or
  round body.
- LED array and LED matrix in the palette.
- A decimal point and a real common terminal on the 7-segment display.
- Analyze reads a 7-segment as one truth table and one K-map per wired
  segment.
- Build a circuit from a Boolean expression or a truth table, from File >
  Build circuit or the Analyze drawer.
- Pins dropped exactly onto each other are wired on the spot.
- Ctrl+X cuts the selected parts to the clipboard, reconnecting through a
  NOT or BUF it takes out.
- The lasso can draw a freehand shape instead of a marquee.
- The Cut tool follows the stroke you draw, curves included.
- Preferences > Hide tool names on the toolbar, on by default.
- On touch, a long press on a K-map group removes it.
- A What's new sheet after an update, and on demand from the Help menu.
- Help > Download the desktop app, in the browser build.

### Changed

- Two gate or chip inputs can be wired to each other.
- Multi-driver errors name the parts involved.
- Components are numbered per kind.
- A new board is called Untitled board.
- The theme picker opens the app's own list.
- The 7-segment display is drawn larger.

### Removed

- The Shift+F pin picker. Plain F still connects automatically.

### Fixed

- The palette pane can be dragged wider again.
- The wire ghost no longer draws a diagonal to the first bend.

## [0.2.0] - 2026-09-03

### Added

- 74-series DIP chips in the Circuit workbench: eight generated chip
  definitions, DIP package glyph, Vcc/GND pins, BCD-to-7-segment decoder.
- Mobile PWA installs windowed instead of fullscreen, so Android's system
  Back button stays reachable.

### Changed

- Numbers workbench bit row reworked for narrow screens.
- Numbers workbench view/width/sign controls fit onto one compact bar on
  mobile.
- Device Lab plots resize to fit small screens, with domain-window zoom and
  pan on the VTC plot.
- App icon replaced.
- In-browser (PWA) builds now update themselves without prompting; an
  installed desktop build still announces an update and waits for you to
  accept it.

### Fixed

- Circuit editing now locks while the simulation is powered, since the
  board can't change under a running simulation.
- Compact/mobile chrome and waveform gesture handling tightened.
- Mobile navigation, touch gestures and panel sizing repaired.
- Bug report dialog improved.
- Menu popups and dialog scroll regions fixed on small screens.

## [0.1.0] - 2026-08-30

Initial public release: Circuit workbench (schematic editor, four-state
simulator, waveforms, static timing analysis, K-maps, bubble pushing,
chip packaging), Numbers workbench (base conversion, binary arithmetic),
Device Lab (ngspice CMOS transfer characteristics, TTL noise margins),
offline PWA and desktop (Windows/Linux/macOS) builds.
