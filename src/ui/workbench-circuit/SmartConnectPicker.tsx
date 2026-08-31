// Smart-connect precise variant (Shift+F): explicit source-pin/target-pin
// pairing when the automatic role/order matching isn't wanted. Click a source
// pin, then a target pin, to pair them; Commit adds every pair as one wire.

import { useState } from 'react';
import { oneLine } from '../../render/glyphs/symbol';
import { schematicTheme } from '../../render/theme';
import { useCircuitStore } from './circuitStore';
import { collectPinTargets, type PinTarget } from './pinTargets';

interface Props {
  targetId: string;
  onClose: () => void;
}

type Pair = { source: PinTarget; target: PinTarget };

export function SmartConnectPicker({ targetId, onClose }: Props) {
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [pendingSource, setPendingSource] = useState<PinTarget | null>(null);

  const st = useCircuitStore.getState();
  const theme = schematicTheme();
  const circuit = st.activeCircuit();
  const targets = collectPinTargets(circuit.components, circuit.wires, theme, st.chipLib);
  const pairedSourceKeys = new Set(pairs.map((p) => `${p.source.componentId} ${p.source.pinName}`));
  const pairedTargetKeys = new Set(pairs.map((p) => `${p.target.componentId} ${p.target.pinName}`));

  const sourcePins = targets.filter(
    (t) =>
      t.dir === 'out' &&
      st.selection.has(t.componentId) &&
      t.componentId !== targetId &&
      !pairedSourceKeys.has(`${t.componentId} ${t.pinName}`),
  );
  const targetPins = targets.filter(
    (t) =>
      t.dir === 'in' &&
      t.componentId === targetId &&
      !pairedTargetKeys.has(`${t.componentId} ${t.pinName}`),
  );

  const componentLabel = (id: string) =>
    oneLine(circuit.components.find((c) => c.id === id)?.label ?? id);

  const pickSource = (t: PinTarget) => setPendingSource(t);
  const pickTarget = (t: PinTarget) => {
    if (!pendingSource) return;
    setPairs((ps) => [...ps, { source: pendingSource, target: t }]);
    setPendingSource(null);
  };
  const removePair = (i: number) => setPairs((ps) => ps.filter((_, idx) => idx !== i));

  const commit = () => {
    useCircuitStore.getState().addWires(
      pairs.map(({ source, target }) => ({
        a: { kind: 'pin', component: source.componentId, pin: source.pinName },
        b: { kind: 'pin', component: target.componentId, pin: target.pinName },
      })),
    );
    onClose();
  };

  return (
    <div
      className="package-overlay"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="package-dialog">
        <h3>Smart-connect: precise pairing</h3>
        <div className="package-pins">
          <div className="package-pin-col">
            <h4>Sources</h4>
            {sourcePins.map((t) => (
              <button
                key={`${t.componentId}.${t.pinName}`}
                type="button"
                className={`tool-btn${pendingSource === t ? ' palette-item--active' : ''}`}
                onClick={() => pickSource(t)}
              >
                {componentLabel(t.componentId)}.{t.pinName}
              </button>
            ))}
            {sourcePins.length === 0 && <p className="package-pin-empty">none</p>}
          </div>
          <div className="package-pin-col">
            <h4>Target ({componentLabel(targetId)})</h4>
            {targetPins.map((t) => (
              <button
                key={`${t.componentId}.${t.pinName}`}
                type="button"
                className="tool-btn"
                disabled={!pendingSource}
                onClick={() => pickTarget(t)}
              >
                {t.pinName}
              </button>
            ))}
            {targetPins.length === 0 && <p className="package-pin-empty">none</p>}
          </div>
        </div>
        {pairs.length > 0 && (
          <ul className="package-pin-col">
            {pairs.map((p, i) => (
              <li key={i} className="package-pin-row">
                {componentLabel(p.source.componentId)}.{p.source.pinName} -&gt; {p.target.pinName}
                <button type="button" className="tool-btn" onClick={() => removePair(i)}>
                  x
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="package-actions">
          <button type="button" className="tool-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="tool-btn" disabled={pairs.length === 0} onClick={commit}>
            Commit
          </button>
        </div>
      </div>
    </div>
  );
}
