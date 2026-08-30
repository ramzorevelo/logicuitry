// A render error in one workbench must degrade to an error panel, never
// unmount the whole app (a single glyph-geometry throw used to white-screen).

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { BugReportDialog } from './BugReportDialog';
import { logError } from '../report/errorLog';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  stack: string;
  reporting: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, stack: '', reporting: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // A render error React catches never reaches window.onerror, so the ring
    // would miss exactly the crashes most worth reporting.
    logError(error.message, `${error.stack ?? ''}${info.componentStack ?? ''}`);
    this.setState({ stack: info.componentStack ?? '' });
  }

  override render(): ReactNode {
    const { error, stack, reporting } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-boundary" role="alert">
        <h2>Workbench crashed</h2>
        <p>{error.message}</p>
        <button
          type="button"
          className="tool-btn"
          onClick={() => this.setState({ reporting: true })}
        >
          Report this crash
        </button>
        <pre>
          {error.stack}
          {stack}
        </pre>
        {reporting && (
          <BugReportDialog
            onClose={() => this.setState({ reporting: false })}
            initialDescription={`Crash: ${error.message}`}
            crash={{ at: Date.now(), message: error.message, stack: error.stack ?? stack }}
          />
        )}
      </div>
    );
  }
}
