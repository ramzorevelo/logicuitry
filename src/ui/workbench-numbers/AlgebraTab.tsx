import { CanonicalSection } from './CanonicalSection';
import { LawsSection } from './LawsSection';
import { SimplifySection } from './SimplifySection';
import { useAlgebraStore, type AlgebraSection } from './algebraStore';
import './algebra.css';

const SECTIONS: { id: AlgebraSection; label: string }[] = [
  { id: 'laws', label: 'Laws' },
  { id: 'canonical', label: 'Canonical forms' },
  { id: 'simplify', label: 'Simplify' },
];

export function AlgebraTab() {
  const section = useAlgebraStore((s) => s.section);
  const setSection = useAlgebraStore((s) => s.setSection);
  return (
    <div className="algebra-tab">
      <div className="segmented">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={section === s.id}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>
      {section === 'laws' ? (
        <LawsSection />
      ) : section === 'canonical' ? (
        <CanonicalSection />
      ) : (
        <SimplifySection />
      )}
    </div>
  );
}
