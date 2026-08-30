// Placeholder lesson-step registry. Mirrors the primitive registry pattern:
// register-once, throw on duplicate. Renderer signature is a stand-in until the
// lesson overlay defines its real step contract.
export type LessonStepRenderer = (params: Record<string, unknown>) => void;

const renderers = new Map<string, LessonStepRenderer>();

export function registerStepType(type: string, renderer: LessonStepRenderer): void {
  if (renderers.has(type)) throw new Error(`lesson step type '${type}' already registered`);
  renderers.set(type, renderer);
}

export function getStepType(type: string): LessonStepRenderer {
  const renderer = renderers.get(type);
  if (!renderer) throw new Error(`unknown lesson step type '${type}'`);
  return renderer;
}
