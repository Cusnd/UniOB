import { useId, useMemo, useState } from "react";
import {
  Activity,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  LogIn,
  LogOut,
  Monitor,
  Moon,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sun,
} from "lucide-react";
import { api, ApiError } from "../api/client";
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
  themeMode,
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
    if (!password) return { label: "未输入", pct: 0, cls: "bg-slate-400" };
    let score = 0;
    if (password.length >= 8) score += 1;
    if (password.length >= 12) score += 1;
    if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score += 1;
    if (/[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password)) score += 1;
    if (score <= 1) return { label: "弱", pct: 30, cls: "bg-rose-500" };
    if (score <= 2) return { label: "中", pct: 65, cls: "bg-amber-500" };
    return { label: "强", pct: 100, cls: "bg-emerald-500" };
  }, [password]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (needsSetup) {
      if (password.length < 8) {
        setError("管理员密码长度至少为 8 位字符");
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
        ? "Cloudflare Zero Trust · 访问受限"
        : "Cloudflare Zero Trust · 边缘零信任认证"
      : needsSetup
        ? "首次部署引导 · 设置管理员密码"
        : "内置管理员鉴权 · 控制面登录";

  const displayError = error || authError || null;

  const ThemeIcon =
    themeMode === "dark" ? Moon : themeMode === "light" ? Sun : Monitor;
  const themeLabel =
    themeMode === "dark" ? "深色" : themeMode === "light" ? "浅色" : "跟随系统";

  return (
    <div className="min-h-dvh relative flex items-center justify-center p-4 sm:p-6 horizon-grid-bg bg-[var(--bg-canvas)] text-[var(--text-primary)]">
      {/* Corner Theme Toggle */}
      <div className="fixed top-4 right-4 z-10">
        <button
          type="button"
          onClick={onCycleTheme}
          aria-label={`切换显示主题，当前 ${themeLabel}`}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border border-[var(--border-subtle)] bg-[var(--bg-surface)]/90 backdrop-blur-md text-[var(--text-primary)] hover:border-[var(--accent-ring)] shadow-xs transition-colors"
        >
          <ThemeIcon
            className="w-3.5 h-3.5 text-[var(--accent-primary)]"
            aria-hidden="true"
          />
          <span>{themeLabel}</span>
          <span className="text-[10px] font-mono-num text-[var(--text-secondary)]">
            ({resolvedTheme === "dark" ? "Dark" : "Light"})
          </span>
        </button>
      </div>

      <main className="w-full max-w-md surface-elevated rounded-2xl p-6 sm:p-7 space-y-5">
        {/* Brand Header */}
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-xl border flex items-center justify-center shrink-0"
            style={{
              backgroundColor: "var(--accent-soft)",
              borderColor: "var(--accent-ring)",
            }}
          >
            <Activity
              className="w-5 h-5 text-[var(--accent-primary)]"
              aria-hidden="true"
            />
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-bold tracking-tight text-[var(--text-primary)]">
              UniOB Horizon 控制台
            </h1>
            <p className="text-[11px] text-[var(--text-secondary)] truncate">
              {subtitle}
            </p>
          </div>
        </div>

        {authMode === "cf_access" ? (
          <div className="space-y-4 text-xs">
            {displayError && (
              <div
                id={errorId}
                role="alert"
                className="rounded-xl border border-rose-500/40 bg-rose-500/12 px-3.5 py-2.5 text-rose-800 dark:text-rose-200 flex items-start gap-2"
              >
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{displayError}</span>
              </div>
            )}

            {forbidden ? (
              <>
                <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 flex items-start gap-3">
                  <ShieldAlert
                    className="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                  <div className="space-y-1.5">
                    <div className="text-sm font-bold text-rose-700 dark:text-rose-300">
                      无权访问监控控制台（HTTP 403）
                    </div>
                    <p className="text-rose-800/90 dark:text-rose-200/90 leading-relaxed">
                      当前账号{" "}
                      <code className="font-mono-num font-semibold px-1.5 py-0.5 rounded bg-rose-500/15">
                        {authEmail ?? "当前账号"}
                      </code>{" "}
                      未在管理员允许列表中，请联系管理员授权或切换邮箱。
                    </p>
                  </div>
                </div>

                <div className="space-y-2.5">
                  <a
                    href="/cdn-cgi/access/logout"
                    className="w-full py-2.5 px-4 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-semibold text-sm flex items-center justify-center gap-2 shadow-sm transition-colors"
                  >
                    <LogOut className="w-4 h-4" aria-hidden="true" />
                    <span>退出当前账号并切换邮箱</span>
                  </a>

                  <button
                    type="button"
                    onClick={() => void handleRetry()}
                    disabled={retrying}
                    className="w-full py-2 px-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] hover:bg-[var(--bg-card-hover)] text-[var(--text-primary)] font-medium flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
                  >
                    {retrying ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    <span>重新检测权限</span>
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="rounded-xl border border-sky-500/35 bg-sky-500/10 p-4 flex items-start gap-2.5 text-sky-900 dark:text-sky-200">
                  <ShieldCheck
                    className="w-4 h-4 text-sky-600 dark:text-sky-400 shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                  <span className="leading-relaxed">
                    本面板已启用 Cloudflare Access 零信任身份网关，请完成边缘账号验证后继续使用。
                  </span>
                </div>

                <div className="space-y-2.5">
                  <a
                    href="/cdn-cgi/access/login"
                    className="w-full py-2.5 px-4 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold text-sm flex items-center justify-center gap-2 shadow-sm transition-colors"
                  >
                    <LogIn className="w-4 h-4" aria-hidden="true" />
                    <span>使用 Cloudflare 账号登录</span>
                  </a>

                  <button
                    type="button"
                    onClick={() => void handleRetry()}
                    disabled={retrying}
                    className="w-full py-2 px-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] hover:bg-[var(--bg-card-hover)] text-[var(--text-primary)] font-medium flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
                  >
                    {retrying ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    <span>刷新登录状态</span>
                  </button>
                </div>
              </>
            )}
          </div>
        ) : needsSetup ? (
          <form
            method="post"
            noValidate
            onSubmit={handleSubmit}
            className="space-y-4 text-xs"
          >
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3.5 flex items-start gap-2.5 text-emerald-800 dark:text-emerald-200">
              <ShieldCheck
                className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5"
                aria-hidden="true"
              />
              <span className="leading-relaxed">
                首次使用尚未设置管理员密码，请创建一个不少于 8 位的登录密码，设置后即可进入面板。
              </span>
            </div>

            {displayError && (
              <div
                id={errorId}
                role="alert"
                className="rounded-xl border border-rose-500/40 bg-rose-500/12 px-3.5 py-2.5 text-rose-800 dark:text-rose-200 flex items-start gap-2"
              >
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{displayError}</span>
              </div>
            )}

            <div>
              <label
                htmlFor="new-password"
                className="block font-medium text-[var(--text-secondary)] mb-1.5"
              >
                设置管理员密码（至少 8 位）
              </label>
              <div className="relative">
                <KeyRound
                  className="w-4 h-4 text-[var(--text-muted)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
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
                  placeholder="请输入不少于 8 位字符"
                  className="w-full pl-9 pr-10 py-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-primary)] font-mono-num"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  aria-pressed={showPassword}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  {showPassword ? (
                    <EyeOff className="w-3.5 h-3.5" aria-hidden="true" />
                  ) : (
                    <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                  )}
                </button>
              </div>

              {/* Password strength meter */}
              <div className="mt-2 flex items-center gap-2">
                <div className="flex-1 h-1.5 rounded-full bg-[var(--bg-inset)] overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${passwordStrength.cls}`}
                    style={{ width: `${passwordStrength.pct}%` }}
                  />
                </div>
                <span className="font-mono-num text-[10px] text-[var(--text-muted)]">
                  强度：{passwordStrength.label}
                </span>
              </div>
            </div>

            <div>
              <label
                htmlFor="confirm-password"
                className="block font-medium text-[var(--text-secondary)] mb-1.5"
              >
                确认管理员密码
              </label>
              <div className="relative">
                <KeyRound
                  className="w-4 h-4 text-[var(--text-muted)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
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
                  placeholder="请再次输入密码"
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-primary)] font-mono-num"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 rounded-xl text-white font-semibold text-sm flex items-center justify-center gap-2 shadow-sm transition-colors disabled:opacity-60"
              style={{ backgroundColor: "var(--accent-solid)" }}
            >
              {submitting && (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              )}
              <span>完成设置并进入面板</span>
            </button>
          </form>
        ) : (
          <form
            method="post"
            noValidate
            onSubmit={handleSubmit}
            className="space-y-4 text-xs"
          >
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3.5 flex items-start gap-2.5 text-[var(--text-secondary)]">
              <Lock
                className="w-4 h-4 text-[var(--accent-primary)] shrink-0 mt-0.5"
                aria-hidden="true"
              />
              <span className="leading-relaxed">
                请输入管理员密码以查看和管理您的服务器集群与监控告警。
              </span>
            </div>

            {displayError && (
              <div
                id={errorId}
                role="alert"
                className="rounded-xl border border-rose-500/40 bg-rose-500/12 px-3.5 py-2.5 text-rose-800 dark:text-rose-200 flex items-start gap-2"
              >
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{displayError}</span>
              </div>
            )}

            <div>
              <label
                htmlFor="current-password"
                className="block font-medium text-[var(--text-secondary)] mb-1.5"
              >
                管理员密码
              </label>
              <div className="relative">
                <KeyRound
                  className="w-4 h-4 text-[var(--text-muted)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
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
                  placeholder="请输入管理员密码"
                  className="w-full pl-9 pr-10 py-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-primary)] font-mono-num"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  aria-pressed={showPassword}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  {showPassword ? (
                    <EyeOff className="w-3.5 h-3.5" aria-hidden="true" />
                  ) : (
                    <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 rounded-xl text-white font-semibold text-sm flex items-center justify-center gap-2 shadow-sm transition-colors disabled:opacity-60"
              style={{ backgroundColor: "var(--accent-solid)" }}
            >
              {submitting && (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              )}
              <span>登录面板</span>
            </button>
          </form>
        )}
      </main>
    </div>
  );
}
