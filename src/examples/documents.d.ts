// Board and chip documents are JSON with their own extensions (see the
// logicuitryDocuments plugin in vite.config.ts). The shapes are validated at
// load, so the modules are typed as unknown rather than asserted here.
declare module '*.lcirb' {
  const value: unknown;
  export default value;
}

declare module '*.lcirc' {
  const value: unknown;
  export default value;
}
