// ============================================
// Zule AI — Error Boundary Component
// ============================================

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { telemetry, buildErrorTelemetryEvent } from '../brain/telemetry';
import './ErrorBoundary.css';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[ErrorBoundary] Caught error:', error);
    console.error('[ErrorBoundary] Component stack:', errorInfo.componentStack);

    // Emit a content-free error event to telemetry (Requirement 19.3).
    // Only error metadata (name, message, stack, breadcrumb) is recorded —
    // never user content such as transcript text or screen text.
    const breadcrumb = ['ErrorBoundary'];
    if (errorInfo.componentStack) {
      // Extract the first component name from the stack as a breadcrumb hint.
      const match = errorInfo.componentStack.match(/at (\w+)/);
      if (match) {
        breadcrumb.push(match[1]);
      }
    }
    const event = buildErrorTelemetryEvent(error, breadcrumb);
    telemetry.emit(event);
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    // Allow a custom fallback UI
    if (this.props.fallback) {
      return this.props.fallback;
    }

    const errorMessage = this.state.error?.message ?? 'An unexpected error occurred.';
    const errorStack = this.state.error?.stack ?? '';

    return (
      <div className="error-boundary">
        <div className="error-boundary__card">
          <div className="error-boundary__icon">⚠</div>
          <h2 className="error-boundary__title">Something went wrong</h2>
          <p className="error-boundary__message">
            An unexpected error occurred while rendering this section.
            You can try again or reload the page.
          </p>
          <button
            className="error-boundary__retry"
            onClick={this.handleReset}
          >
            ↻ Try Again
          </button>
          <details className="error-boundary__details">
            <summary>Error details</summary>
            <pre>{errorMessage}{errorStack ? `\n\n${errorStack}` : ''}</pre>
          </details>
        </div>
      </div>
    );
  }
}
