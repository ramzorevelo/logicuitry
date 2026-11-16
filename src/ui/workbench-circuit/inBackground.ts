/** A background run in progress. `result` settles to null once cancelled. */
export interface BackgroundRun<O> {
  result: Promise<O | null>;
  cancel(): void;
}

/** The slice of Worker this uses, so tests can stand in a fake. */
export interface RunWorker<I, O> {
  onmessage: ((e: MessageEvent<O>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  onmessageerror: ((e: MessageEvent) => void) | null;
  postMessage(input: I): void;
  terminate(): void;
}

/**
 * Runs `input` in a Worker, one per run, terminated when done or cancelled.
 * Without a Worker, or when it fails, runs `onMainThread` instead, so the
 * action never silently does nothing.
 */
export function runInBackground<I, O>(
  input: I,
  spawn: () => RunWorker<I, O> | null,
  onMainThread: (input: I) => O,
): BackgroundRun<O> {
  const worker = spawn();
  if (!worker) {
    let cancelled = false;
    return {
      result: Promise.resolve().then(() => (cancelled ? null : onMainThread(input))),
      cancel: () => {
        cancelled = true;
      },
    };
  }
  let settle: (r: O | null) => void = () => {};
  let fail: (e: unknown) => void = () => {};
  let done = false;
  const finish = (r: O | null) => {
    if (done) return;
    done = true;
    worker.terminate();
    settle(r);
  };
  const result = new Promise<O | null>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const fallBack = () => {
    if (done) return;
    try {
      finish(onMainThread(input));
    } catch (err) {
      done = true;
      worker.terminate();
      fail(err);
    }
  };
  worker.onmessage = (e) => finish(e.data);
  worker.onmessageerror = fallBack;
  worker.onerror = (e) => {
    e.preventDefault();
    fallBack();
  };
  worker.postMessage(input);
  return { result, cancel: () => finish(null) };
}
