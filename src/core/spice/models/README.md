# SPICE model parameters

The Device Lab CMOS content is backed by the numeric MOSFET model in
`../mosfetModel.ts`, the documented fallback from architecture.md §4. It is a
long-channel square-law model with channel-length modulation, not a BSIM/level-49
card. Its parameters are generic textbook values, sufficient for the DC transfer
characteristic and noise-margin lessons this course needs:

| Parameter                          | Value      | Note                                                 |
| ---------------------------------- | ---------- | ---------------------------------------------------- |
| VTHN0 (NMOS threshold)             | 0.7 V      | at 25 degC; Harris & Harris ch. 1 order-of-magnitude |
| VTHP0 (PMOS threshold magnitude)   | 0.7 V      | symmetric with NMOS                                  |
| LAMBDA (channel-length modulation) | 0.05 /V    | gives finite gain so unity-gain points exist         |
| Mobility ratio (PMOS/NMOS)         | 0.5        | hole mobility ~half; matched drive at Wp/Wn = 2      |
| Threshold temperature coefficient  | -2 mV/degC | shifts VM slightly with temperature                  |

The VTC shape depends only on the threshold voltages, the strength ratio, and
lambda; absolute transconductance cancels when NMOS and PMOS drain currents are
balanced at the output node, so no absolute current scale is committed here.

## Real device model (eecircuit path)

With `eecircuit-engine` (ngspice-wasm) now active, the CMOS Device Lab runs a real
BSIM3v3.1 (ngspice LEVEL=49) card, committed as string constants in `cmos-bsim3.ts`:

| Card                             | Source                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| TSMC 0.18 um NMOS/PMOS BSIM3v3.1 | MOSIS parametric archive, T14B run (`tsmc-018/t92y_mm_non_epi_thk_mtl_params.txt`), a public academic process file |

The `.model` cards, the netlist template (`../netlists/inverter.ts`), and the "show netlist"
drawer all show this same text, so what the instructor reads is exactly what ngspice solves.
Operating-region labels (cutoff/linear/saturation) are derived from Vgs/Vds vs the card's `VTH0`
(a long-channel approximation for the teaching annotation; BSIM3's effective Vth varies with bias).

The numeric square-law model above is now the **fallback**: it is a deliberately different,
simpler model, not a fit to BSIM3. When it produces a curve (eecircuit worker unavailable), the
Device Lab labels it "approximate model" rather than pretending the two agree. Package license is
recorded in `docs/reference/third-party.md`.
