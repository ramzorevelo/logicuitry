// Stub side panel. Exported but not mounted yet; the reveal-gated lesson runner
// arrives with the lesson overlay milestone.
export function LessonOverlay() {
  return (
    <aside className="lesson-overlay" hidden>
      <header className="lesson-overlay__header">Lesson</header>
      <p className="workbench-placeholder">Lesson overlay: not built yet</p>
    </aside>
  );
}
