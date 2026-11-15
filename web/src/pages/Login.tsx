import { useId, useMemo, useState } from "react";
import {
  Eye,
  EyeOff,
  KeyRound,
  Layers,
  Loader2,
  LogIn,
  LogOut,
  Moon,
  RefreshCw,
  ShieldAlert,
  Sun,
} from "lucide-react";
import { api, ApiError } from "../api/client";
import { Button } from "../components/ui/Primitives";
import type { AuthStatus, ThemeMode } from "../types";

export interface LoginProps {
  auth: AuthStatus;
  authError?: string | null;
  themeMode: ThemeMode;
  resolvedTheme: "dark" | "light";
  onCycleTheme: () => void;
  onSuccess: () => Promise<void> | void;
}

export function Login({
  auth,
  authError,
  resolvedTheme,
  onCycleTheme,
  onSuccess,
}: LoginProps): React.JSX.Element {
  const errorId = useId();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const authMode = auth.mode;
  const needsSetup = auth.needsSetup;
  const forbidden = Boolean(auth.forbidden);
  const authEmail = auth.email;

  const passwordStrength = useMemo(() => {
    if (!password) {
      return { label: "未输入", pct: 0, color: "var(--border-strong)" };
    }
    let score = 0;
    if (password.length >= 8) score += 1;
    if (password.length >= 12) score += 1;
    if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score += 1;
    if (/[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password)) score += 1;
    if (score <= 1) {
      return { label: "弱", pct: 30, color: "var(--status-danger)" };
    }
    if (score <= 2) {
      return { label: "中", pct: 65, color: "var(--status-warn)" };
    }
    return { label: "强", pct: 100, color: "var(--status-ok)" };
  }, [password]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (needsSetup) {
      if (password.length < 8) {
        setError("密码长度至少为 8 位字符");
        return;
      }
      if (password !== confirmPassword) {
        setError("两次输入的密码不一致");
        return;
      }
    } else if (!password) {
      setError("请输入管理员密码");
      return;
    }

    setSubmitting(true);
    try {
      if (needsSetup) {
        await api.setupPassword(password);
      } else {
        await api.login(password);
      }
      await onSuccess();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError("尝试次数过多，请稍后再试");
      } else {
        setError(err instanceof Error ? err.message : "验证失败");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleRetry = async () => {
    setRetrying(true);
    setError(null);
    try {
      await onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "权限校验失败");
    } finally {
      setRetrying(false);
    }
  };

  const subtitle =
    authMode === "cf_access"
      ? forbidden
        ? "访问受限"
        : "Cloudflare Access 登录"
      : needsSetup
        ? "初始化管理员密码"
        : "管理员登录";

  const displayError = error || authError || null;

  return (
    <div
      style={{
        backgroundColor: "var(--bg-shell)",
        color: "var(--text-primary)",
      }}
      className="relative flex min-h-dvh items-center justify-center p-4 sm:p-6"
    >
      {/* Corner Theme Toggle */}
      <div className="fixed top-4 right-4 z-10">
        <button
          type="button"
          onClick={onCycleTheme}
          aria-label={`切换显示主题，当前${resolvedTheme === "dark" ? "深色" : "浅色"}`}
          style={{
            backgroundColor: "var(--bg-sheet)",
            border: "1px solid var(--border-subtle)",
            color: "var(--text-secondary)",
          }}
          className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[8px] px-2.5 text-[12px] font-medium transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
        >
          {resolvedTheme === "dark" ? (
            <Moon className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Sun className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <span>{resolvedTheme === "dark" ? "深色" : "浅色"}</span>
        </button>
      </div>

      <main className="atelier-sheet w-full max-w-[400px] space-y-6 p-6 sm:p-7">
        {/* Brand Header */}
        <div className="flex items-center gap-3">
          <div
            style={{
              backgroundColor: "var(--ink-primary)",
              color: "var(--ink-on-primary)",
            }}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px]"
          >
            <Layers className="h-4 w-4" strokeWidth={1.9} aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h1 className="text-[16px] leading-tight font-semibold tracking-[-0.015em]">
              UniOB
            </h1>
            <p
              style={{ color: "var(--text-tertiary)" }}
              className="truncate text-[12px]"
            >
              {subtitle}
            </p>
          </div>
        </div>

        {authMode === "cf_access" ? (
          <div className="space-y-4 text-[13px]">
            {displayError && (
              <div
                id={errorId}
                role="alert"
                style={{
                  backgroundColor: "var(--status-danger-bg)",
                  border: "1px solid var(--status-danger-border)",
                  color: "var(--status-danger-ink)",
                }}
                className="flex items-start gap-2 rounded-[8px] px-3.5 py-2.5 text-[12.5px]"
              >
                <ShieldAlert
                  className="mt-0.5 h-4 w-4 shrink-0"
                  aria-hidden="true"
                />
                <span>{displayError}</span>
              </div>
            )}

            {forbidden ? (
              <>
                <div
                  style={{
                    backgroundColor: "var(--status-danger-bg)",
                    border: "1px solid var(--status-danger-border)",
                    color: "var(--status-danger-ink)",
                  }}
                  className="space-y-1.5 rounded-[10px] p-4 text-[12.5px]"
                >
                  <div className="font-semibold">当前账号无访问权限</div>
                  <p className="leading-relaxed">
                    账号{" "}
                    <code className="font-mono-num font-semibold">
                      {authEmail ?? "当前账号"}
                    </code>{" "}
                    未加入允许列表，请切换账号后重试。
                  </p>
                </div>

                <div className="space-y-2">
                  <a
                    href="/cdn-cgi/access/logout"
                    style={{
                      backgroundColor: "var(--ink-primary)",
                      color: "var(--ink-on-primary)",
                      boxShadow: "var(--shadow-btn-primary)",
                    }}
                    className="flex h-9 w-full items-center justify-center gap-2 rounded-[8px] px-4 text-[13px] font-medium transition-opacity hover:opacity-92"
                  >
                    <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>切换账号</span>
                  </a>

                  <Button
                    variant="secondary"
                    size="md"
                    className="w-full"
                    disabled={retrying}
                    onClick={() => void handleRetry()}
                    icon={
                      retrying ? (
                        <Loader2
                          className="h-3.5 w-3.5 animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                      )
                    }
                  >
                    重新检测权限
                  </Button>
                </div>
              </>
            ) : (
              <div className="space-y-2.5">
                <a
                  href="/cdn-cgi/access/login"
                  style={{
                    backgroundColor: "var(--ink-primary)",
                    color: "var(--ink-on-primary)",
                    boxShadow: "var(--shadow-btn-primary)",
                  }}
                  className="flex h-9 w-full items-center justify-center gap-2 rounded-[8px] px-4 text-[13px] font-medium transition-opacity hover:opacity-92"
                >
                  <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>使用 Cloudflare Access 登录</span>
                </a>

                <Button
                  variant="secondary"
                  size="md"
                  className="w-full"
                  disabled={retrying}
                  onClick={() => void handleRetry()}
                  icon={
                    retrying ? (
                      <Loader2
                        className="h-3.5 w-3.5 animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    )
                  }
                >
                  刷新登录状态
                </Button>
              </div>
            )}
          </div>
        ) : needsSetup ? (
          <form
            method="post"
            noValidate
            onSubmit={handleSubmit}
            className="space-y-4 text-[13px]"
          >
            {displayError && (
              <div
                id={errorId}
                role="alert"
                style={{
                  backgroundColor: "var(--status-danger-bg)",
                  border: "1px solid var(--status-danger-border)",
                  color: "var(--status-danger-ink)",
                }}
                className="flex items-start gap-2 rounded-[8px] px-3.5 py-2.5 text-[12.5px]"
              >
                <ShieldAlert
                  className="mt-0.5 h-4 w-4 shrink-0"
                  aria-hidden="true"
                />
                <span>{displayError}</span>
              </div>
            )}

            <div>
              <label
                htmlFor="new-password"
                style={{ color: "var(--text-secondary)" }}
                className="mb-1.5 block text-[12px] font-medium"
              >
                管理员密码（至少 8 位）
              </label>
              <div className="relative">
                <KeyRound
                  style={{ color: "var(--text-tertiary)" }}
                  className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2"
                  aria-hidden="true"
                />
                <input
                  id="new-password"
                  name="new-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  minLength={8}
                  required
                  autoFocus
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (error) setError(null);
                  }}
                  aria-invalid={displayError ? true : undefined}
                  aria-describedby={displayError ? errorId : undefined}
                  placeholder="不少于 8 位字符"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    border: "1px solid var(--border-subtle)",
                    color: "var(--text-primary)",
                  }}
                  className="font-mono-num h-9 w-full rounded-[8px] pr-9 pl-9 text-[13px] placeholder:text-[var(--text-tertiary)]"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  aria-pressed={showPassword}
                  style={{ color: "var(--text-tertiary)" }}
                  className="absolute top-1/2 right-2.5 -translate-y-1/2 cursor-pointer rounded p-1 hover:text-[var(--text-primary)]"
                >
                  {showPassword ? (
                    <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </button>
              </div>

              <div className="mt-2 flex items-center gap-2">
                <div
                  style={{ backgroundColor: "var(--bg-muted)" }}
                  className="h-1 flex-1 overflow-hidden rounded-full"
                >
                  <div
                    style={{
                      width: `${passwordStrength.pct}%`,
                      backgroundColor: passwordStrength.color,
                    }}
                    className="h-full rounded-full transition-all"
                  />
                </div>
                <span
                  style={{ color: "var(--text-tertiary)" }}
                  className="font-mono-num text-[11px]"
                >
                  强度：{passwordStrength.label}
                </span>
              </div>
            </div>

            <div>
              <label
                htmlFor="confirm-password"
                style={{ color: "var(--text-secondary)" }}
                className="mb-1.5 block text-[12px] font-medium"
              >
                确认密码
              </label>
              <div className="relative">
                <KeyRound
                  style={{ color: "var(--text-tertiary)" }}
                  className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2"
                  aria-hidden="true"
                />
                <input
                  id="confirm-password"
                  name="confirm-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  minLength={8}
                  required
                  value={confirmPassword}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value);
                    if (error) setError(null);
                  }}
                  aria-invalid={displayError ? true : undefined}
                  aria-describedby={displayError ? errorId : undefined}
                  placeholder="再次输入密码"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    border: "1px solid var(--border-subtle)",
                    color: "var(--text-primary)",
                  }}
                  className="font-mono-num h-9 w-full rounded-[8px] pr-3 pl-9 text-[13px] placeholder:text-[var(--text-tertiary)]"
                />
              </div>
            </div>

            <Button
              type="submit"
              variant="primary"
              size="md"
              className="w-full"
              disabled={submitting}
              icon={
                submitting ? (
                  <Loader2
                    className="h-3.5 w-3.5 animate-spin"
                    aria-hidden="true"
                  />
                ) : undefined
              }
            >
              保存并进入面板
            </Button>
          </form>
        ) : (
          <form
            method="post"
            noValidate
            onSubmit={handleSubmit}
            className="space-y-4 text-[13px]"
          >
            {displayError && (
              <div
                id={errorId}
                role="alert"
                style={{
                  backgroundColor: "var(--status-danger-bg)",
                  border: "1px solid var(--status-danger-border)",
                  color: "var(--status-danger-ink)",
                }}
                className="flex items-start gap-2 rounded-[8px] px-3.5 py-2.5 text-[12.5px]"
              >
                <ShieldAlert
                  className="mt-0.5 h-4 w-4 shrink-0"
                  aria-hidden="true"
                />
                <span>{displayError}</span>
              </div>
            )}

            <div>
              <label
                htmlFor="current-password"
                style={{ color: "var(--text-secondary)" }}
                className="mb-1.5 block text-[12px] font-medium"
              >
                管理员密码
              </label>
              <div className="relative">
                <KeyRound
                  style={{ color: "var(--text-tertiary)" }}
                  className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2"
                  aria-hidden="true"
                />
                <input
                  id="current-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  enterKeyHint="done"
                  required
                  autoFocus
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (error) setError(null);
                  }}
                  aria-invalid={displayError ? true : undefined}
                  aria-describedby={displayError ? errorId : undefined}
                  placeholder="输入管理员密码"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    border: "1px solid var(--border-subtle)",
                    color: "var(--text-primary)",
                  }}
                  className="font-mono-num h-9 w-full rounded-[8px] pr-9 pl-9 text-[13px] placeholder:text-[var(--text-tertiary)]"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  aria-pressed={showPassword}
                  style={{ color: "var(--text-tertiary)" }}
                  className="absolute top-1/2 right-2.5 -translate-y-1/2 cursor-pointer rounded p-1 hover:text-[var(--text-primary)]"
                >
                  {showPassword ? (
                    <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>

            <Button
              type="submit"
              variant="primary"
              size="md"
              className="w-full"
              disabled={submitting}
              icon={
                submitting ? (
                  <Loader2
                    className="h-3.5 w-3.5 animate-spin"
                    aria-hidden="true"
                  />
                ) : undefined
              }
            >
              登录
            </Button>
          </form>
        )}
      </main>
    </div>
  );
}
