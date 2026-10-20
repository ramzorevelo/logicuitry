# Changelog

All notable changes to Logicuitry are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/) (pre-1.0: the minor digit marks a release worth
updating for, the patch digit is reserved for a critical one-off fix).

## [0.5.0] - 2026-10-19

### Added

- Circuit palette: an Arithmetic group (Half adder, Full adder, 4-bit Adder,
  4-bit Comparator) and, under Sequential, an SR latch, D latch, Register,
  Counter and Shift register. Width keys resize the Counter, Shift register,
  Register, D latch and flip-flop.
- Nineteen more 74LS packages, 27 in all: 74LS138, 139, 148, 151, 153, 154
  and 157; 74LS283, 85 and 280; 74LS74, 161, 163, 164, 165, 175, 273, 374
  and 377. Each has its datasheet pin-out, function table and timing.
- Static timing and waveform shading cover the Register, Counter and Shift
  register, with setup and hold for each kind of input.
- The 74 series group sorts parts under function headings, each with a
  one-line description.
- Find part at the top of the palette matches names, part numbers ('138,
  7400, LS 138), descriptions and other names such as flip-flop or shift
  register. On a phone it is the first tab.
- The Half adder and Full adder open read-only to their gates with
  Shift+double-click.
- Examples: Ripple-carry adder, Mod-10 counter, Shift register.

### Changed

- A 74LS gate in a package adds only its datasheet delay: a 74LS00 measured
  19 ns instead of 9 ns.
- On datasheet timing, an output change takes the delay of the input that
  moved: 74LS161 ENT to RCO is 9 ns, not 20 ns.
- The 74LS374 /OC enables and disables the outputs after the datasheet times.
- An output stays known where an unknown input cannot change it: a clock going
  from X to 0, an unselected 74LS138 output, 74LS85 A=B with a known
  difference.
- Flip-flop preset and clear follow the datasheet: both low drives Q and Q-bar
  high, and releasing both together leaves the output unknown.
- Analyze and bubble verify name the outputs that hold state and still work on
  the rest.
- Rotating a part re-routes its wires; Undo restores the old bends.
- Turning a phone between portrait and landscape fits the board to the view.
- The palette is wider and wraps long names.
- What's new shows the latest release; earlier versions open on a click or
  tap, and Close stays in view.
- Build circuit keeps every input of the table, wired or not, and Analyze
  counts an unwired input of the same circuit, so a 4-input table still opens
  as a 4-variable K-map.
- Build this builds the cover on screen, or the circled groups before a
  reveal; it never fills in a hidden answer.
- Analyze always offers Build circuit, follows the output just built, and
  names an output labelled with its expression Y.
- Analyze and Build circuit errors read as plain sentences.
- Analyze shows the full table for 5 inputs.
- Build circuit: the table follows the typed expression and its names,
  Minimise first works with any gate set, Enter builds, and an edited table
  asks before closing.

### Fixed

- A pulse shorter than the gap between a gate's rise and fall delays no longer
  leaves its output at the old value for good.
- A board opens on its saved timing model.
- The Mod-10 counter and Shift register examples run on datasheet timing.
- An edit refused inside a built-in part no longer enables Undo or asks to
  save on close; loading the chip library no longer marks the board unsaved.
- Back keeps working after two layers close at once, and Esc closes only the
  top dialog.
- Rotate group and Mirror re-route the wires leaving the selection.
- A second finger cancels a one-finger drag.
- Running the simulation no longer marks a saved board unsaved.
- On a phone, Back closes an open part editor instead of leaving the app.
- On a phone: touch wiring shows its ghost and cancels cleanly, parts land
  centred under the finger, Back closes the open layer, the banner no longer
  hides the bottom bar, and decimal fields open the number keypad.
- Files open without a file picker, a restored unsaved session stays unsaved,
  and Undo and redo no longer leave deleted parts selected.
- Presentation mode scales bit grids, Analyze and the Device Lab plots.
- The K-map product dots, overbar outline and simulation time units display
  correctly.
- Ctrl+Y redoes, the Device Lab noise margins hide when the gate pair changes,
  and the installed app opens files from the system.
- Saving by download marks the board saved.
- Desktop app: Help > Check for updates finds new releases instead of
  reporting a failure.
- K-map terms draw a separate bar over each complement: A'B' no longer reads
  as (AB)'.
- Delete in the Analyze drawer no longer deletes board parts, and keys typed
  into its menus stay there.
- A revealed K-map answer resets when the function changes.
- Build circuit is unavailable while powered, in view-only, in bubble push
  and on a chip tab, instead of building into the open chip.
- The K-map fits the drawer in presentation mode.
- K-map Check: a constant function, two findings on one group, and why a
  cover is not minimum read correctly; an already circled group is refused.
- NAND-only and NOR-only builds share one inverter per input.

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
