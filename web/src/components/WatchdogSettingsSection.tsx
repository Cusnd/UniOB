import { useId, useState } from "react";
import { Loader2, ShieldAlert, Wand2 } from "lucide-react";
import type { NotificationChannel, WatchdogConfig } from "../types";
import { api } from "../api/client";
import { formatDurationZh } from "../utils/format";
import { CopyButton } from "./CopyButton";

const WATCHDOG_TIMEOUT_PRESETS = [
  { sec: 600, label: "10 分钟" },
  { sec: 900, label: "15 分钟（推荐）" },
  { sec: 1800, label: "30 分钟" },
] as const;

function shellArg(val: string): string {
  if (/^[A-Za-z0-9_.:/@-]+$/.test(val)) return val;
  return `'${val.replace(/'/g, `'\\''`)}'`;
}

function generateHexSecret(byteLen = 24): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

interface WatchdogSettingsSectionProps {
  config: WatchdogConfig;
  channels: NotificationChannel[];
  badge: { label: string; tone: string };
  onChangeConfig: (
    updater: WatchdogConfig | ((prev: WatchdogConfig) => WatchdogConfig)
  ) => void;
  onError: (msg: string | null) => void;
  onReloadStatus: () => Promise<void>;
}

/** Cloudflare-only settings card for monitoring a self-hosted hub's heartbeat. */
export function WatchdogSettingsSection({
  config,
  channels,
  badge,
  onChangeConfig,
  onError,
  onReloadStatus,
}: WatchdogSettingsSectionProps) {
  const baseId = useId();
  const wdEnabledId = `${baseId}-enabled`;
  const wdLabelId = `${baseId}-label`;
  const wdSecretId = `${baseId}-secret`;

  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const watchdogPingUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/watchdog/ping`
      : "/api/watchdog/ping";
  const manualWatchdogFlags = `--watchdog-url ${shellArg(watchdogPingUrl)} --watchdog-secret ${shellArg(
    config.secret || "<自动生成或填写密钥>"
  )}`;

  const handleToggleChannel = (channelId: string) => {
    setNotice(null);
    onChangeConfig((prev) => {
      const current = prev.channel_ids ?? [];
      const exists = current.includes(channelId);
      return {
        ...prev,
        channel_ids: exists
          ? current.filter((id) => id !== channelId)
          : [...current, channelId],
      };
    });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const secret =
      (config.secret ?? "").trim() ||
      (config.enabled ? generateHexSecret(24) : "");
    setSaving(true);
    onError(null);
    setNotice(null);
    try {
      const updated = await api.updateWatchdogConfig({
        enabled: Boolean(config.enabled),
        secret,
        timeout_sec: Math.max(60, Math.round(config.timeout_sec || 900)),
        cooldown_sec: Math.max(60, Math.round(config.cooldown_sec || 1800)),
        hub_label: (config.hub_label ?? "").trim() || "自建备用面板",
        channel_ids: config.channel_ids ?? [],
      });
      onChangeConfig(updated);
      setNotice("掉线提醒设置已保存");
      await onReloadStatus();
    } catch (err) {
      onError(err instanceof Error ? err.message : "保存掉线提醒设置失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/40 p-4 dark:border-slate-800 dark:bg-slate-950/20">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
            <ShieldAlert className="h-4 w-4 text-amber-500" aria-hidden="true" />
            自建面板掉线提醒
          </h3>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            搬家到自建服务器后，保留 Cloudflare 云端自动值守；若自建服务器失联超过设定时间，立即发送告警通知。
          </p>
        </div>
        <span
          className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${badge.tone}`}
        >
          {badge.label}
        </span>
      </div>

      <form onSubmit={(e) => void handleSave(e)} className="space-y-3.5">
        <label
          htmlFor={wdEnabledId}
          className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-800 dark:text-slate-100"
        >
          <input
            id={wdEnabledId}
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => {
              setNotice(null);
              onChangeConfig((prev) => ({
                ...prev,
                enabled: e.target.checked,
                secret:
                  prev.secret || (e.target.checked ? generateHexSecret(24) : ""),
              }));
            }}
            className="h-4 w-4 rounded accent-emerald-600"
          />
          <span>开启自建面板掉线提醒</span>
        </label>

        <fieldset className="space-y-1.5">
          <legend className="text-xs font-medium text-slate-700 dark:text-slate-200">
            失联判定时间
          </legend>
          <div className="flex flex-wrap gap-2">
            {WATCHDOG_TIMEOUT_PRESETS.map((preset) => (
              <label
                key={preset.sec}
                className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition ${
                  config.timeout_sec === preset.sec
                    ? "border-emerald-500 bg-emerald-500/10 font-medium text-emerald-700 dark:text-emerald-300"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
                }`}
              >
                <input
                  type="radio"
                  name="wd-timeout-preset"
                  value={preset.sec}
                  checked={config.timeout_sec === preset.sec}
                  onChange={() => {
                    setNotice(null);
                    onChangeConfig((prev) => ({
                      ...prev,
                      timeout_sec: preset.sec,
                    }));
                  }}
                  className="h-3.5 w-3.5 accent-emerald-600"
                />
                <span>{preset.label}</span>
              </label>
            ))}
          </div>
          {!WATCHDOG_TIMEOUT_PRESETS.some((p) => p.sec === config.timeout_sec) && (
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              当前设置：{formatDurationZh(config.timeout_sec)}
            </p>
          )}
        </fieldset>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label
              htmlFor={wdLabelId}
              className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-200"
            >
              自建面板名称（通知里展示）
            </label>
            <input
              id={wdLabelId}
              type="text"
              value={config.hub_label}
              onChange={(e) => {
                setNotice(null);
                onChangeConfig((prev) => ({
                  ...prev,
                  hub_label: e.target.value,
                }));
              }}
              placeholder="例如：新加坡自建面板"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
          </div>

          <div>
            <span className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-200">
              接收通知渠道（不勾默认发往全部已启用渠道）
            </span>
            {channels.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                暂未配置通知渠道，可先到「告警通知」添加。
              </p>
            ) : (
              <div className="flex flex-wrap gap-2 pt-0.5">
                {channels.map((ch) => {
                  const checked = (config.channel_ids ?? []).includes(ch.id);
                  return (
                    <label
                      key={ch.id}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => handleToggleChannel(ch.id)}
                        className="h-3.5 w-3.5 rounded accent-emerald-600"
                      />
                      <span>{ch.name}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-slate-800 disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
          >
            {saving && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            )}
            保存提醒设置
          </button>
          <span
            role="status"
            className="text-xs font-medium text-emerald-600 dark:text-emerald-400"
          >
            {notice ?? ""}
          </span>
        </div>

        <details className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs dark:border-slate-800 dark:bg-slate-900">
          <summary className="cursor-pointer font-medium text-slate-700 select-none dark:text-slate-200">
            手动安装参数（仅手工部署自建面板时需要）
          </summary>
          <div className="mt-3 space-y-2.5 border-t border-slate-100 pt-2.5 dark:border-slate-800">
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              通过上方「生成一键安装命令」部署时会自动带入以下参数，无需手工粘贴。
            </p>
            <div className="space-y-1">
              <span className="block text-[11px] font-medium text-slate-600 dark:text-slate-300">
                心跳上报地址
              </span>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50 px-2.5 py-1.5 dark:border-slate-700 dark:bg-slate-950">
                <code className="break-all font-mono text-[11px] text-slate-700 dark:text-slate-200">
                  {watchdogPingUrl}
                </code>
                <CopyButton
                  text={watchdogPingUrl}
                  label="复制"
                  ariaLabel="复制心跳上报地址"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label
                htmlFor={wdSecretId}
                className="block text-[11px] font-medium text-slate-600 dark:text-slate-300"
              >
                通信密钥
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  id={wdSecretId}
                  type="text"
                  value={config.secret}
                  onChange={(e) =>
                    onChangeConfig((prev) => ({
                      ...prev,
                      secret: e.target.value,
                    }))
                  }
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="点击生成或输入密钥"
                  className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2.5 py-1 font-mono text-[11px] text-slate-800 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
                />
                <button
                  type="button"
                  onClick={() =>
                    onChangeConfig((prev) => ({
                      ...prev,
                      secret: generateHexSecret(24),
                    }))
                  }
                  className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                >
                  <Wand2 className="h-3 w-3" aria-hidden="true" />
                  生成密钥
                </button>
                {config.secret && (
                  <CopyButton
                    text={config.secret}
                    label="复制"
                    ariaLabel="复制掉线提醒通信密钥"
                  />
                )}
              </div>
            </div>

            <div className="space-y-1">
              <span className="block text-[11px] font-medium text-slate-600 dark:text-slate-300">
                启动附加参数
              </span>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50 px-2.5 py-1.5 dark:border-slate-700 dark:bg-slate-950">
                <code className="break-all font-mono text-[11px] text-slate-700 dark:text-slate-200">
                  {manualWatchdogFlags}
                </code>
                <CopyButton
                  text={manualWatchdogFlags}
                  label="复制"
                  ariaLabel="复制启动附加参数"
                />
              </div>
            </div>
          </div>
        </details>
      </form>
    </section>
  );
}
