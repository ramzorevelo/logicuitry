# Logicuitry

Offline instruments for teaching logic circuits and design.

## Features

- **Circuit**: schematic editor over a four-state (0/1/X/Z) simulator. Unit-delay
  and datasheet timing models built from 74LS parameters, waveforms, static
  timing analysis, truth tables and Karnaugh maps, De Morgan bubble pushing, and
  packaging a circuit into a reusable chip.
- **Numbers**: base conversion and binary arithmetic, worked one step at a time.
- **Device Lab**: CMOS transfer characteristics from ngspice compiled to
  WebAssembly, and TTL noise margins from datasheet parameters.

## Install

### Web

<https://ramzorevelo.github.io/logicuitry/>

Installs as a progressive web app and runs offline afterwards. Chrome and Edge
support the connected library folder through the File System Access API; other
browsers fall back to file import and export.

### Desktop

Download an installer from [Releases](../../releases). Windows is the supported
target. Linux and macOS builds are published best-effort.

The installers are not code-signed. On first run, Windows SmartScreen shows
"Windows protected your PC": choose **More info**, then **Run anyway**.

## Build

Requires Node 20 or later.

```sh
npm ci
npm run build
```

Desktop builds also require a Rust toolchain:

```sh
npm run tauri build
```

## Development

```sh
npm run dev            # dev server
npm test               # unit tests
npm run lint           # eslint and prettier
npm run check:offline  # assert the build references no external URLs
```

## License

MIT. See [LICENSE](LICENSE). Bundled third-party components keep their own
licenses; see [THIRD-PARTY.md](THIRD-PARTY.md).
