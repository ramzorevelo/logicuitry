# Changelog

All notable changes to Logicuitry are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/) (pre-1.0: the minor digit marks a release worth
updating for, the patch digit is reserved for a critical one-off fix).

## [0.4.3] - 2026-10-05

### Fixed

- On a phone, a maximized K-map fits the screen in portrait and landscape,
  and follows a rotation; it used to run off the edge with no way to scroll
  to it.
- On a phone, the content and the drawer strip sit directly on the bottom
  navigation bar, without a gap that showed the board through.
- The Algebra tab no longer scrolls sideways on a phone, which drew a
  scrollbar across the Simplify hint.
- On a phone, the Expression and Name fields of Build circuit take the full
  width; the name field was a few characters wide. The truth-table hint says
  tap, not click.
- The Device Lab plot's Vout label no longer overlaps the axis numbers.

## [0.4.2] - 2026-10-05

### Fixed

- On a phone, the bottom navigation bar no longer covers sheets and dialogs
  (Analyze, Package as chip and the like), and tapping low in Analyze no
  longer switches workbench and closes it.
- The Analyze sheet scrolls in portrait and landscape, and tapping inside it
  no longer closes it.
- Analyze no longer redraws itself continuously while open, which slowed
  phones down.
- After closing Analyze by tapping outside it, the Analyze button opens it on
  the first press.
- On a touch screen, lifting the finger after a long press on the K-map
  circles the group; it used to only highlight the cells.

## [0.4.1] - 2026-10-04

### Fixed

- The desktop installer and updater now report the real version instead of
  0.1.0.

## [0.4.0] - 2026-10-04

### Added

- An Algebra tab in Numbers & Logic: the table of Boolean laws with hide
  drills, canonical forms (minterms, maxterms, Σm and ΠM), and Simplify, by
  hand or as a worked derivation that cites a law on every line.
- Analyze takes a typed function (Σ notation, an expression or a truth
  table) as well as the board.
- K-maps in product-of-sums as well as sum-of-products form.
- A stepped reveal on the K-map (primes, essentials, minimum cover) and a
  Check button that judges your circles without showing the answer.
- A refused K-map circle now says which grouping rule it broke, and a
  collapsible Grouping rules tip sits under the map.
- Analyze shows each output's expression as built, and can compare two
  outputs row by row.
- View > Sub-expressions labels every gate output with the expression it
  computes.
- Build circuit can build NOR-only as well as NAND-only, and can minimise an
  expression before building it.

### Changed

- The Numbers workbench is now called Numbers & Logic.
- Laws are cited as a row and a name, the way the lesson writes them.
- Theme is a light/dark switch in the top bar and in Settings.
- Help lists the Algebra and Analyze gestures.

### Fixed

- Text fields and selects no longer show a grey widget fill in the dark
  theme.
- A NAND-only or NOR-only build of a three-input gate now builds the right
  function.
- Bubble push no longer refuses a board whose independent groups add up to
  more than eight inputs.
- Bubbles can be dragged again after an undo in bubble mode.

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
