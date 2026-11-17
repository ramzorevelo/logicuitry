// The first-launch welcome, the "Look around" tour and the hands-on coach.
// The tour is modal and owns the keyboard; the coach is not, because the
// student has to use the board under it.

import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { useModalKeys } from '../modalKeys';
import { useBackLayer } from '../backStack';
import { useCoarsePointer } from '../pointerKind';
import { useCompact } from '../compact';
import { useShellStore } from '../store';
import { useCircuitStore } from '../workbench-circuit/circuitStore';
import { useLessonStore } from '../lesson/lessonStore';
import { useLessonEditorStore } from '../lesson/lessonEditorStore';
import { useChallengeStore } from '../workbench-circuit/challengeStore';
import {
  FIRST_CIRCUIT_STEPS,
  firstCircuitProgress,
  type FirstCircuitStep,
} from '../../core/tutorial/firstCircuit';
import { TUTORIAL_BOARD_ID, useOnboardingStore } from './onboardingStore';
import { useTargetRect, type TargetRect } from './useTargetRect';
import './onboarding.css';

export interface OnboardingActions {
  /** Clears the board through the unsaved-changes guard, then runs `then`. */
  startTutorialBoard(then: () => void): void;
  startBlankBoard(): void;
  openExamples(): void;
  openKeys(): void;
  openBasicGatesLesson(): void;
}

interface Props extends OnboardingActions {
  presentation: boolean;
}

const RING_PAD = 6;

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="tour-kbd">{children}</kbd>;
}

interface TourStop {
  target: string;
  title: string;
  body(touch: boolean): ReactNode;
}

const TOUR_STOPS: TourStop[] = [
  {
    target: '[data-tour="workbenches"]',
    title: 'Three workbenches',
    body: (touch) => (
      <>
        Numbers &amp; Logic for conversions and Boolean algebra, Circuit for building, Device Lab
        for what a gate does with voltage.
        {touch ? null : (
          <>
            {' '}
            <Kbd>Ctrl+1</Kbd> <Kbd>2</Kbd> <Kbd>3</Kbd> switch between them.
          </>
        )}
      </>
    ),
  },
  {
    target: '[data-tour="parts"]',
    title: 'Parts',
    body: (touch) =>
      touch ? (
        'Every part you can place, in groups. Open a group, tap a part, then tap the board. Hold a part to keep placing it.'
      ) : (
        <>
          Every part you can place. Click one, then click the board. Type in Find part to search,
          for example <Kbd>74LS08</Kbd>.
        </>
      ),
  },
  {
    target: '[data-tour="tools"]',
    title: 'Tools',
    body: (touch) =>
      touch ? (
        'Select, Wire, Cut and more. A plain drag pans the board; hold a part, then drag, to move it.'
      ) : (
        <>
          Select, Wire, Cut and more. <Kbd>W</Kbd> draws wires, <Kbd>Esc</Kbd> goes back to Select.
        </>
      ),
  },
  {
    target: '[data-tour="sim"]',
    title: 'Power and stepping',
    body: (touch) =>
      touch ? (
        'Power runs the board, and editing waits until it is off. Step moves one gate delay.'
      ) : (
        <>
          <Kbd>Space</Kbd> powers the board on and off, and editing waits until it is off.{' '}
          <Kbd>.</Kbd> steps one gate delay.
        </>
      ),
  },
  {
    target: '[data-menu="help"]',
    title: 'Help is always here',
    body: (touch) =>
      touch ? (
        'Help has the gestures and this tutorial. File > Examples has ready-made boards and lessons.'
      ) : (
        <>
          Help &gt; Keys and gestures (<Kbd>?</Kbd>) lists every shortcut, and this tutorial lives
          there too. File &gt; Examples has ready-made boards and lessons.
        </>
      ),
  },
];

function Ring({ rect, className }: { rect: TargetRect; className: string }) {
  return (
    <div
      className={className}
      style={{
        left: rect.x - RING_PAD,
        top: rect.y - RING_PAD,
        width: rect.w + RING_PAD * 2,
        height: rect.h + RING_PAD * 2,
      }}
    />
  );
}

const CARD_WIDTH = 340;
const CARD_MARGIN = 12;

/**
 * Beside a tall narrow target (the desktop palette, a landscape phone's tool column), else on
 * whichever side of it has more room, capped to that room so the buttons never leave the window.
 * On a compact shell the CSS pins the card's free sides to the screen edges.
 */
function cardPosition(rect: TargetRect, compact: boolean): React.CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = RING_PAD + CARD_MARGIN;
  const roomCap = (room: number) => Math.max(160, room - CARD_MARGIN);
  if (rect.h > vh * 0.4 && rect.w < vw * 0.4) {
    const top = Math.max(CARD_MARGIN, Math.min(rect.y + 24, vh - 240));
    const maxHeight = roomCap(vh - top);
    return rect.x + rect.w / 2 > vw / 2
      ? { right: vw - rect.x + gap, top, maxHeight }
      : { left: rect.x + rect.w + gap, top, maxHeight };
  }
  const roomBelow = vh - (rect.y + rect.h + gap);
  const roomAbove = rect.y - gap;
  const vertical: React.CSSProperties =
    roomBelow >= roomAbove
      ? { top: rect.y + rect.h + gap, maxHeight: roomCap(roomBelow) }
      : { bottom: vh - rect.y + gap, maxHeight: roomCap(roomAbove) };
  if (compact) return vertical;
  const left = Math.max(CARD_MARGIN, Math.min(rect.x, vw - CARD_WIDTH - CARD_MARGIN));
  return { left, ...vertical };
}

function Welcome(props: Props) {
  const end = useOnboardingStore((s) => s.end);
  const startTour = useOnboardingStore((s) => s.startTour);
  useModalKeys(end);
  const take = () => {
    useShellStore.getState().setWorkbench('circuit');
    startTour();
  };
  return (
    <div className="package-overlay" onPointerDown={(e) => e.target === e.currentTarget && end()}>
      <div className="package-dialog welcome-dialog" role="dialog" aria-labelledby="welcome-title">
        <h3 id="welcome-title">Welcome to Logicuitry</h3>
        <p>
          A workbench for logic circuits: number systems, gates, timing, and the voltages behind
          them.
        </p>
        <dl className="welcome-benches">
          <dt>Numbers &amp; Logic</dt>
          <dd>Conversions, arithmetic and Boolean algebra, step by step.</dd>
          <dt>Circuit</dt>
          <dd>Build with gates and 74LS chips, power on, watch it run.</dd>
          <dt>Device Lab</dt>
          <dd>What a gate does with real voltages.</dd>
        </dl>
        <div className="welcome-actions">
          <button type="button" className="tool-btn welcome-primary" autoFocus onClick={take}>
            Take the tutorial
            <small>A quick look around, then build your first circuit.</small>
          </button>
          <button
            type="button"
            className="tool-btn"
            onClick={() => {
              end();
              useShellStore.getState().setWorkbench('circuit');
              props.openExamples();
            }}
          >
            Open an example
            <small>Ready-made boards and lessons.</small>
          </button>
          <button
            type="button"
            className="tool-btn"
            onClick={() => {
              end();
              useShellStore.getState().setWorkbench('circuit');
              props.startBlankBoard();
            }}
          >
            Start with a blank board
          </button>
        </div>
        <p className="analyze-muted">
          Shown once. The tutorial is always under Help &gt; Tutorial.
        </p>
      </div>
    </div>
  );
}

function Tour(props: Props) {
  const touch = useCoarsePointer();
  const compact = useCompact();
  const stop = useOnboardingStore((s) => s.stop);
  const setStop = useOnboardingStore((s) => s.setStop);
  const end = useOnboardingStore((s) => s.end);
  const startBuild = useOnboardingStore((s) => s.startBuild);
  useModalKeys(end);

  const current = TOUR_STOPS[stop];
  const rect = useTargetRect(current?.target ?? null);
  const last = stop === TOUR_STOPS.length - 1;

  const next = () => {
    if (!last) {
      setStop(stop + 1);
      return;
    }
    end();
    props.startTutorialBoard(startBuild);
  };
  const back = () => stop > 0 && setStop(stop - 1);

  useEffect(() => {
    // Capture, ahead of the board; preventDefault keeps Enter from also clicking the focused button.
    const onKey = (e: KeyboardEvent) => {
      // Enter on a focused button is that button's own click.
      const onButton = e.target instanceof HTMLButtonElement;
      if ((e.key === 'Enter' && !onButton) || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        next();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        back();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  if (!current) return null;
  return (
    <div className="tour-layer">
      {rect ? <Ring rect={rect} className="tour-hole" /> : <div className="tour-scrim" />}
      <div
        className="tour-card"
        role="dialog"
        aria-labelledby="tour-title"
        style={rect ? cardPosition(rect, compact) : undefined}
      >
        <div className="tour-card__meta">
          <span>Look around</span>
          <span>
            {stop + 1} of {TOUR_STOPS.length}
          </span>
        </div>
        <h3 id="tour-title">{current.title}</h3>
        <p>{current.body(touch)}</p>
        <div className="tour-card__buttons">
          <button type="button" className="tool-btn tour-quiet" onClick={end}>
            Skip tutorial
          </button>
          <button type="button" className="tool-btn" disabled={stop === 0} onClick={back}>
            Back
          </button>
          <button type="button" className="tool-btn tour-primary" autoFocus onClick={next}>
            {last ? 'Build a circuit' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface BuildStepCopy {
  label: string;
  how(touch: boolean): ReactNode;
  /** The control to press next; falls back to the parts palette when not rendered. */
  pulse: string | null;
  /** The phone palette's tab that holds the part, shown while that tab is closed. */
  group?: string;
}

const BUILD_STEPS: Record<FirstCircuitStep, BuildStepCopy> = {
  switches: {
    label: 'Two switches',
    pulse: '[data-part="toggle"]',
    group: 'Inputs',
    how: (touch) =>
      touch ? (
        <>
          Open <b>Inputs</b> in the parts, tap <b>Switch</b>, then tap the board. Do it twice.
        </>
      ) : (
        <>
          Click <b>Switch</b> in the parts, then click the board. Do it twice.
        </>
      ),
  },
  gate: {
    label: 'An AND gate',
    pulse: '[data-part="and"]',
    group: 'Gates',
    how: (touch) => (
      <>
        {touch ? (
          <>
            Open <b>Gates</b>, tap
          </>
        ) : (
          'Click'
        )}{' '}
        <b>AND</b>, then {touch ? 'tap' : 'click'} the board to the right of the switches.
      </>
    ),
  },
  led: {
    label: 'An LED',
    pulse: '[data-part="led"]',
    group: 'Outputs',
    how: (touch) => (
      <>
        {touch ? (
          <>
            Open <b>Outputs</b>, tap
          </>
        ) : (
          'Click'
        )}{' '}
        <b>LED</b>, then {touch ? 'tap' : 'click'} the board to the right of the gate.
      </>
    ),
  },
  wires: {
    label: 'Three wires',
    pulse: '[data-tool="wire"]',
    how: (touch) =>
      touch ? (
        <>
          Pick the <b>Wire</b> tool, tap a pin, then tap the pin it joins: each switch to an AND
          input, the AND output to the LED.
        </>
      ) : (
        <>
          Press <Kbd>W</Kbd>, click a pin, then click the pin it joins: each switch to an AND input,
          the AND output to the LED.
        </>
      ),
  },
  power: {
    label: 'Power on',
    pulse: '[data-tool="power"]',
    how: (touch) =>
      touch ? (
        <>
          Tap <b>Power</b>.
        </>
      ) : (
        <>
          Press <Kbd>Space</Kbd>, or the <b>Power</b> button.
        </>
      ),
  },
  lit: {
    label: 'Light the LED',
    pulse: null,
    how: (touch) =>
      touch ? (
        <>
          Tap both switches to 1, then <b>Run</b>. The LED lights only when both are 1.
        </>
      ) : (
        <>
          Click each switch to flip it to 1, then <b>Run</b> so the change reaches the LED. It
          lights only when both are 1: that is AND.
        </>
      ),
  },
};

function useProgress() {
  const board = useCircuitStore((s) => s.board);
  const powered = useCircuitStore((s) => s.powered);
  // Every board or sim change bumps rev; the pin values below are read fresh on each.
  const rev = useCircuitStore((s) => s.rev);
  return useMemo(
    () =>
      firstCircuitProgress(board, {
        powered,
        pinValue: (c, p) => useCircuitStore.getState().pinRawValue(c, p),
      }),
    [board, powered, rev],
  );
}

function Coach(props: Props) {
  const touch = useCoarsePointer();
  const end = useOnboardingStore((s) => s.end);
  // Coach mounts only while its card shows, so unmounting releases the layer.
  useBackLayer(end);
  const progress = useProgress();
  const step = progress.current;
  // A paused board holds a flip back until Run or Settle, so the LED looks stuck.
  const flipsWaiting = useCircuitStore((s) => s.powered && s.canSettle());
  const pulse = progress.mustPowerOff
    ? '[data-tool="power"]'
    : step === 'lit' && flipsWaiting
      ? '[data-tool="run"]'
      : step
        ? BUILD_STEPS[step].pulse
        : null;
  const target = useTargetRect(pulse);
  const group = step && !progress.mustPowerOff ? BUILD_STEPS[step].group : undefined;
  const groupTab = useTargetRect(group ? `[data-group="${group}"]` : null);
  const palette = useTargetRect(group ? '[data-tour="parts"]' : null);
  const ring = target ?? groupTab ?? palette;
  const index = step ? FIRST_CIRCUIT_STEPS.indexOf(step) : FIRST_CIRCUIT_STEPS.length;

  // On a phone the card covers the board's lower part, and it grows between steps.
  const compact = useCompact();
  const cardRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (compact && card)
      useCircuitStore.getState().requestRevealAbove(card.getBoundingClientRect().top);
  }, [compact, step]);

  return (
    <div className="tour-layer tour-layer--passive">
      {ring ? <Ring rect={ring} className="tour-ring" /> : null}
      <section ref={cardRef} className="tour-card tour-coach" aria-label="Tutorial">
        <button
          type="button"
          className="tour-close"
          aria-label="End tutorial"
          title="End tutorial"
          onClick={end}
        >
          ×
        </button>
        {step === null ? (
          <>
            <div className="tour-card__meta">
              <span>Your first circuit</span>
              <span>Done</span>
            </div>
            <h3>That is an AND gate</h3>
            <p>The LED is on only while both switches are 1. Flip one back and watch it go out.</p>
            <div className="tour-card__links">
              <button
                type="button"
                className="tool-btn"
                onClick={() => {
                  end();
                  props.openExamples();
                }}
              >
                Open an example
              </button>
              <button
                type="button"
                className="tool-btn"
                onClick={() => {
                  end();
                  props.openKeys();
                }}
              >
                {touch ? 'Gestures' : 'Keys and gestures'}
              </button>
              <button
                type="button"
                className="tool-btn"
                onClick={() => {
                  end();
                  props.openBasicGatesLesson();
                }}
              >
                The basic gates lesson
              </button>
            </div>
            <div className="tour-card__buttons">
              <button type="button" className="tool-btn tour-primary" onClick={end}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="tour-card__meta">
              <span>Build your first circuit</span>
              <span>
                {index + 1} of {FIRST_CIRCUIT_STEPS.length}
              </span>
            </div>
            <ol className="tour-checklist">
              {FIRST_CIRCUIT_STEPS.map((s) => (
                <li
                  key={s}
                  className={progress.done[s] ? 'is-done' : s === step ? 'is-current' : undefined}
                >
                  <span aria-hidden="true">{progress.done[s] ? '✓' : s === step ? '▸' : '·'}</span>
                  {BUILD_STEPS[s].label}
                </li>
              ))}
            </ol>
            <div className="tour-howto">
              {progress.mustPowerOff ? (
                touch ? (
                  'Tap Power to turn it off first: the board cannot be edited while it runs.'
                ) : (
                  <>
                    Press <Kbd>Space</Kbd> to power off first: the board cannot be edited while it
                    runs.
                  </>
                )
              ) : (
                BUILD_STEPS[step].how(touch)
              )}
            </div>
            {touch ? null : (
              <p className="tour-foot">
                Esc cancels what you are doing; Esc again ends the tutorial.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}

/** Ends a running tutorial when something takes the screen or the board away from it. */
function useOnboardingGuards(presentation: boolean) {
  const phase = useOnboardingStore((s) => s.phase);
  const end = useOnboardingStore((s) => s.end);
  const workbench = useShellStore((s) => s.workbench);
  const boardId = useCircuitStore((s) => s.board.id);
  const lessonOpen = useLessonStore((s) => s.lesson !== null);
  const lessonDraft = useLessonEditorStore((s) => s.draft !== null);
  const checking = useChallengeStore((s) => s.checking !== null);
  useEffect(() => {
    if (phase === 'off' || phase === 'welcome') return;
    const lost =
      presentation ||
      lessonOpen ||
      lessonDraft ||
      checking ||
      (phase === 'tour' && workbench !== 'circuit') ||
      (phase === 'build' && boardId !== TUTORIAL_BOARD_ID);
    if (lost) end();
  }, [phase, presentation, lessonOpen, lessonDraft, checking, workbench, boardId, end]);
}

export function Onboarding(props: Props) {
  const phase = useOnboardingStore((s) => s.phase);
  const workbench = useShellStore((s) => s.workbench);
  const onBoardTab = useCircuitStore((s) => s.activeTabId === 'board');
  useOnboardingGuards(props.presentation);
  if (phase === 'welcome') return <Welcome {...props} />;
  if (phase === 'tour') return <Tour {...props} />;
  if (phase === 'build' && workbench === 'circuit' && onBoardTab) return <Coach {...props} />;
  return null;
}

/** Help > Tutorial is greyed while the board belongs to something else. */
export function useTutorialAvailable(presentation: boolean): boolean {
  const lessonOpen = useLessonStore((s) => s.lesson !== null);
  const lessonDraft = useLessonEditorStore((s) => s.draft !== null);
  const checking = useChallengeStore((s) => s.checking !== null);
  return !presentation && !lessonOpen && !lessonDraft && !checking;
}
