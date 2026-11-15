import React, { useEffect, useId, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "../api/client";
import { usePageVisible } from "../hooks/usePageVisible";
import type {
  NetworkNodeOverride, NetworkQualityConfig, NetworkQualityConfigResponse, NetworkQualityState,
} from "../types/network-quality";
import { defaultNetworkConfig, editableNetworkConfig } from "../utils/networkQuality";
import { Badge, Button, SegmentedControl, Switch } from "./ui/Primitives";

interface NetworkQualitySettingsProps {
  nodeId?: string;
  active?: boolean;
  state?: NetworkQualityState;
  onSaved?: (response: NetworkQualityConfigResponse) => void;
}

const inputClass = "h-9 w-full min-w-0 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-2.5 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]";

function validate(config: NetworkQualityConfig): string | null {
  for (const target of config.targets) {
    if (!target.label.trim() || !target.region.trim()) return "请填写每个目标的名称与地区";
    if (target.label.trim().length > 64 || target.region.trim().length > 64) return "名称与地区最多 64 个字符";
    if (!target.host.trim() || target.host.trim().length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(target.host.trim())) {
      return `${target.label || target.id}：请输入域名或公网 IPv4 地址，不要包含协议、路径或端口`;
    }
    if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) return `${target.label || target.id}：端口须为 1–65535 的整数`;
  }
  return null;
}

/** A standalone settings section, deliberately without a nested form. */
export function NetworkQualitySettings({ nodeId, active = true, state, onSaved }: NetworkQualitySettingsProps): React.JSX.Element {
  const baseId = useId();
  const visible = usePageVisible();
  const [response, setResponse] = useState<NetworkQualityConfigResponse | null>(null);
  const [config, setConfig] = useState<NetworkQualityConfig>(defaultNetworkConfig);
  const [mode, setMode] = useState<NetworkNodeOverride["mode"]>("inherit");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [retry, setRetry] = useState(0);
  const loadedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!active || !visible) return;
    const key = `${nodeId ?? "global"}:${retry}`;
    if (loadedKey.current === key) return;
    const abort = new AbortController();
    setLoading(true);
    setError(null);
    setSaved(false);
    const request = nodeId ? api.getNodeNetworkQualityConfig(nodeId, abort.signal) : api.getNetworkQualityConfig(abort.signal);
    void request.then(result => {
      if (abort.signal.aborted) return;
      loadedKey.current = key;
      setResponse(result);
      const override = result.config as NetworkNodeOverride;
      setMode(nodeId ? override.mode : "custom");
      setConfig(editableNetworkConfig(nodeId ? override.config ?? result.effective_config : result.config as NetworkQualityConfig));
    }).catch(err => {
      if (!abort.signal.aborted) setError(err instanceof Error ? err.message : "加载网络检测配置失败");
    }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [nodeId, active, visible, retry]);

  const save = async () => {
    if (saving || loading) return;
    const payload = editableNetworkConfig(config);
    payload.targets = payload.targets.map(t => ({ ...t, label: t.label.trim(), region: t.region.trim(), host: t.host.trim().toLowerCase() }));
    const validation = (!nodeId || mode === "custom") ? validate(payload) : null;
    if (validation) { setError(validation); return; }
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const result = nodeId
        ? await api.updateNodeNetworkQualityConfig(nodeId, mode === "custom" ? { mode, config: payload } : { mode })
        : await api.updateNetworkQualityConfig(payload);
      setResponse(result);
      setConfig(editableNetworkConfig(nodeId && mode !== "custom" ? result.effective_config : payload));
      setSaved(true);
      onSaved?.(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存网络检测配置失败");
    } finally { setSaving(false); }
  };

  const applied = state?.applied_config_id ?? response?.applied_config_id;
  const applyLabel = !nodeId ? null : response?.supported === false ? "探针不支持"
    : response && applied === response.config_id ? "已生效" : "等待配置生效";
  const edit = (change: NetworkQualityConfig) => { setConfig(change); setSaved(false); };
  return (
    <section aria-labelledby={`${baseId}-title`} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${baseId}-title`} className="text-[13px] font-semibold">{nodeId ? "网络检测" : "全局网络检测"}</h3>
        <div className="flex items-center gap-2">
          {applyLabel && response && <Badge tone={applied === response.config_id ? "ok" : "subtle"}>{applyLabel}</Badge>}
          <Badge tone="subtle">TCP · IPv4</Badge>
        </div>
      </div>
      {loading ? <div role="status" className="flex items-center gap-2 py-5 text-[12px] text-[var(--text-secondary)]"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />加载配置…</div> : response && (
        <fieldset disabled={saving} className="min-w-0 space-y-3 disabled:opacity-65">
          {nodeId && <SegmentedControl<NetworkNodeOverride["mode"]> ariaLabel="节点网络检测配置" value={mode}
            onChange={value => { setMode(value); setSaved(false); }}
            options={[{ value: "inherit", label: "继承全局" }, { value: "custom", label: "自定义" }, { value: "off", label: "关闭" }]} />}
          {(!nodeId || mode === "custom") && <>
            <div className="flex items-center justify-between gap-3 text-[12px]">
              <span>启用网络检测</span>
              <Switch checked={config.enabled} ariaLabel="启用网络检测" onChange={enabled => edit({ ...config, enabled })} />
            </div>
            <div className="space-y-3">
              {config.targets.map((target, index) => (
                <fieldset key={target.id} className="min-w-0 rounded-[9px] border border-[var(--border-hairline)] p-3">
                  <legend className="px-1 text-[12px] font-medium">{["电信", "联通", "移动"][index]}</legend>
                  <div className="mb-2 flex items-center justify-between text-[11px] text-[var(--text-secondary)]">
                    <span>启用目标</span>
                    <Switch checked={target.enabled} ariaLabel={`启用${target.label}目标`} onChange={enabled => edit({ ...config, targets: config.targets.map(t => t.id === target.id ? { ...t, enabled } : t) })} />
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    {(["label", "region", "host", "port"] as const).map(field => (
                      <label key={field} className={`min-w-0 space-y-1 text-[11px] text-[var(--text-secondary)] ${field === "host" ? "col-span-2 sm:col-span-1" : ""}`}>
                        <span>{{ label: "名称", region: "地区", host: "地址", port: "端口" }[field]}</span>
                        <input className={inputClass} type={field === "port" ? "number" : "text"}
                          min={field === "port" ? 1 : undefined} max={field === "port" ? 65535 : undefined}
                          maxLength={field === "host" ? 253 : field === "port" ? undefined : 64}
                          autoComplete="off" spellCheck={false} value={Number.isNaN(target[field]) ? "" : target[field]}
                          onChange={e => edit({ ...config, targets: config.targets.map(t => t.id === target.id ? { ...t, [field]: field === "port" ? e.target.value === "" ? NaN : Number(e.target.value) : e.target.value } : t) })} />
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
            </div>
          </>}
          {nodeId && mode === "inherit" && (response.config as NetworkNodeOverride).mode === "inherit" && <p className="text-[12px] text-[var(--text-secondary)]">全局配置：{response.effective_config.enabled ? "已启用" : "未启用"}</p>}
          <div className="flex flex-wrap items-center justify-end gap-3">
            {saved && <span role="status" className="text-[12px] text-[var(--status-ok-ink)]">已保存</span>}
            <Button size="sm" variant="primary" onClick={() => void save()} disabled={saving}
              icon={saving ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : undefined}>{saving ? "保存中…" : "保存网络设置"}</Button>
          </div>
        </fieldset>
      )}
      {error && <div role="alert" className="flex items-center justify-between gap-2 text-[12px] text-[var(--status-danger-ink)]"><span>{error}</span>{!response && <Button size="xs" onClick={() => setRetry(n => n + 1)}>重试</Button>}</div>}
    </section>
  );
}
