import {
  AlertCircle,
  Check,
  CheckCircle2,
  ExternalLink,
  Loader2,
} from "lucide-react";
import type { SmartMigrateResponse } from "../types";

export type MigrationProgressStep =
  | "idle"
  | "connecting"
  | "polling"
  | "done"
  | "error";

interface MigrationProgressTrackerProps {
  step: MigrationProgressStep;
  error: string | null;
  result: SmartMigrateResponse | null;
  dispatchedCount: number;
  switchedEstimate: number;
  currentLiveConnected: number;
  pollElapsedSec: number;
  progressPct: number;
}

/** Displays the 3-step live server migration progress and target panel shortcut. */
export function MigrationProgressTracker({
  step,
  error,
  result,
  dispatchedCount,
  switchedEstimate,
  currentLiveConnected,
  pollElapsedSec,
  progressPct,
}: MigrationProgressTrackerProps) {
  if (step === "idle") return null;

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-100">
          搬家进度
        </h3>
        <span className="text-[11px] text-slate-500 dark:text-slate-400">
          过程不断线，若新面板异常 1 分钟内自动切回
        </span>
      </div>

      <ol className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <li
          className={`rounded-lg border p-3 text-xs ${
            step === "error"
              ? "border-rose-500/40 bg-rose-500/5 text-rose-700 dark:text-rose-300"
              : step === "connecting"
                ? "border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "border-emerald-500/30 bg-emerald-500/5 text-slate-700 dark:text-slate-200"
          }`}
        >
          <div className="flex items-center gap-1.5 font-medium">
            {step === "connecting" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : step === "error" ? (
              <AlertCircle
                className="h-3.5 w-3.5 text-rose-500"
                aria-hidden="true"
              />
            ) : (
              <Check className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
            )}
            <span>1. 连接并检查新面板</span>
          </div>
          {step === "error" && error && (
            <p className="mt-1 text-[11px] opacity-90">{error}</p>
          )}
        </li>

        <li
          className={`rounded-lg border p-3 text-xs ${
            result
              ? "border-emerald-500/30 bg-emerald-500/5 text-slate-700 dark:text-slate-200"
              : "border-slate-200 bg-slate-50/70 text-slate-500 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-400"
          }`}
        >
          <div className="flex items-center gap-1.5 font-medium">
            {result ? (
              <Check className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
            ) : (
              <span
                className="inline-block h-3.5 w-3.5 rounded-full border border-current opacity-40"
                aria-hidden="true"
              />
            )}
            <span>2. 同步配置与流量统计</span>
          </div>
          {result && (
            <p className="mt-1 text-[11px] text-slate-600 dark:text-slate-300">
              已同步 {result.synced.nodes} 台服务器、
              {result.synced.channels} 个通知渠道、
              {result.synced.rules} 条告警规则、
              {result.synced.traffic_ledgers} 条月度流量统计
            </p>
          )}
        </li>

        <li
          className={`rounded-lg border p-3 text-xs ${
            step === "done"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
              : step === "polling"
                ? "border-sky-500/40 bg-sky-500/10 text-sky-800 dark:text-sky-200"
                : "border-slate-200 bg-slate-50/70 text-slate-500 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-400"
          }`}
        >
          <div className="flex items-center gap-1.5 font-medium">
            {step === "polling" ? (
              <Loader2
                className="h-3.5 w-3.5 animate-spin text-sky-500"
                aria-hidden="true"
              />
            ) : step === "done" ? (
              <CheckCircle2
                className="h-3.5 w-3.5 text-emerald-500"
                aria-hidden="true"
              />
            ) : (
              <span
                className="inline-block h-3.5 w-3.5 rounded-full border border-current opacity-40"
                aria-hidden="true"
              />
            )}
            <span>3. 平滑切换服务器连接</span>
          </div>
          {result && (
            <p className="mt-1 text-[11px]">
              {dispatchedCount === 0
                ? "当前无在线服务器需要热切换，配置已就绪"
                : step === "done"
                  ? `已完成 ${dispatchedCount} 台服务器切换（本面板当前剩余 ${currentLiveConnected} 台）`
                  : `已切走 ${switchedEstimate} / ${dispatchedCount} 台（已等待 ${pollElapsedSec} 秒）`}
            </p>
          )}
        </li>
      </ol>

      {result && (
        <div className="space-y-2.5 pt-1">
          {dispatchedCount > 0 && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <span className="text-xs text-slate-600 dark:text-slate-300">
              全部同步完毕，点击右侧按钮前往新面板查看服务器状态。
            </span>
            <a
              href={result.target_origin}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-emerald-500"
            >
              打开新面板
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
