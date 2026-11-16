// Runs Check challenge's behavior off the main thread: a clocked board's test
// rows can take seconds, and the page must stay live meanwhile.

import { behaviorReport } from '../../core/challenge/behavior';
import type { CheckInput } from './checkInBackground';

// Typed as Worker for its postMessage/onmessage shapes; tsconfig ships the DOM lib only.
const ctx = self as unknown as Worker;

ctx.onmessage = (e: MessageEvent<CheckInput>) => {
  const { board, library, challenge, timing } = e.data;
  ctx.postMessage(behaviorReport(board, library, challenge, timing));
};
