import React, { useEffect, useId, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  KeyRound,
  Loader2,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import type { FleetNode, ServersProvisionViewProps } from "../types";
import {
  Badge,
  Button,
  Card,
  CopyButton,
  IconCloseButton,
  MetricBar,
  NativeDialog,
  SectionHeader,
  StatusDot,
} from "../components/ui/Primitives";

type GroupChip = "all" | "生产核心" | "亚太边缘" | "欧美枢纽" | "1G 小鸡";
type SortColumn = "name" | "group" | "net" | "cpu" | "mem" | "traffic";
type SortDirection = "ascending" | "descending";
type WizardStep = 1 | 2 | 3;

function formatRateKbps(kbps: number): string {
  if (!Number.isFinite(kbps) || kbps <= 0) return "0 KB/s";
  if (kbps >= 1024 * 1024) {
    return `${(kbps / (1024 * 1024)).toFixed(2)} GB/s`;
  }
  if (kbps >= 1024) {
    const mb = kbps / 1024;
    return `${mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)} MB/s`;
  }
  return `${Math.round(kbps)} KB/s`;
}

const GROUP_CHIPS: Array<{ id: GroupChip; label: string }> = [
  { id: "all", label: "全部" },
  { id: "生产核心", label: "生产" },
  { id: "亚太边缘", label: "亚太" },
  { id: "欧美枢纽", label: "欧美" },
  { id: "1G 小鸡", label: "轻量" },
];

const SHORT_GROUP_LABEL: Record<FleetNode["group"], string> = {
  生产核心: "生产",
  亚太边缘: "亚太",
  欧美枢纽: "欧美",
  "1G 小鸡": "轻量",
  中枢本机: "本机",
};

const REGION_OPTIONS = [
  { code: "NRT · 东京", short: "JP-NRT", flag: "JP" },
  { code: "HKG · 香港", short: "HK-HKG", flag: "HK" },
  { code: "SIN · 新加坡", short: "SG-SIN", flag: "SG" },
  { code: "FRA · 法兰克福", short: "DE-FRA", flag: "DE" },
  { code: "LAX · 洛杉矶", short: "US-LAX", flag: "US" },
] as const;

const SPEC_PRESETS = [
  { id: "1c1g", label: "1C · 1G", cores: 1, memMb: 1024 },
  { id: "2c2g", label: "2C · 2G", cores: 2, memMb: 2048 },
  { id: "4c8g", label: "4C · 8G", cores: 4, memMb: 8192 },
] as const;

const zhCollator = new Intl.Collator("zh-CN", { numeric: true });

export function ServersProvisionView(
  props: ServersProvisionViewProps,
): React.JSX.Element {
  const {
    nodes,
    provisionModalOpen,
    onCloseProvisionModal,
    onAddNode,
    onUpdateNodeWatermark,
    onInspectNode,
    onNotify,
  } = props;

  const tableCaptionId = useId();
  const provisionTitleId = useId();
  const thresholdTitleId = useId();
  const tokenTitleId = useId();

  // Filter & Sort state
  const [groupFilter, setGroupFilter] = useState<GroupChip>("all");
  const [query, setQuery] = useState("");
  const [sortCol, setSortCol] = useState<SortColumn>("name");
  const [sortDir, setSortDir] = useState<SortDirection>("ascending");
  const [sortAnnouncement, setSortAnnouncement] = useState("");

  // Local group/token overrides for instant UI feedback
  const [groupOverrides, setGroupOverrides] = useState<
    Record<string, FleetNode["group"]>
  >({});
  const [rotatedTokens, setRotatedTokens] = useState<Record<string, string>>(
    {},
  );

  // Simple Threshold Slider Modal state
  const [thresholdNode, setThresholdNode] = useState<FleetNode | null>(null);
  const [cpuLimit, setCpuLimit] = useState(90);
  const [memLimit, setMemLimit] = useState(90);
  const [diskLimit, setDiskLimit] = useState(85);

  // Simple Token Reset Modal state
  const [tokenNode, setTokenNode] = useState<FleetNode | null>(null);
  const [freshTokenValue, setFreshTokenValue] = useState<string | null>(null);

  // 3-Step Add Server Wizard state
  const [wizardStep, setWizardStep] = useState<WizardStep>(1);
  const [newServerName, setNewServerName] = useState("tokyo-edge-04");
  const [newServerRegionIdx, setNewServerRegionIdx] = useState(0);
  const [newServerGroup, setNewServerGroup] =
    useState<FleetNode["group"]>("亚太边缘");
  const [newServerSpecId, setNewServerSpecId] = useState<string>("2c2g");
  const [connectDone, setConnectDone] = useState(false);

  // Reset wizard when opened
  useEffect(() => {
    if (provisionModalOpen) {
      setWizardStep(1);
      setConnectDone(false);
    }
  }, [provisionModalOpen]);

  // Simulate connection arrival in Step 3
  useEffect(() => {
    if (!provisionModalOpen || wizardStep !== 3) return;
    setConnectDone(false);
    const id = window.setTimeout(() => {
      setConnectDone(true);
    }, 900);
    return () => window.clearTimeout(id);
  }, [provisionModalOpen, wizardStep]);

  const installCommand = useMemo(() => {
    const tokenPart = `tk_${Math.abs(newServerName.length * 7919 + 4129).toString(16)}`;
    return `curl -fsSL https://get.uniob.sh | sudo sh -s -- --token ${tokenPart}`;
  }, [newServerName]);

  const filteredAndSorted = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = nodes.filter((node) => {
      const effectiveGroup = groupOverrides[node.id] ?? node.group;
      if (groupFilter !== "all" && effectiveGroup !== groupFilter) return false;
      if (!q) return true;
      return (
        node.name.toLowerCase().includes(q) ||
        node.ipv4.toLowerCase().includes(q) ||
        node.regionCode.toLowerCase().includes(q)
      );
    });

    const mult = sortDir === "ascending" ? 1 : -1;
    return [...list].sort((a, b) => {
      const gA = groupOverrides[a.id] ?? a.group;
      const gB = groupOverrides[b.id] ?? b.group;
      switch (sortCol) {
        case "name":
          return zhCollator.compare(a.name, b.name) * mult;
        case "group":
          return zhCollator.compare(gA, gB) * mult;
        case "net": {
          const nA = a.online ? a.netRxKbps + a.netTxKbps : -1;
          const nB = b.online ? b.netRxKbps + b.netTxKbps : -1;
          return (nA - nB) * mult;
        }
        case "cpu":
          return (a.cpuPct - b.cpuPct) * mult;
        case "mem": {
          const mA = a.memUsedMb / Math.max(1, a.memTotalMb);
          const mB = b.memUsedMb / Math.max(1, b.memTotalMb);
          return (mA - mB) * mult;
        }
        case "traffic":
          return (a.monthlyTrafficUsedGb - b.monthlyTrafficUsedGb) * mult;
      }
    });
  }, [nodes, groupFilter, query, sortCol, sortDir, groupOverrides]);

  const handleSort = (col: SortColumn, label: string) => {
    const nextDir: SortDirection =
      sortCol === col && sortDir === "ascending" ? "descending" : "ascending";
    setSortCol(col);
    setSortDir(nextDir);
    setSortAnnouncement(
      `已按${label}${nextDir === "ascending" ? "升序" : "降序"}排列`,
    );
  };

  const openThresholdModal = (node: FleetNode) => {
    setThresholdNode(node);
    setCpuLimit(node.watermark.cpuTriggerPct);
    setMemLimit(node.watermark.memTriggerPct);
    setDiskLimit(node.watermark.diskTriggerPct);
  };

  const handleSaveThresholds = (e: React.FormEvent) => {
    e.preventDefault();
    if (!thresholdNode) return;
    onUpdateNodeWatermark(thresholdNode.id, {
      ...thresholdNode.watermark,
      cpuTriggerPct: cpuLimit,
      memTriggerPct: memLimit,
      diskTriggerPct: diskLimit,
    });
    setThresholdNode(null);
    onNotify?.(`已更新 ${thresholdNode.name} 告警阈值`, "success");
  };

  const handleConfirmRotateToken = () => {
    if (!tokenNode) return;
    const generated = `uob_live_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 8)}`;
    setFreshTokenValue(generated);
    setRotatedTokens((prev) => ({
      ...prev,
      [tokenNode.id]: `${generated.slice(0, 12)}...${generated.slice(-4)}`,
    }));
    onNotify?.(`已重置 ${tokenNode.name} 连接密钥`, "success");
  };

  const handleFinishProvision = () => {
    const template = nodes[0];
    if (!template) {
      onCloseProvisionModal();
      return;
    }
    const region =
      REGION_OPTIONS[newServerRegionIdx] ?? REGION_OPTIONS[0];
    const spec =
      SPEC_PRESETS.find((s) => s.id === newServerSpecId) ?? SPEC_PRESETS[1];
    const cleanName = newServerName.trim() || "new-server-01";

    const created: FleetNode = {
      ...template,
      id: `nd_${Date.now()}`,
      name: cleanName,
      hostname: cleanName,
      group: newServerGroup,
      tags: [SHORT_GROUP_LABEL[newServerGroup]],
      regionCode: region.code,
      regionShort: region.short,
      regionFlag: region.flag,
      ipv4: `103.84.${18 + (nodes.length % 70)}.${24 + (nodes.length * 7) % 200}`,
      cpuCores: spec.cores,
      memTotalMb: spec.memMb,
      memUsedMb: Math.round(spec.memMb * 0.28),
      swapTotalMb: 1024,
      swapUsedMb: 32,
      isTinyVps: spec.memMb <= 2048,
      isHubLocal: false,
      online: true,
      protocolState: "live_2s",
      frameIntervalLabel: "实时",
      uptimeDays: 1,
      lastSeenSecAgo: 1,
      cpuPct: 14.2,
      cpuStealPct: 0.2,
      load: [0.18, 0.14, 0.11],
      netRxKbps: 680,
      netTxKbps: 240,
      monthlyTrafficUsedGb: 1.4,
      monthlyTrafficLimitGb: 1000,
      activeAlertText: undefined,
    };

    onAddNode(created);
    onCloseProvisionModal();
    onNotify?.(`服务器 ${cleanName} 已成功添加并上线`, "success");
  };

  const onlineCount = nodes.filter((n) => n.online).length;

  return (
    <div className="space-y-5">
      <div role="status" aria-live="polite" className="sr-only">
        {sortAnnouncement}
      </div>

      {/* Clean Header (Topbar owns the global + 添加服务器 CTA) */}
      <SectionHeader
        title="服务器"
        badge={
          <Badge tone="neutral">
            在线 {onlineCount} / {nodes.length}
          </Badge>
        }
      />

      {/* Filter & Search Toolbar */}
      <search className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {GROUP_CHIPS.map((chip) => {
            const active = groupFilter === chip.id;
            return (
              <button
                key={chip.id}
                type="button"
                aria-pressed={active}
                onClick={() => setGroupFilter(chip.id)}
                style={
                  active
                    ? {
                        backgroundColor: "var(--ink-primary)",
                        color: "var(--ink-on-primary)",
                      }
                    : {
                        backgroundColor: "var(--bg-card)",
                        color: "var(--text-secondary)",
                        border: "1px solid var(--border-hairline)",
                      }
                }
                className="h-8 cursor-pointer rounded-[8px] px-3 text-[12.5px] font-medium transition-colors"
              >
                {chip.label}
              </button>
            );
          })}
        </div>

        <div className="relative w-full sm:w-64">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2"
            style={{ color: "var(--text-tertiary)" }}
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索名称、地域或 IP..."
            aria-label="搜索服务器"
            style={{
              backgroundColor: "var(--bg-card)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-subtle)",
            }}
            className="h-8 w-full rounded-[8px] pr-3 pl-8 text-[12.5px] outline-none"
          />
        </div>
      </search>

      {/* Clean Server Inventory Table */}
      <Card padded={false} className="overflow-hidden">
        <div
          tabIndex={0}
          role="region"
          aria-labelledby={tableCaptionId}
          className="table-scroll-region thin-scrollbar"
        >
          <table className="uniob-table">
            <caption id={tableCaptionId} className="sr-only">
              服务器列表
            </caption>
            <thead>
              <tr>
                <th
                  scope="col"
                  aria-sort={sortCol === "name" ? sortDir : undefined}
                >
                  <button
                    type="button"
                    onClick={() => handleSort("name", "名称")}
                  >
                    <span>服务器</span>
                    {sortCol === "name" ? (
                      sortDir === "ascending" ? (
                        <ArrowUp className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <ArrowDown className="h-3 w-3" aria-hidden="true" />
                      )
                    ) : (
                      <ArrowUpDown
                        className="h-3 w-3 opacity-40"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                </th>

                <th
                  scope="col"
                  aria-sort={sortCol === "group" ? sortDir : undefined}
                >
                  <button
                    type="button"
                    onClick={() => handleSort("group", "分组")}
                  >
                    <span>分组</span>
                    {sortCol === "group" ? (
                      sortDir === "ascending" ? (
                        <ArrowUp className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <ArrowDown className="h-3 w-3" aria-hidden="true" />
                      )
                    ) : (
                      <ArrowUpDown
                        className="h-3 w-3 opacity-40"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                </th>

                <th scope="col">IP / 规格</th>

                <th
                  scope="col"
                  aria-sort={sortCol === "net" ? sortDir : undefined}
                >
                  <button
                    type="button"
                    onClick={() => handleSort("net", "实时网速")}
                  >
                    <span>实时网速</span>
                    {sortCol === "net" ? (
                      sortDir === "ascending" ? (
                        <ArrowUp className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <ArrowDown className="h-3 w-3" aria-hidden="true" />
                      )
                    ) : (
                      <ArrowUpDown
                        className="h-3 w-3 opacity-40"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                </th>

                <th
                  scope="col"
                  aria-sort={sortCol === "cpu" ? sortDir : undefined}
                >
                  <button
                    type="button"
                    onClick={() => handleSort("cpu", "CPU")}
                  >
                    <span>CPU</span>
                    {sortCol === "cpu" ? (
                      sortDir === "ascending" ? (
                        <ArrowUp className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <ArrowDown className="h-3 w-3" aria-hidden="true" />
                      )
                    ) : (
                      <ArrowUpDown
                        className="h-3 w-3 opacity-40"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                </th>

                <th
                  scope="col"
                  aria-sort={sortCol === "mem" ? sortDir : undefined}
                >
                  <button
                    type="button"
                    onClick={() => handleSort("mem", "内存")}
                  >
                    <span>内存</span>
                    {sortCol === "mem" ? (
                      sortDir === "ascending" ? (
                        <ArrowUp className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <ArrowDown className="h-3 w-3" aria-hidden="true" />
                      )
                    ) : (
                      <ArrowUpDown
                        className="h-3 w-3 opacity-40"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                </th>

                <th
                  scope="col"
                  aria-sort={sortCol === "traffic" ? sortDir : undefined}
                >
                  <button
                    type="button"
                    onClick={() => handleSort("traffic", "流量")}
                  >
                    <span>月流量</span>
                    {sortCol === "traffic" ? (
                      sortDir === "ascending" ? (
                        <ArrowUp className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <ArrowDown className="h-3 w-3" aria-hidden="true" />
                      )
                    ) : (
                      <ArrowUpDown
                        className="h-3 w-3 opacity-40"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                </th>

                <th scope="col" className="text-right">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredAndSorted.map((node) => {
                const effectiveGroup = groupOverrides[node.id] ?? node.group;
                const memPct = Math.round(
                  (node.memUsedMb / Math.max(1, node.memTotalMb)) * 100,
                );
                const memGbTotal = (node.memTotalMb / 1024).toFixed(
                  node.memTotalMb < 1024 ? 1 : 0,
                );
                const trafficPct = node.monthlyTrafficLimitGb
                  ? Math.min(
                      100,
                      Math.round(
                        (node.monthlyTrafficUsedGb /
                          node.monthlyTrafficLimitGb) *
                          100,
                      ),
                    )
                  : 15;

                return (
                  <tr key={node.id}>
                    <td>
                      <div className="flex items-center gap-2.5">
                        <StatusDot
                          tone={
                            !node.online
                              ? "danger"
                              : node.cpuPct >= node.watermark.cpuTriggerPct
                                ? "warn"
                                : "ok"
                          }
                        />
                        <div>
                          <button
                            type="button"
                            onClick={() => onInspectNode(node.id)}
                            style={{ color: "var(--text-primary)" }}
                            className="cursor-pointer text-left text-[13px] font-semibold hover:underline"
                          >
                            {node.name}
                          </button>
                          <div
                            style={{ color: "var(--text-tertiary)" }}
                            className="text-[11.5px]"
                          >
                            {node.regionCode}
                          </div>
                        </div>
                      </div>
                    </td>

                    <td>
                      <select
                        aria-label={`${node.name} 分组`}
                        value={effectiveGroup}
                        onChange={(e) => {
                          const nextG = e.target.value as FleetNode["group"];
                          setGroupOverrides((prev) => ({
                            ...prev,
                            [node.id]: nextG,
                          }));
                          onNotify?.(
                            `已将 ${node.name} 移至 ${SHORT_GROUP_LABEL[nextG]}`,
                            "info",
                          );
                        }}
                        style={{
                          backgroundColor: "var(--bg-subtle)",
                          color: "var(--text-secondary)",
                          border: "1px solid var(--border-hairline)",
                        }}
                        className="h-7 cursor-pointer rounded-[6px] px-2 text-[12px]"
                      >
                        <option value="生产核心">生产</option>
                        <option value="亚太边缘">亚太</option>
                        <option value="欧美枢纽">欧美</option>
                        <option value="1G 小鸡">轻量</option>
                        <option value="中枢本机">本机</option>
                      </select>
                    </td>

                    <td>
                      <div className="flex items-center gap-2">
                        <span
                          style={{ color: "var(--text-primary)" }}
                          className="font-mono-num text-[12.5px]"
                        >
                          {node.ipv4}
                        </span>
                        <Badge tone="neutral">
                          {node.cpuCores}C · {memGbTotal}G
                        </Badge>
                      </div>
                    </td>

                    <td className="whitespace-nowrap">
                      {node.online ? (
                        <div className="font-mono-num tabular-nums flex flex-col gap-0.5 text-[12px] leading-tight">
                          <span style={{ color: "var(--accent-ink)" }}>
                            ↓ {formatRateKbps(node.netRxKbps)}
                          </span>
                          <span style={{ color: "var(--status-ok-ink)" }}>
                            ↑ {formatRateKbps(node.netTxKbps)}
                          </span>
                        </div>
                      ) : (
                        <span
                          style={{ color: "var(--text-tertiary)" }}
                          className="font-mono-num tabular-nums text-[12px]"
                        >
                          —
                        </span>
                      )}
                    </td>

                    <td>
                      <div className="w-28">
                        <MetricBar
                          valueLabel={
                            node.online ? `${node.cpuPct.toFixed(0)}%` : "离线"
                          }
                          valuePct={node.online ? node.cpuPct : 0}
                          dangerAt={node.watermark.cpuTriggerPct}
                          thickness={3}
                        />
                      </div>
                    </td>

                    <td>
                      <div className="w-28">
                        <MetricBar
                          valueLabel={node.online ? `${memPct}%` : "—"}
                          valuePct={node.online ? memPct : 0}
                          dangerAt={node.watermark.memTriggerPct}
                          thickness={3}
                        />
                      </div>
                    </td>

                    <td>
                      <div className="w-32">
                        <MetricBar
                          valueLabel={
                            node.monthlyTrafficLimitGb
                              ? `${node.monthlyTrafficUsedGb.toFixed(0)} / ${node.monthlyTrafficLimitGb}G`
                              : `${node.monthlyTrafficUsedGb.toFixed(0)}G`
                          }
                          valuePct={trafficPct}
                          thickness={3}
                        />
                      </div>
                    </td>

                    <td className="text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        <Button
                          size="xs"
                          variant="secondary"
                          icon={
                            <SlidersHorizontal
                              className="h-3 w-3"
                              aria-hidden="true"
                            />
                          }
                          onClick={() => openThresholdModal(node)}
                        >
                          阈值
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          icon={
                            <KeyRound className="h-3 w-3" aria-hidden="true" />
                          }
                          onClick={() => {
                            setTokenNode(node);
                            setFreshTokenValue(null);
                          }}
                        >
                          密钥
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Simple 3-Step Add Server Modal (填写名称 -> 复制安装命令 -> 等待上线) */}
      <NativeDialog
        open={provisionModalOpen}
        onClose={onCloseProvisionModal}
        titleId={provisionTitleId}
        maxWidthClass="max-w-[480px]"
      >
        <div className="space-y-5 p-6">
          <div className="flex items-center justify-between">
            <h3
              id={provisionTitleId}
              style={{ color: "var(--text-primary)" }}
              className="text-[16px] font-semibold"
            >
              添加服务器
            </h3>
            <IconCloseButton onClick={onCloseProvisionModal} />
          </div>

          {/* Clean 3-Step Indicator */}
          <div className="flex items-center justify-between gap-2">
            {(
              [
                { step: 1, label: "填写名称" },
                { step: 2, label: "复制安装命令" },
                { step: 3, label: "等待上线" },
              ] as const
            ).map((item, idx) => {
              const done = wizardStep > item.step;
              const active = wizardStep === item.step;
              return (
                <React.Fragment key={item.step}>
                  <div className="flex items-center gap-2">
                    <span
                      style={
                        done
                          ? {
                              backgroundColor: "var(--ink-primary)",
                              color: "var(--ink-on-primary)",
                            }
                          : active
                            ? {
                                backgroundColor: "var(--accent-soft)",
                                color: "var(--accent-ink)",
                                border: "1px solid var(--accent-border)",
                              }
                            : {
                                backgroundColor: "var(--bg-subtle)",
                                color: "var(--text-tertiary)",
                                border: "1px solid var(--border-subtle)",
                              }
                      }
                      className="font-mono-num inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold"
                    >
                      {done ? (
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        item.step
                      )}
                    </span>
                    <span
                      style={{
                        color:
                          active || done
                            ? "var(--text-primary)"
                            : "var(--text-tertiary)",
                      }}
                      className="text-[12.5px] font-medium whitespace-nowrap"
                    >
                      {item.label}
                    </span>
                  </div>
                  {idx < 2 && (
                    <div
                      style={{
                        backgroundColor: done
                          ? "var(--ink-primary)"
                          : "var(--border-subtle)",
                      }}
                      className="h-[1px] flex-1"
                    />
                  )}
                </React.Fragment>
              );
            })}
          </div>

          {wizardStep === 1 && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="srv-name"
                  style={{ color: "var(--text-secondary)" }}
                  className="block text-[12px] font-medium"
                >
                  服务器名称
                </label>
                <input
                  id="srv-name"
                  autoFocus
                  type="text"
                  value={newServerName}
                  onChange={(e) => setNewServerName(e.target.value)}
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-subtle)",
                  }}
                  className="h-9 w-full rounded-[8px] px-3 text-[13px] outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label
                    htmlFor="srv-region"
                    style={{ color: "var(--text-secondary)" }}
                    className="block text-[12px] font-medium"
                  >
                    所在地区
                  </label>
                  <select
                    id="srv-region"
                    value={newServerRegionIdx}
                    onChange={(e) =>
                      setNewServerRegionIdx(Number(e.target.value))
                    }
                    style={{
                      backgroundColor: "var(--bg-subtle)",
                      color: "var(--text-primary)",
                      border: "1px solid var(--border-subtle)",
                    }}
                    className="h-9 w-full rounded-[8px] px-2.5 text-[13px]"
                  >
                    {REGION_OPTIONS.map((r, i) => (
                      <option key={r.short} value={i}>
                        {r.code}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="srv-group"
                    style={{ color: "var(--text-secondary)" }}
                    className="block text-[12px] font-medium"
                  >
                    所属分组
                  </label>
                  <select
                    id="srv-group"
                    value={newServerGroup}
                    onChange={(e) =>
                      setNewServerGroup(e.target.value as FleetNode["group"])
                    }
                    style={{
                      backgroundColor: "var(--bg-subtle)",
                      color: "var(--text-primary)",
                      border: "1px solid var(--border-subtle)",
                    }}
                    className="h-9 w-full rounded-[8px] px-2.5 text-[13px]"
                  >
                    <option value="生产核心">生产</option>
                    <option value="亚太边缘">亚太</option>
                    <option value="欧美枢纽">欧美</option>
                    <option value="1G 小鸡">轻量</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1.5">
                <span
                  style={{ color: "var(--text-secondary)" }}
                  className="block text-[12px] font-medium"
                >
                  机器规格
                </span>
                <div className="grid grid-cols-3 gap-2">
                  {SPEC_PRESETS.map((preset) => {
                    const active = newServerSpecId === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => setNewServerSpecId(preset.id)}
                        style={
                          active
                            ? {
                                backgroundColor: "var(--ink-primary)",
                                color: "var(--ink-on-primary)",
                              }
                            : {
                                backgroundColor: "var(--bg-subtle)",
                                color: "var(--text-secondary)",
                                border: "1px solid var(--border-hairline)",
                              }
                        }
                        className="font-mono-num h-9 cursor-pointer rounded-[8px] text-[12.5px] font-medium"
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onCloseProvisionModal}
                >
                  取消
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setWizardStep(2)}
                >
                  下一步
                </Button>
              </div>
            </div>
          )}

          {wizardStep === 2 && (
            <div className="space-y-4">
              <div
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  border: "1px solid var(--border-hairline)",
                }}
                className="space-y-3 rounded-[10px] p-4"
              >
                <div className="flex items-center justify-between">
                  <span
                    style={{ color: "var(--text-secondary)" }}
                    className="text-[12px] font-medium"
                  >
                    在目标服务器上执行以下命令
                  </span>
                  <CopyButton
                    value={installCommand}
                    label="复制命令"
                    onCopied={() => onNotify?.("安装命令已复制", "success")}
                  />
                </div>
                <pre
                  style={{
                    backgroundColor: "var(--bg-sheet)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-subtle)",
                  }}
                  className="thin-scrollbar overflow-x-auto rounded-[8px] p-3 font-mono text-[12px]"
                >
                  <code>{installCommand}</code>
                </pre>
              </div>

              <div className="flex justify-between pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setWizardStep(1)}
                >
                  上一步
                </Button>
                <Button
                  autoFocus
                  variant="primary"
                  size="sm"
                  onClick={() => setWizardStep(3)}
                >
                  我已执行，下一步
                </Button>
              </div>
            </div>
          )}

          {wizardStep === 3 && (
            <div className="space-y-5">
              <div
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  border: "1px solid var(--border-hairline)",
                }}
                className="flex flex-col items-center justify-center gap-3 rounded-[10px] py-8"
              >
                {connectDone ? (
                  <>
                    <span
                      style={{
                        backgroundColor: "var(--status-ok-bg)",
                        color: "var(--status-ok-ink)",
                        border: "1px solid var(--status-ok-border)",
                      }}
                      className="inline-flex h-10 w-10 items-center justify-center rounded-full"
                    >
                      <Check className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div
                      style={{ color: "var(--text-primary)" }}
                      className="text-[14px] font-semibold"
                    >
                      {newServerName} 已成功连接上线
                    </div>
                  </>
                ) : (
                  <>
                    <Loader2
                      className="h-7 w-7 animate-spin"
                      style={{ color: "var(--accent)" }}
                      aria-hidden="true"
                    />
                    <div
                      style={{ color: "var(--text-secondary)" }}
                      className="text-[13px]"
                    >
                      正在等待服务器首次连接...
                    </div>
                  </>
                )}
              </div>

              <div className="flex justify-between">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setWizardStep(2)}
                >
                  返回
                </Button>
                <Button
                  autoFocus
                  variant="primary"
                  size="sm"
                  disabled={!connectDone}
                  onClick={handleFinishProvision}
                >
                  完成添加
                </Button>
              </div>
            </div>
          )}
        </div>
      </NativeDialog>

      {/* Simple Slider Modal for Node Alert Thresholds */}
      <NativeDialog
        open={thresholdNode !== null}
        onClose={() => setThresholdNode(null)}
        titleId={thresholdTitleId}
        maxWidthClass="max-w-[400px]"
      >
        <form onSubmit={handleSaveThresholds} className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <h3
              id={thresholdTitleId}
              style={{ color: "var(--text-primary)" }}
              className="text-[15px] font-semibold"
            >
              告警阈值 · {thresholdNode?.name}
            </h3>
            <IconCloseButton onClick={() => setThresholdNode(null)} />
          </div>

          <div className="space-y-4 py-1">
            {[
              { label: "CPU 使用率", val: cpuLimit, set: setCpuLimit },
              { label: "内存使用率", val: memLimit, set: setMemLimit },
              { label: "磁盘使用率", val: diskLimit, set: setDiskLimit },
            ].map((row) => (
              <div key={row.label} className="space-y-1.5">
                <div className="flex items-center justify-between text-[12.5px]">
                  <span style={{ color: "var(--text-secondary)" }}>
                    {row.label}
                  </span>
                  <span
                    style={{ color: "var(--text-primary)" }}
                    className="font-mono-num font-semibold"
                  >
                    {row.val}%
                  </span>
                </div>
                <input
                  type="range"
                  min={50}
                  max={98}
                  value={row.val}
                  onChange={(e) => row.set(Number(e.target.value))}
                  aria-label={row.label}
                  style={{ accentColor: "var(--ink-primary)" }}
                  className="w-full cursor-pointer"
                />
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setThresholdNode(null)}
            >
              取消
            </Button>
            <Button autoFocus type="submit" variant="primary" size="sm">
              保存
            </Button>
          </div>
        </form>
      </NativeDialog>

      {/* Simple Token Reset Modal */}
      <NativeDialog
        open={tokenNode !== null}
        onClose={() => setTokenNode(null)}
        titleId={tokenTitleId}
        maxWidthClass="max-w-[420px]"
      >
        <div className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <h3
              id={tokenTitleId}
              style={{ color: "var(--text-primary)" }}
              className="text-[15px] font-semibold"
            >
              连接密钥 · {tokenNode?.name}
            </h3>
            <IconCloseButton onClick={() => setTokenNode(null)} />
          </div>

          <div
            style={{
              backgroundColor: "var(--bg-subtle)",
              border: "1px solid var(--border-hairline)",
            }}
            className="flex items-center justify-between gap-2 rounded-[8px] px-3 py-2.5"
          >
            <code
              style={{ color: "var(--text-primary)" }}
              className="font-mono-num truncate text-[12.5px]"
            >
              {freshTokenValue ??
                (tokenNode
                  ? (rotatedTokens[tokenNode.id] ?? tokenNode.tokenPreview)
                  : "")}
            </code>
            {freshTokenValue && (
              <CopyButton value={freshTokenValue} label="复制新密钥" />
            )}
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setTokenNode(null)}
            >
              关闭
            </Button>
            {!freshTokenValue && (
              <Button
                autoFocus
                variant="danger"
                size="sm"
                onClick={handleConfirmRotateToken}
              >
                生成新密钥
              </Button>
            )}
          </div>
        </div>
      </NativeDialog>
    </div>
  );
}

export default ServersProvisionView;
