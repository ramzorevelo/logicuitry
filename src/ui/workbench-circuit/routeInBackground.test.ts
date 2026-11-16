import { describe, expect, it } from 'vitest';
import type { AutoRouteInput, AutoRouteResult } from './autoRoute';
import { routeInBackground, type RouteWorker } from './routeInBackground';

const input: AutoRouteInput = { components: [], wires: [], junctions: [], grid: 16 };
const routed: AutoRouteResult = { wires: [], junctions: [], routed: 3 };

class FakeWorker implements RouteWorker {
  onmessage: RouteWorker['onmessage'] = null;
  onerror: RouteWorker['onerror'] = null;
  onmessageerror: RouteWorker['onmessageerror'] = null;
  posted: AutoRouteInput[] = [];
  terminated = 0;
  postMessage(i: AutoRouteInput) {
    this.posted.push(i);
  }
  terminate() {
    this.terminated++;
  }
  reply(r: AutoRouteResult) {
    this.onmessage?.({ data: r } as MessageEvent<AutoRouteResult>);
  }
  fail() {
    this.onerror?.({ preventDefault: () => {} } as ErrorEvent);
  }
}

describe('routeInBackground', () => {
  it('posts the input and resolves with the worker reply, then terminates it', async () => {
    const w = new FakeWorker();
    const run = routeInBackground(input, () => w);
    expect(w.posted).toEqual([input]);
    w.reply(routed);
    await expect(run.result).resolves.toBe(routed);
    expect(w.terminated).toBe(1);
  });

  it('cancel resolves null, terminates, and ignores a late reply', async () => {
    const w = new FakeWorker();
    const run = routeInBackground(input, () => w);
    run.cancel();
    w.reply(routed);
    await expect(run.result).resolves.toBeNull();
    expect(w.terminated).toBe(1);
  });

  it('routes on the main thread when no worker can start', async () => {
    const run = routeInBackground(input, () => null);
    await expect(run.result).resolves.toEqual({ wires: [], junctions: [], routed: 0 });
  });

  it('cancelled before the main-thread fallback runs resolves null', async () => {
    const run = routeInBackground(input, () => null);
    run.cancel();
    await expect(run.result).resolves.toBeNull();
  });

  it('falls back to the main thread when the worker errors', async () => {
    const w = new FakeWorker();
    const run = routeInBackground(input, () => w);
    w.fail();
    await expect(run.result).resolves.toEqual({ wires: [], junctions: [], routed: 0 });
    expect(w.terminated).toBe(1);
  });

  it('falls back to the main thread when a reply cannot be read', async () => {
    const w = new FakeWorker();
    const run = routeInBackground(input, () => w);
    w.onmessageerror?.({} as MessageEvent);
    await expect(run.result).resolves.toEqual({ wires: [], junctions: [], routed: 0 });
  });

  it('the main-thread fallback leaves the caller wires untouched', async () => {
    const wires = [
      {
        id: 'w1',
        a: { kind: 'pin', component: 'x', pin: 'y' },
        b: { kind: 'pin', component: 'z', pin: 'a' },
        points: [],
      },
    ] as AutoRouteInput['wires'];
    const r = await routeInBackground({ ...input, wires }, () => null).result;
    expect(r!.wires[0]).not.toBe(wires[0]);
  });
});
