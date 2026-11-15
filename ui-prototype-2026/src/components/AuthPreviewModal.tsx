import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Activity,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  LogIn,
  LogOut,
  Moon,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Sun,
  X,
} from "lucide-react";

export interface AuthPreviewModalProps {
  open: boolean;
  resolvedTheme: "dark" | "light";
  onClose: () => void;
  onCycleTheme: () => void;
}

type AuthPreviewMode = "login" | "setup" | "cf-sso" | "cf-403";

const AUTH_MODES: Array<{
  key: AuthPreviewMode;
  label: string;
  subtitle: string;
}> = [
  {
    key: "login",
    label: "① 密码登录",
    subtitle: "内置管理员鉴权 · PBKDF2-HMAC-SHA256",
  },
  {
    key: "setup",
    label: "② 首次初始化向导",
    subtitle: "首次部署引导 · 生成管理员密码哈希",
  },
  {
    key: "cf-sso",
    label: "③ Cloudflare Zero Trust SSO",
    subtitle: "边缘 Cf-Access-Jwt-Assertion 零信任认证",
  },
  {
    key: "cf-403",
    label: "④ Access 403 未授权拦截页",
    subtitle: "Zero Trust 白名单拦截与切换账号",
  },
];

const DIALOG_LIGHT_DISMISS_ATTRS: Record<string, string> = {
  closedby: "any",
};

function isOutsideDialogBounds(
  e: React.PointerEvent<HTMLDialogElement>,
  dialog: HTMLDialogElement,
): boolean {
  const rect = dialog.getBoundingClientRect();
  return (
    e.clientX < rect.left ||
    e.clientX > rect.right ||
    e.clientY < rect.top ||
    e.clientY > rect.bottom
  );
}

export function AuthPreviewModal({
  open,
  resolvedTheme,
  onClose,
  onCycleTheme,
}: AuthPreviewModalProps): React.JSX.Element {
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const loginPwdId = `${baseId}-login-pwd`;
  const setupPwdId = `${baseId}-setup-pwd`;
  const setupConfirmId = `${baseId}-setup-confirm`;

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const pointerDownOutsideRef = useRef(false);
  const syncingCloseRef = useRef(false);
  const tabRefs = useRef<Record<AuthPreviewMode, HTMLButtonElement | null>>({
    login: null,
    setup: null,
    "cf-sso": null,
    "cf-403": null,
  });

  const [mode, setMode] = useState<AuthPreviewMode>("login");
  const [loginPassword, setLoginPassword] = useState("");
  const [showLoginPwd, setShowLoginPwd] = useState(false);

  const [setupPassword, setSetupPassword] = useState("");
  const [setupConfirm, setSetupConfirm] = useState("");
  const [showSetupPwd, setShowSetupPwd] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "danger" | "info";
    title: string;
    detail?: string;
  } | null>(null);

  const simTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (simTimerRef.current !== null) {
        window.clearTimeout(simTimerRef.current);
      }
    };
  }, []);

  const resetPreviewState = useCallback(() => {
    if (simTimerRef.current !== null) {
      window.clearTimeout(simTimerRef.current);
      simTimerRef.current = null;
    }
    setSubmitting(false);
    setFeedback(null);
    setLoginPassword("");
    setSetupPassword("");
    setSetupConfirm("");
    setShowLoginPwd(false);
    setShowSetupPwd(false);
  }, []);

  const handleClose = useCallback(() => {
    resetPreviewState();
    onClose();
  }, [onClose, resetPreviewState]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      syncingCloseRef.current = true;
      dialog.close();
      syncingCloseRef.current = false;
      resetPreviewState();
    }
  }, [open, resetPreviewState]);

  const switchMode = (nextMode: AuthPreviewMode) => {
    setMode(nextMode);
    setFeedback(null);
    setSubmitting(false);
  };

  const handleTabKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    idx: number,
  ) => {
    const order: AuthPreviewMode[] = ["login", "setup", "cf-sso", "cf-403"];
    let nextIdx: number | null = null;
    if (e.key === "ArrowRight") nextIdx = (idx + 1) % order.length;
    else if (e.key === "ArrowLeft")
      nextIdx = (idx - 1 + order.length) % order.length;
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = order.length - 1;
    if (nextIdx === null) return;
    e.preventDefault();
    const target = order[nextIdx];
    switchMode(target);
    tabRefs.current[target]?.focus();
  };

  const runSimulatedSubmit = (
    action: () => {
      tone: "success" | "danger" | "info";
      title: string;
      detail?: string;
    },
  ) => {
    if (simTimerRef.current !== null) {
      window.clearTimeout(simTimerRef.current);
    }
    setSubmitting(true);
    setFeedback(null);
    simTimerRef.current = window.setTimeout(() => {
      setSubmitting(false);
      setFeedback(action());
      simTimerRef.current = null;
    }, 420);
  };

  const handleLoginSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginPassword.trim()) {
      setFeedback({
        tone: "danger",
        title: "请输入管理员密码",
        detail: "可点击输入框旁「填入演示密码」快速体验。",
      });
      return;
    }
    runSimulatedSubmit(() => ({
      tone: "success",
      title: "管理员身份验证通过（演示态）",
      detail:
        "Edge Worker 已签发 HttpOnly; SameSite=Strict 的 uniob_session 会话 Cookie（有效期 7 天）。",
    }));
  };

  const handleSetupSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (setupPassword.length < 8) {
      setFeedback({
        tone: "danger",
        title: "管理员密码长度至少为 8 位字符",
      });
      return;
    }
    if (setupPassword !== setupConfirm) {
      setFeedback({
        tone: "danger",
        title: "两次输入的确认密码不一致",
      });
      return;
    }
    runSimulatedSubmit(() => ({
      tone: "success",
      title: "初始化向导已完成（演示态）",
      detail:
        "已通过 PBKDF2-HMAC-SHA256 派生管理员密钥哈希并写入系统配置表，控制台会话已自动签发。",
    }));
  };

  const passwordStrength = useMemo(() => {
    if (!setupPassword) return { label: "未输入", pct: 0, cls: "bg-slate-400" };
    let score = 0;
    if (setupPassword.length >= 8) score += 1;
    if (setupPassword.length >= 12) score += 1;
    if (/[A-Z]/.test(setupPassword) && /[a-z]/.test(setupPassword)) score += 1;
    if (/[0-9]/.test(setupPassword) && /[^A-Za-z0-9]/.test(setupPassword))
      score += 1;
    if (score <= 1) return { label: "弱", pct: 30, cls: "bg-rose-500" };
    if (score <= 2) return { label: "中", pct: 65, cls: "bg-amber-500" };
    return { label: "强", pct: 100, cls: "bg-emerald-500" };
  }, [setupPassword]);

  const currentMeta =
    AUTH_MODES.find((m) => m.key === mode) ?? AUTH_MODES[0];

  return (
    <dialog
      ref={dialogRef}
      {...DIALOG_LIGHT_DISMISS_ATTRS}
      aria-labelledby={titleId}
      onPointerDown={(e) => {
        const d = dialogRef.current;
        if (!d) return;
        pointerDownOutsideRef.current =
          e.target === d && isOutsideDialogBounds(e, d);
      }}
      onPointerUp={(e) => {
        const d = dialogRef.current;
        const startedOutside = pointerDownOutsideRef.current;
        pointerDownOutsideRef.current = false;
        if (!d || !startedOutside) return;
        if (e.target === d && isOutsideDialogBounds(e, d)) {
          handleClose();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        handleClose();
      }}
      onClose={() => {
        if (!syncingCloseRef.current && open) {
          handleClose();
        }
      }}
      className="m-auto w-[min(56rem,calc(100vw-2rem))] max-h-[92dvh] overflow-hidden overscroll-contain rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-2xl"
    >
      {/* Single inner flex container */}
      <div className="flex flex-col max-h-[92dvh] w-full min-h-0 bg-[var(--bg-surface)] text-[var(--text-primary)]">
        {/* Top Gallery Control Header */}
        <header className="shrink-0 px-5 pt-4 pb-0 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)]/70 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div
                className="w-8 h-8 rounded-xl flex items-center justify-center border shrink-0"
                style={{
                  backgroundColor: "var(--accent-soft)",
                  borderColor: "var(--accent-ring)",
                }}
              >
                <ShieldCheck
                  className="w-4 h-4 text-[var(--accent-primary)]"
                  aria-hidden="true"
                />
              </div>
              <div className="min-w-0">
                <h2
                  id={titleId}
                  className="text-sm font-bold text-[var(--text-primary)] truncate"
                >
                  UniOB Horizon 2026 登录与 Zero Trust 鉴权体验展厅
                </h2>
                <p className="text-[11px] text-[var(--text-secondary)] truncate">
                  支持内置管理员口令与 Cloudflare Access 边缘零信任双鉴权流一键预览
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={onCycleTheme}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)] hover:bg-[var(--bg-card-hover)] transition-colors"
              >
                {resolvedTheme === "dark" ? (
                  <Moon className="w-3.5 h-3.5 text-indigo-400" aria-hidden="true" />
                ) : (
                  <Sun className="w-3.5 h-3.5 text-amber-500" aria-hidden="true" />
                )}
                <span>
                  {resolvedTheme === "dark"
                    ? "Obsidian Dark"
                    : "Porcelain Light"}
                </span>
              </button>

              <button
                type="button"
                onClick={handleClose}
                aria-label="关闭鉴权展厅"
                className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)]"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* 4-State Pill Switcher Tablist */}
          <div
            role="tablist"
            aria-label="鉴权体验状态切换"
            className="flex gap-2 pb-3"
          >
            {AUTH_MODES.map((item, idx) => {
              const active = mode === item.key;
              return (
                <button
                  key={item.key}
                  ref={(el) => {
                    tabRefs.current[item.key] = el;
                  }}
                  id={`${baseId}-tab-${item.key}`}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls={`${baseId}-stage`}
                  tabIndex={active ? 0 : -1}
                  onClick={() => switchMode(item.key)}
                  onKeyDown={(e) => handleTabKeyDown(e, idx)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                    active
                      ? "text-[var(--accent-primary)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  }`}
                  style={
                    active
                      ? {
                          backgroundColor: "var(--accent-soft)",
                          borderColor: "var(--accent-ring)",
                        }
                      : undefined
                  }
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </header>

        {/* Showcase Stage */}
        <div
          id={`${baseId}-stage`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${mode}`}
          className="flex-1 overflow-y-auto horizon-grid-bg bg-[var(--bg-canvas)] p-6 sm:p-10 flex flex-col items-center justify-center min-h-[28rem]"
        >
          <div className="w-full max-w-md surface-elevated rounded-2xl p-6 sm:p-7 space-y-5">
            {/* Brand Header inside Preview Auth Card */}
            <div className="flex items-center justify-between gap-3">
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
                <div>
                  <h3 className="text-base font-bold tracking-tight text-[var(--text-primary)]">
                    UniOB Horizon 控制台
                  </h3>
                  <p className="text-[11px] text-[var(--text-secondary)]">
                    {currentMeta.subtitle}
                  </p>
                </div>
              </div>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono-num border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-muted)]">
                PREVIEW
              </span>
            </div>

            {/* Feedback Banner */}
            {feedback && (
              <div
                role={feedback.tone === "danger" ? "alert" : "status"}
                className={`rounded-xl border px-3.5 py-2.5 text-xs space-y-0.5 ${
                  feedback.tone === "success"
                    ? "border-emerald-500/40 bg-emerald-500/12 text-emerald-800 dark:text-emerald-200"
                    : feedback.tone === "danger"
                      ? "border-rose-500/40 bg-rose-500/12 text-rose-800 dark:text-rose-200"
                      : "border-sky-500/40 bg-sky-500/12 text-sky-800 dark:text-sky-200"
                }`}
              >
                <div className="font-semibold flex items-center gap-1.5">
                  {feedback.tone === "success" ? (
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  ) : feedback.tone === "danger" ? (
                    <ShieldAlert className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  ) : (
                    <Sparkles className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  )}
                  <span>{feedback.title}</span>
                </div>
                {feedback.detail && (
                  <p className="text-[11px] opacity-90 leading-relaxed pl-5">
                    {feedback.detail}
                  </p>
                )}
              </div>
            )}

            {/* Mode 1: Built-in Password Login */}
            {mode === "login" && (
              <form
                noValidate
                onSubmit={handleLoginSubmit}
                className="space-y-4 text-xs"
              >
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3.5 flex items-start gap-2.5 text-[var(--text-secondary)]">
                  <Lock
                    className="w-4 h-4 text-[var(--accent-primary)] shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                  <span className="leading-relaxed">
                    请输入管理员密码以解锁集群监控与热迁移操作台（连续失败 5 次自动触发 429 速率限制）。
                  </span>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label
                      htmlFor={loginPwdId}
                      className="font-medium text-[var(--text-secondary)]"
                    >
                      管理员密码
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setLoginPassword("UniOB#Horizon2026");
                        setFeedback(null);
                      }}
                      className="text-[11px] font-medium text-[var(--accent-primary)] hover:underline"
                    >
                      填入演示密码
                    </button>
                  </div>
                  <div className="relative">
                    <KeyRound
                      className="w-4 h-4 text-[var(--text-muted)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                      aria-hidden="true"
                    />
                    <input
                      id={loginPwdId}
                      type={showLoginPwd ? "text" : "password"}
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      placeholder="请输入管理员密码"
                      className="w-full pl-9 pr-10 py-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-primary)] font-mono-num"
                    />
                    <button
                      type="button"
                      onClick={() => setShowLoginPwd((v) => !v)}
                      aria-label={showLoginPwd ? "隐藏密码" : "显示密码"}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    >
                      {showLoginPwd ? (
                        <EyeOff className="w-3.5 h-3.5" aria-hidden="true" />
                      ) : (
                        <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full py-2.5 rounded-xl text-white font-semibold text-sm flex items-center justify-center gap-2 shadow-sm disabled:opacity-60"
                    style={{ backgroundColor: "var(--accent-solid)" }}
                  >
                    {submitting && (
                      <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                    )}
                    <span>演示登录进入面板</span>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setFeedback({
                        tone: "danger",
                        title: "HTTP 429 Too Many Requests（限流演示）",
                        detail:
                          "同一 IP 5 分钟内连续输错 5 次凭据，边缘鉴权层已锁定 300 秒。",
                      })
                    }
                    className="w-full py-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  >
                    模拟触发 429 暴力破解防护
                  </button>
                </div>
              </form>
            )}

            {/* Mode 2: Initial Setup Wizard */}
            {mode === "setup" && (
              <form
                noValidate
                onSubmit={handleSetupSubmit}
                className="space-y-4 text-xs"
              >
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3.5 flex items-start gap-2.5 text-emerald-800 dark:text-emerald-200">
                  <ShieldCheck
                    className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                  <span className="leading-relaxed">
                    检测到首次部署且未预设 `ADMIN_PASSWORD_HASH`。请设置至少 8 位高强度管理员口令以初始化控制面。
                  </span>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label
                      htmlFor={setupPwdId}
                      className="font-medium text-[var(--text-secondary)]"
                    >
                      设置管理员密码（≥ 8 位）
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setSetupPassword("Horizon#2026!Obs");
                        setSetupConfirm("Horizon#2026!Obs");
                        setFeedback(null);
                      }}
                      className="text-[11px] font-medium text-[var(--accent-primary)] hover:underline"
                    >
                      填充强密码示例
                    </button>
                  </div>
                  <div className="relative">
                    <KeyRound
                      className="w-4 h-4 text-[var(--text-muted)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                      aria-hidden="true"
                    />
                    <input
                      id={setupPwdId}
                      type={showSetupPwd ? "text" : "password"}
                      value={setupPassword}
                      onChange={(e) => setSetupPassword(e.target.value)}
                      placeholder="不少于 8 位字符"
                      className="w-full pl-9 pr-10 py-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-primary)] font-mono-num"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSetupPwd((v) => !v)}
                      aria-label={showSetupPwd ? "隐藏密码" : "显示密码"}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    >
                      {showSetupPwd ? (
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
                    htmlFor={setupConfirmId}
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
                      id={setupConfirmId}
                      type={showSetupPwd ? "text" : "password"}
                      value={setupConfirm}
                      onChange={(e) => setSetupConfirm(e.target.value)}
                      placeholder="请再次输入密码"
                      className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-primary)] font-mono-num"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full py-2.5 rounded-xl text-white font-semibold text-sm flex items-center justify-center gap-2 shadow-sm disabled:opacity-60"
                  style={{ backgroundColor: "var(--accent-solid)" }}
                >
                  {submitting && (
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  )}
                  <span>完成初始化并签发管理员会话</span>
                </button>
              </form>
            )}

            {/* Mode 3: Cloudflare Zero Trust SSO */}
            {mode === "cf-sso" && (
              <div className="space-y-4 text-xs">
                <div className="rounded-xl border border-sky-500/35 bg-sky-500/10 p-4 space-y-2">
                  <div className="flex items-start gap-2.5 text-sky-900 dark:text-sky-200">
                    <ShieldCheck
                      className="w-4 h-4 text-sky-600 dark:text-sky-400 shrink-0 mt-0.5"
                      aria-hidden="true"
                    />
                    <span className="leading-relaxed">
                      本实例已启用 Cloudflare Access 零信任身份网关。边缘 Worker 将校验{" "}
                      <code className="font-mono-num px-1 py-0.2 rounded bg-sky-500/15">
                        Cf-Access-Jwt-Assertion
                      </code>{" "}
                      签名并匹配管理员邮箱白名单。
                    </span>
                  </div>
                  <div className="pl-6 font-mono-num text-[11px] text-sky-800/85 dark:text-sky-300/85">
                    IdP: Google Workspace / GitHub · Certs: /cdn-cgi/access/certs
                  </div>
                </div>

                <div className="space-y-2.5">
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() =>
                      runSimulatedSubmit(() => ({
                        tone: "success",
                        title: "Cloudflare Access SSO 验证成功（演示态）",
                        detail:
                          "已通过 RS256 JWKS 公钥验签 · 身份：sre-lead@uniob.net（命中 ADMIN_EMAILS）。",
                      }))
                    }
                    className="w-full py-2.5 px-4 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold text-sm flex items-center justify-center gap-2 shadow-sm disabled:opacity-60"
                  >
                    {submitting ? (
                      <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <LogIn className="w-4 h-4" aria-hidden="true" />
                    )}
                    <span>使用 Cloudflare Access 账号登录</span>
                  </button>

                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() =>
                      runSimulatedSubmit(() => ({
                        tone: "info",
                        title: "已重新拉取边缘会话态",
                        detail:
                          "当前边缘节点命中 JWKS 缓存（TTL 3600s），等待浏览器携带 Access Cookie 跳转。",
                      }))
                    }
                    className="w-full py-2 px-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] hover:bg-[var(--bg-card-hover)] text-[var(--text-primary)] font-medium flex items-center justify-center gap-2"
                  >
                    <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>刷新 JWT 认证状态</span>
                  </button>
                </div>
              </div>
            )}

            {/* Mode 4: Access 403 Unauthorized Block */}
            {mode === "cf-403" && (
              <div className="space-y-4 text-xs">
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
                      当前 Cloudflare Access 身份{" "}
                      <code className="font-mono-num font-semibold px-1.5 py-0.5 rounded bg-rose-500/15">
                        guest.contractor@external.org
                      </code>{" "}
                      通过了 IdP 认证，但未列入面板{" "}
                      <code className="font-mono-num">ADMIN_EMAILS</code>{" "}
                      管理员白名单。
                    </p>
                  </div>
                </div>

                <div className="space-y-2.5">
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() =>
                      runSimulatedSubmit(() => ({
                        tone: "info",
                        title: "已触发 /cdn-cgi/access/logout 注销流程（演示态）",
                        detail:
                          "Zero Trust 会话令牌已清除，用户可重新选择授权运维邮箱登录。",
                      }))
                    }
                    className="w-full py-2.5 px-4 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-semibold text-sm flex items-center justify-center gap-2 shadow-sm disabled:opacity-60"
                  >
                    {submitting ? (
                      <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <LogOut className="w-4 h-4" aria-hidden="true" />
                    )}
                    <span>退出当前账号并切换授权邮箱</span>
                  </button>

                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() =>
                      runSimulatedSubmit(() => ({
                        tone: "danger",
                        title: "边缘策略复检仍为 403 Forbidden",
                        detail:
                          "请先在 Wrangler Secrets / 环境变量中将当前邮箱加入 ADMIN_EMAILS 后重试。",
                      }))
                    }
                    className="w-full py-2 px-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] hover:bg-[var(--bg-card-hover)] text-[var(--text-primary)] font-medium flex items-center justify-center gap-2"
                  >
                    <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>重新检测边缘访问权限</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </dialog>
  );
}
