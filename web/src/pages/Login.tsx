import { useState } from "react";
import {
  Activity,
  KeyRound,
  Loader2,
  Lock,
  LogIn,
  LogOut,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { api, ApiError } from "../api/client";

interface LoginProps {
  needsSetup: boolean;
  authMode?: "builtin" | "cf_access";
  forbidden?: boolean;
  authEmail?: string;
  authError?: string | null;
  onAuthenticated: () => Promise<void> | void;
}

export function Login({
  needsSetup,
  authMode = "builtin",
  forbidden = false,
  authEmail,
  authError,
  onAuthenticated,
}: LoginProps) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      await onAuthenticated();
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
    try {
      await onAuthenticated();
    } finally {
      setRetrying(false);
    }
  };

  const subtitle =
    authMode === "cf_access"
      ? forbidden
        ? "暂无访问权限"
        : "Cloudflare 安全验证"
      : needsSetup
        ? "首次使用 · 设置管理员密码"
        : "管理员登录";

  const displayError = error || authError;

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-[#f3f6fa] dark:bg-[#090d14]">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0f1623] shadow-xl p-6 sm:p-8 space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-slate-900 dark:bg-sky-500/15 border border-slate-700 dark:border-sky-500/30 flex items-center justify-center">
            <Activity className="w-5 h-5 text-emerald-400" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-slate-900 dark:text-slate-50">
              UniOB 服务器监控面板
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {subtitle}
            </p>
          </div>
        </div>

        {authMode === "cf_access" ? (
          <div className="space-y-4">
            {authError && (
              <div
                role="alert"
                className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300"
              >
                {authError}
              </div>
            )}

            {forbidden ? (
              <>
                <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 p-4 text-xs text-rose-700 dark:text-rose-200 flex items-start gap-2.5">
                  <ShieldAlert className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" aria-hidden="true" />
                  <div className="space-y-1">
                    <div className="font-semibold text-rose-600 dark:text-rose-300">
                      无权访问监控面板（403）
                    </div>
                    <p className="leading-relaxed">
                      当前账号{" "}
                      <span className="font-mono-num font-semibold">
                        {authEmail ?? "当前账号"}
                      </span>{" "}
                      未在管理员允许列表中，请联系管理员授权或切换邮箱。
                    </p>
                  </div>
                </div>

                <div className="space-y-2.5 text-xs">
                  <a
                    href="/cdn-cgi/access/logout"
                    className="w-full py-2.5 px-4 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-semibold text-sm flex items-center justify-center gap-2 transition-colors"
                  >
                    <LogOut className="w-4 h-4" aria-hidden="true" />
                    退出当前账号并切换邮箱
                  </a>

                  <button
                    type="button"
                    onClick={() => void handleRetry()}
                    disabled={retrying}
                    className="w-full py-2.5 px-4 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#090d14] hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 font-medium text-xs flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
                  >
                    {retrying ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    重新检测权限
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#090d14] p-4 text-xs text-slate-600 dark:text-slate-300 flex items-start gap-2.5">
                  <ShieldCheck className="w-4 h-4 text-sky-500 shrink-0 mt-0.5" aria-hidden="true" />
                  <span className="leading-relaxed">
                    本面板已启用 Cloudflare Access 账号验证，请完成登录后继续使用。
                  </span>
                </div>

                <div className="space-y-2.5 text-xs">
                  <a
                    href="/cdn-cgi/access/login"
                    className="w-full py-2.5 px-4 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold text-sm flex items-center justify-center gap-2 transition-colors"
                  >
                    <LogIn className="w-4 h-4" aria-hidden="true" />
                    使用 Cloudflare 账号登录
                  </a>

                  <button
                    type="button"
                    onClick={() => void handleRetry()}
                    disabled={retrying}
                    className="w-full py-2.5 px-4 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#090d14] hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 font-medium text-xs flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
                  >
                    {retrying ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    刷新登录状态
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#090d14] p-3.5 text-xs text-slate-600 dark:text-slate-300 flex items-start gap-2.5">
              {needsSetup ? (
                <>
                  <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>
                    首次使用尚未设置管理员密码，请创建一个不少于 8 位的登录密码，设置后即可进入面板。
                  </span>
                </>
              ) : (
                <>
                  <Lock className="w-4 h-4 text-sky-500 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>
                    请输入管理员密码以查看和管理您的服务器。
                  </span>
                </>
              )}
            </div>

            <form onSubmit={handleSubmit} className="space-y-4 text-xs">
              {displayError && (
                <div
                  role="alert"
                  className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-600 dark:text-rose-300"
                >
                  {displayError}
                </div>
              )}

              <div>
                <label
                  htmlFor="login-admin-password"
                  className="block font-medium text-slate-700 dark:text-slate-300 mb-1.5"
                >
                  {needsSetup ? "设置管理员密码（至少 8 位）" : "管理员密码"}
                </label>
                <div className="relative">
                  <KeyRound className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
                  <input
                    id="login-admin-password"
                    type="password"
                    autoFocus
                    required
                    autoComplete={needsSetup ? "new-password" : "current-password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="请输入密码"
                    className="w-full pl-9 pr-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#090d14] text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                  />
                </div>
              </div>

              {needsSetup && (
                <div>
                  <label
                    htmlFor="login-confirm-password"
                    className="block font-medium text-slate-700 dark:text-slate-300 mb-1.5"
                  >
                    确认管理员密码
                  </label>
                  <div className="relative">
                    <KeyRound className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
                    <input
                      id="login-confirm-password"
                      type="password"
                      required
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="请再次输入密码"
                      className="w-full pl-9 pr-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#090d14] text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                    />
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full py-2.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold text-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
              >
                {submitting && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                {needsSetup ? "完成设置并进入面板" : "登录面板"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
