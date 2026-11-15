import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2 } from "lucide-react";
import { api } from "../api/client";
import { usePageVisible } from "../hooks/usePageVisible";
import type {
  NetworkNodeOverride,
  NetworkQualityConfig,
  NetworkQualityConfigResponse,
  NetworkQualityState,
  NetworkTarget,
} from "../types/network-quality";
import {
  clonePresetTargets,
  DEFAULT_INTERVAL_SEC,
  defaultNetworkConfig,
  editableNetworkConfig,
  getTargetColor,
  MAX_INTERVAL_SEC,
  MAX_NETWORK_TARGETS,
  MIN_INTERVAL_SEC,
  NETWORK_PRESET_LIST,
  nextAvailableTargetId,
  normalizeIntervalSec,
  validateNetworkConfig,
  type NetworkPresetKey,
} from "../utils/networkQuality";
import { Badge, Button, SegmentedControl, Switch } from "./ui/Primitives";

interface NetworkQualitySettingsProps {
  nodeId?: string;
  active?: boolean;
  state?: NetworkQualityState;
  onSaved?: (response: NetworkQualityConfigResponse) => void;
}

const inputBaseClass =
  "h-9 w-full min-w-0 rounded-[8px] border bg-[var(--bg-subtle)] px-2.5 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]";

function inputBorderClass(hasError?: string): string {
  return hasError
    ? `${inputBaseClass} border-[var(--status-danger)]`
    : `${inputBaseClass} border-[var(--border-subtle)]`;
}

let nextKeySeq = 1;
function makeRowKeys(count: number): string[] {
  return Array.from({ length: count }, () => `nq-row-${nextKeySeq++}`);
}

/** A standalone settings section, deliberately without a nested form. */
export function NetworkQualitySettings({
  nodeId,
  active = true,
  state,
  onSaved,
}: NetworkQualitySettingsProps): React.JSX.Element {
  const baseId = useId();
  const visible = usePageVisible();
  const [response, setResponse] = useState<NetworkQualityConfigResponse | null>(
    null,
  );
  const [config, setConfig] = useState<NetworkQualityConfig>(defaultNetworkConfig);
  const [rowKeys, setRowKeys] = useState<string[]>(() => makeRowKeys(3));
  const [mode, setMode] = useState<NetworkNodeOverride["mode"]>("inherit");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showValidation, setShowValidation] = useState(false);
  const [saved, setSaved] = useState(false);
  const [retry, setRetry] = useState(0);
  const loadedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!active || !visible) return;
    const key = `${nodeId ?? "global"}:${retry}`;
    if (loadedKey.current === key) return;
    const abort = new AbortController();
    setLoading(true);
    setLoadError(null);
    setSubmitError(null);
    setSaved(false);
    setShowValidation(false);
    const request = nodeId
      ? api.getNodeNetworkQualityConfig(nodeId, abort.signal)
      : api.getNetworkQualityConfig(abort.signal);
    void request
      .then((result) => {
        if (abort.signal.aborted) return;
        loadedKey.current = key;
        setResponse(result);
        const override = result.config as NetworkNodeOverride;
        const resolved = editableNetworkConfig(
          nodeId
            ? (override.config ?? result.effective_config)
            : (result.config as NetworkQualityConfig),
        );
        setMode(nodeId ? override.mode : "custom");
        setConfig(resolved);
        setRowKeys(makeRowKeys(resolved.targets.length));
      })
      .catch((err) => {
        if (!abort.signal.aborted) {
          setLoadError(
            err instanceof Error ? err.message : "加载 TCP 延迟探测配置失败",
          );
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [nodeId, active, visible, retry]);

  const showCustomEditor = !nodeId || mode === "custom";
  const validation = useMemo(() => validateNetworkConfig(config), [config]);

  const editConfig = (next: NetworkQualityConfig) => {
    setConfig(next);
    setSaved(false);
    setSubmitError(null);
  };

  const updateTarget = (index: number, patch: Partial<NetworkTarget>) => {
    editConfig({
      ...config,
      targets: config.targets.map((t, i) => (i === index ? { ...t, ...patch } : t)),
    });
  };

  const applyPreset = (presetKey: NetworkPresetKey) => {
    const nextTargets = clonePresetTargets(presetKey);
    setRowKeys(makeRowKeys(nextTargets.length));
    editConfig({
      ...config,
      targets: nextTargets,
    });
    setShowValidation(false);
  };

  const addTarget = () => {
    if (config.targets.length >= MAX_NETWORK_TARGETS) return;
    const id = nextAvailableTargetId(config.targets);
    const newTarget: NetworkTarget = {
      id,
      enabled: true,
      label: `节点 ${config.targets.length + 1}`,
      region: "",
      host: "",
      port: 443,
      address_family: "ipv4",
    };
    setRowKeys((prev) => [...prev, `nq-row-${nextKeySeq++}`]);
    editConfig({
      ...config,
      targets: [...config.targets, newTarget],
    });
  };

  const removeTarget = (index: number) => {
    if (config.targets.length <= 1) return;
    setRowKeys((prev) => prev.filter((_, i) => i !== index));
    editConfig({
      ...config,
      targets: config.targets.filter((_, i) => i !== index),
    });
  };

  const moveTarget = (index: number, delta: -1 | 1) => {
    const nextIdx = index + delta;
    if (nextIdx < 0 || nextIdx >= config.targets.length) return;
    const nextTargets = [...config.targets];
    const nextKeys = [...rowKeys];
    const [movedTarget] = nextTargets.splice(index, 1);
    const [movedKey] = nextKeys.splice(index, 1);
    nextTargets.splice(nextIdx, 0, movedTarget!);
    nextKeys.splice(nextIdx, 0, movedKey!);
    setRowKeys(nextKeys);
    editConfig({
      ...config,
      targets: nextTargets,
    });
  };

  const save = async () => {
    if (saving || loading) return;
    if (showCustomEditor) {
      setShowValidation(true);
      if (!validation.valid) {
        setSubmitError(validation.firstError ?? "请修正标红的配置项后再保存");
        return;
      }
    }
    const payload = editableNetworkConfig(config);
    setSubmitError(null);
    setSaved(false);
    setSaving(true);
    try {
      const result = nodeId
        ? await api.updateNodeNetworkQualityConfig(
            nodeId,
            mode === "custom" ? { mode, config: payload } : { mode },
          )
        : await api.updateNetworkQualityConfig(payload);
      setResponse(result);
      const nextCfg = editableNetworkConfig(
        nodeId && mode !== "custom" ? result.effective_config : payload,
      );
      setConfig(nextCfg);
      setRowKeys(makeRowKeys(nextCfg.targets.length));
      setShowValidation(false);
      setSaved(true);
      onSaved?.(result);
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "保存 TCP 延迟探测配置失败",
      );
    } finally {
      setSaving(false);
    }
  };

  const applied = state?.applied_config_id ?? response?.applied_config_id;
  const applyLabel = !nodeId
    ? null
    : response?.supported === false
      ? "探针不支持"
      : response && applied === response.config_id
        ? "已生效"
        : "等待配置生效";

  return (
    <section aria-labelledby={`${baseId}-title`} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${baseId}-title`} className="text-[13.5px] font-semibold">
          {nodeId ? "TCP 延迟探测" : "全局 TCP 延迟探测"}
        </h3>
        <div className="flex items-center gap-2">
          {applyLabel && response && (
            <Badge tone={applied === response.config_id ? "ok" : "subtle"}>
              {applyLabel}
            </Badge>
          )}
          <Badge tone="subtle">TCP · IPv4 · {config.targets.length}/8 目标</Badge>
        </div>
      </div>

      {loading ? (
        <div
          role="status"
          className="flex items-center gap-2 py-5 text-[12px] text-[var(--text-secondary)]"
        >
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
          加载配置…
        </div>
      ) : (
        response && (
          <fieldset
            disabled={saving}
            className="min-w-0 space-y-4 disabled:opacity-65"
          >
            {nodeId && (
              <SegmentedControl<NetworkNodeOverride["mode"]>
                ariaLabel="节点探测模式"
                value={mode}
                onChange={(value) => {
                  setMode(value);
                  setSaved(false);
                  setSubmitError(null);
                }}
                options={[
                  { value: "inherit", label: "跟随全局" },
                  { value: "custom", label: "自定义" },
                  { value: "off", label: "关闭" },
                ]}
              />
            )}

            {showCustomEditor && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--border-hairline)] pb-3">
                  <div className="flex items-center gap-3 text-[12.5px]">
                    <span className="font-medium">启用探测</span>
                    <Switch
                      checked={config.enabled}
                      ariaLabel="启用 TCP 延迟探测"
                      onChange={(enabled) => editConfig({ ...config, enabled })}
                    />
                  </div>

                  <div className="flex flex-col items-end gap-1">
                    <div className="flex items-center gap-2">
                      <label
                        htmlFor={`${baseId}-interval`}
                        className="text-[12px] text-[var(--text-secondary)]"
                      >
                        采样间隔（秒）
                      </label>
                      <input
                        id={`${baseId}-interval`}
                        type="number"
                        min={MIN_INTERVAL_SEC}
                        max={MAX_INTERVAL_SEC}
                        value={
                          config.interval_sec === undefined ||
                          Number.isNaN(config.interval_sec)
                            ? ""
                            : config.interval_sec
                        }
                        aria-invalid={
                          showValidation && Boolean(validation.intervalError)
                        }
                        aria-describedby={
                          showValidation && validation.intervalError
                            ? `${baseId}-interval-err`
                            : undefined
                        }
                        onChange={(e) => {
                          const raw = e.target.value;
                          editConfig({
                            ...config,
                            interval_sec:
                              raw === ""
                                ? NaN
                                : Math.trunc(Number(raw)),
                          });
                        }}
                        onBlur={() => {
                          if (
                            config.interval_sec === undefined ||
                            Number.isNaN(config.interval_sec)
                          ) {
                            editConfig({
                              ...config,
                              interval_sec: DEFAULT_INTERVAL_SEC,
                            });
                          }
                        }}
                        style={{ width: 82 }}
                        className={`${inputBorderClass(
                          showValidation ? validation.intervalError : undefined,
                        )} font-mono-num text-right`}
                      />
                    </div>
                    {showValidation && validation.intervalError && (
                      <p
                        id={`${baseId}-interval-err`}
                        role="alert"
                        className="text-[11px] text-[var(--status-danger-ink)]"
                      >
                        {validation.intervalError}
                      </p>
                    )}
                  </div>
                </div>

                {/* 1-click Presets */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11.5px] text-[var(--text-tertiary)]">
                    快捷预设（支持 1~8 个目标，可添加、移除、排序）
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {NETWORK_PRESET_LIST.map((preset) => (
                      <Button
                        key={preset.key}
                        size="xs"
                        variant="secondary"
                        onClick={() => applyPreset(preset.key)}
                      >
                        {preset.label}
                      </Button>
                    ))}
                  </div>
                </div>

                {showValidation && validation.formError && (
                  <p
                    role="alert"
                    className="text-[12px] text-[var(--status-danger-ink)]"
                  >
                    {validation.formError}
                  </p>
                )}

                {/* Dynamic Targets List without nested card boxes */}
                <div className="divide-y divide-[var(--border-hairline)] border-t border-b border-[var(--border-hairline)]">
                  {config.targets.map((target, index) => {
                    const rowKey = rowKeys[index] ?? `row-${index}`;
                    const errs = showValidation
                      ? (validation.targetErrors[index] ?? {})
                      : {};
                    const color = getTargetColor(target.id, index);
                    const titleText =
                      target.label.trim() || target.id.trim() || `目标 ${index + 1}`;

                    return (
                      <fieldset key={rowKey} className="min-w-0 py-3.5">
                        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                          <legend className="flex items-center gap-2 text-[12.5px] font-medium">
                            <span
                              aria-hidden="true"
                              className="inline-block h-2 w-2 shrink-0 rounded-full"
                              style={{ backgroundColor: color }}
                            />
                            <span>{titleText}</span>
                            {target.id.trim() && (
                              <span className="font-mono-num text-[11px] font-normal text-[var(--text-tertiary)]">
                                {target.id.trim()}
                              </span>
                            )}
                          </legend>

                          <div className="flex items-center gap-2">
                            <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                              <span>启用</span>
                              <Switch
                                checked={target.enabled}
                                ariaLabel={`启用 ${titleText} 目标`}
                                onChange={(enabled) =>
                                  updateTarget(index, { enabled })
                                }
                              />
                            </div>
                            <button
                              type="button"
                              aria-label={`上移 ${titleText}`}
                              disabled={index === 0}
                              onClick={() => moveTarget(index, -1)}
                              className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-35"
                            >
                              <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              aria-label={`下移 ${titleText}`}
                              disabled={index === config.targets.length - 1}
                              onClick={() => moveTarget(index, 1)}
                              className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-35"
                            >
                              <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              aria-label={`移除 ${titleText}`}
                              disabled={config.targets.length <= 1}
                              onClick={() => removeTarget(index)}
                              className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--status-danger-ink)] disabled:cursor-not-allowed disabled:opacity-35"
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-12">
                          <div className="space-y-1 sm:col-span-3">
                            <label
                              htmlFor={`${rowKey}-label`}
                              className="block text-[11px] text-[var(--text-secondary)]"
                            >
                              名称
                            </label>
                            <input
                              id={`${rowKey}-label`}
                              type="text"
                              maxLength={32}
                              autoComplete="off"
                              spellCheck={false}
                              value={target.label}
                              placeholder="例如 电信 / 香港"
                              aria-invalid={Boolean(errs.label)}
                              aria-describedby={
                                errs.label ? `${rowKey}-label-err` : undefined
                              }
                              onChange={(e) =>
                                updateTarget(index, { label: e.target.value })
                              }
                              className={inputBorderClass(errs.label)}
                            />
                            {errs.label && (
                              <p
                                id={`${rowKey}-label-err`}
                                role="alert"
                                className="text-[11px] text-[var(--status-danger-ink)]"
                              >
                                {errs.label}
                              </p>
                            )}
                          </div>

                          <div className="space-y-1 sm:col-span-2">
                            <label
                              htmlFor={`${rowKey}-id`}
                              className="block text-[11px] text-[var(--text-secondary)]"
                            >
                              标识 ID
                            </label>
                            <input
                              id={`${rowKey}-id`}
                              type="text"
                              maxLength={24}
                              autoComplete="off"
                              spellCheck={false}
                              value={target.id}
                              placeholder="hk / ct"
                              aria-invalid={Boolean(errs.id)}
                              aria-describedby={
                                errs.id ? `${rowKey}-id-err` : undefined
                              }
                              onChange={(e) =>
                                updateTarget(index, {
                                  id: e.target.value.toLowerCase(),
                                })
                              }
                              className={`${inputBorderClass(errs.id)} font-mono-num`}
                            />
                            {errs.id && (
                              <p
                                id={`${rowKey}-id-err`}
                                role="alert"
                                className="text-[11px] text-[var(--status-danger-ink)]"
                              >
                                {errs.id}
                              </p>
                            )}
                          </div>

                          <div className="space-y-1 sm:col-span-2">
                            <label
                              htmlFor={`${rowKey}-region`}
                              className="block text-[11px] text-[var(--text-secondary)]"
                            >
                              地区（可选）
                            </label>
                            <input
                              id={`${rowKey}-region`}
                              type="text"
                              maxLength={64}
                              autoComplete="off"
                              spellCheck={false}
                              value={target.region ?? ""}
                              placeholder="广东 / 香港"
                              aria-invalid={Boolean(errs.region)}
                              aria-describedby={
                                errs.region ? `${rowKey}-region-err` : undefined
                              }
                              onChange={(e) =>
                                updateTarget(index, { region: e.target.value })
                              }
                              className={inputBorderClass(errs.region)}
                            />
                            {errs.region && (
                              <p
                                id={`${rowKey}-region-err`}
                                role="alert"
                                className="text-[11px] text-[var(--status-danger-ink)]"
                              >
                                {errs.region}
                              </p>
                            )}
                          </div>

                          <div className="space-y-1 sm:col-span-3">
                            <label
                              htmlFor={`${rowKey}-host`}
                              className="block text-[11px] text-[var(--text-secondary)]"
                            >
                              主机 / IPv4
                            </label>
                            <input
                              id={`${rowKey}-host`}
                              type="text"
                              maxLength={253}
                              autoComplete="off"
                              spellCheck={false}
                              value={target.host}
                              placeholder="example.com 或公网 IP"
                              aria-invalid={Boolean(errs.host)}
                              aria-describedby={
                                errs.host ? `${rowKey}-host-err` : undefined
                              }
                              onChange={(e) =>
                                updateTarget(index, { host: e.target.value })
                              }
                              className={`${inputBorderClass(errs.host)} font-mono-num`}
                            />
                            {errs.host && (
                              <p
                                id={`${rowKey}-host-err`}
                                role="alert"
                                className="text-[11px] text-[var(--status-danger-ink)]"
                              >
                                {errs.host}
                              </p>
                            )}
                          </div>

                          <div className="space-y-1 sm:col-span-2">
                            <label
                              htmlFor={`${rowKey}-port`}
                              className="block text-[11px] text-[var(--text-secondary)]"
                            >
                              端口
                            </label>
                            <input
                              id={`${rowKey}-port`}
                              type="number"
                              min={1}
                              max={65535}
                              value={Number.isNaN(target.port) ? "" : target.port}
                              aria-invalid={Boolean(errs.port)}
                              aria-describedby={
                                errs.port ? `${rowKey}-port-err` : undefined
                              }
                              onChange={(e) =>
                                updateTarget(index, {
                                  port:
                                    e.target.value === ""
                                      ? NaN
                                      : Math.trunc(Number(e.target.value)),
                                })
                              }
                              className={`${inputBorderClass(errs.port)} font-mono-num`}
                            />
                            {errs.port && (
                              <p
                                id={`${rowKey}-port-err`}
                                role="alert"
                                className="text-[11px] text-[var(--status-danger-ink)]"
                              >
                                {errs.port}
                              </p>
                            )}
                          </div>
                        </div>
                      </fieldset>
                    );
                  })}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={config.targets.length >= MAX_NETWORK_TARGETS}
                    onClick={addTarget}
                    icon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
                  >
                    添加目标 ({config.targets.length}/{MAX_NETWORK_TARGETS})
                  </Button>
                  <span className="text-[11px] text-[var(--text-tertiary)]">
                    当前每 {normalizeIntervalSec(config.interval_sec)} 秒探测一轮
                  </span>
                </div>
              </>
            )}

            {nodeId &&
              mode === "inherit" &&
              (response.config as NetworkNodeOverride).mode === "inherit" && (
                <p className="text-[12px] text-[var(--text-secondary)]">
                  全局配置：
                  {response.effective_config.enabled
                    ? `已启用（${response.effective_config.targets.filter((t) => t.enabled).length} 个目标，每 ${normalizeIntervalSec(response.effective_config.interval_sec)} 秒）`
                    : "未启用"}
                </p>
              )}

            {nodeId && mode === "off" && (
              <p className="text-[12px] text-[var(--text-secondary)]">
                已对该节点关闭 TCP 延迟探测
              </p>
            )}

            <div className="flex flex-wrap items-center justify-end gap-3 pt-1">
              {saved && (
                <span
                  role="status"
                  className="text-[12px] text-[var(--status-ok-ink)]"
                >
                  已保存
                </span>
              )}
              <Button
                size="sm"
                variant="primary"
                onClick={() => void save()}
                disabled={saving}
                icon={
                  saving ? (
                    <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                  ) : undefined
                }
              >
                {saving ? "保存中…" : "保存网络设置"}
              </Button>
            </div>
          </fieldset>
        )
      )}

      {(loadError || submitError) && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 text-[12px] text-[var(--status-danger-ink)]"
        >
          <span>{submitError ?? loadError}</span>
          {loadError && !response && (
            <Button size="xs" onClick={() => setRetry((n) => n + 1)}>
              重试
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
