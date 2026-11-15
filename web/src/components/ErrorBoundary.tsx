import { Component, type ErrorInfo, type ReactNode } from "react";
import { RefreshCw, RotateCcw, ShieldAlert } from "lucide-react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = {
    hasError: false,
    error: null,
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("UniOB UI ErrorBoundary caught an error:", error, info);
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  private handleReload = () => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const message = this.state.error?.message || "未知前端渲染异常";

    return (
      <div className="min-h-dvh flex items-center justify-center p-4 horizon-grid-bg bg-[var(--bg-canvas)] text-[var(--text-primary)]">
        <div className="w-full max-w-md rounded-2xl surface-elevated p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-rose-500/12 border border-rose-500/35 flex items-center justify-center shrink-0">
              <ShieldAlert className="w-5 h-5 text-rose-500" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-base font-bold tracking-tight text-[var(--text-primary)]">
                页面显示遇到问题
              </h1>
              <p className="text-xs text-[var(--text-secondary)]">
                界面暂时恢复中，可重试或刷新页面
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 p-3.5 text-xs text-rose-700 dark:text-rose-200 font-mono-num break-words">
            {message}
          </div>

          <div className="flex items-center gap-2.5 text-xs">
            <button
              type="button"
              onClick={this.handleRetry}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-[var(--accent-solid)] hover:bg-[var(--accent-hover)] text-white font-semibold transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
              重试
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] hover:bg-[var(--bg-card-hover)] text-[var(--text-primary)] font-semibold transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
              刷新页面
            </button>
          </div>
        </div>
      </div>
    );
  }
}
