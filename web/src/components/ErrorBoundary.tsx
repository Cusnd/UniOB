import { Component, type ErrorInfo, type ReactNode } from "react";
import { RefreshCw, RotateCcw, ShieldAlert } from "lucide-react";
import { Button } from "./ui/Primitives";

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

    const message = this.state.error?.message || "页面渲染异常";

    return (
      <div
        style={{
          backgroundColor: "var(--bg-shell)",
          color: "var(--text-primary)",
        }}
        className="flex min-h-dvh items-center justify-center p-4"
      >
        <div className="atelier-sheet w-full max-w-[400px] space-y-5 p-6">
          <div className="flex items-center gap-3">
            <div
              style={{
                backgroundColor: "var(--status-danger-bg)",
                border: "1px solid var(--status-danger-border)",
                color: "var(--status-danger-ink)",
              }}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px]"
            >
              <ShieldAlert className="h-4.5 w-4.5" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-[15px] font-semibold tracking-[-0.015em]">
                页面加载出错
              </h1>
              <p
                style={{ color: "var(--text-tertiary)" }}
                className="text-[12px]"
              >
                请重试或刷新浏览器页面
              </p>
            </div>
          </div>

          <div
            style={{
              backgroundColor: "var(--status-danger-bg)",
              border: "1px solid var(--status-danger-border)",
              color: "var(--status-danger-ink)",
            }}
            className="font-mono-num rounded-[8px] px-3.5 py-2.5 text-[12px] break-words"
          >
            {message}
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="md"
              className="flex-1"
              onClick={this.handleRetry}
              icon={<RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />}
            >
              重试
            </Button>
            <Button
              variant="secondary"
              size="md"
              className="flex-1"
              onClick={this.handleReload}
              icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
            >
              刷新页面
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
