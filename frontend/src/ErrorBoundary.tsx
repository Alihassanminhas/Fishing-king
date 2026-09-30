import { Component, type ErrorInfo, type ReactNode } from 'react';

type BoundaryState = { failed: boolean };
type BoundaryProps = { children: ReactNode };

/** Contains render-time failures and offers a clear recovery path. */
export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState { return { failed: true }; }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Storefront render failed:', error.message, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.failed) return <main className="site-shell flex min-h-screen flex-col items-center justify-center text-center"><p className="eyebrow text-ocean">A LITTLE TANGLE</p><h1 className="mt-3 font-display text-3xl font-bold">This page needs another cast.</h1><p className="mt-3 text-slate-600">Something unexpected happened while loading the store.</p><button className="button button-primary mt-6" onClick={() => window.location.reload()}>Reload the store</button></main>;
    return this.props.children;
  }
}
