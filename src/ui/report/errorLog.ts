// A small ring of the most recent errors, so a bug report can carry what
// actually went wrong instead of only what the reporter remembers.

export interface LoggedError {
  at: number;
  message: string;
  stack?: string;
}

const CAPACITY = 10;
const ring: LoggedError[] = [];

export function logError(message: string, stack?: string): void {
  ring.push({ at: Date.now(), message, ...(stack ? { stack } : {}) });
  if (ring.length > CAPACITY) ring.shift();
}

export function recentErrors(): readonly LoggedError[] {
  return ring;
}

export function lastError(): LoggedError | undefined {
  return ring[ring.length - 1];
}

/** Installed once from main.tsx. The ErrorBoundary reports separately: a React
 *  render error it catches never reaches window.onerror. */
export function installErrorLog(): void {
  window.addEventListener('error', (e) => {
    logError(e.message, e.error instanceof Error ? e.error.stack : undefined);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r: unknown = e.reason;
    logError(
      r instanceof Error
        ? `Unhandled rejection: ${r.message}`
        : `Unhandled rejection: ${String(r)}`,
      r instanceof Error ? r.stack : undefined,
    );
  });
}
