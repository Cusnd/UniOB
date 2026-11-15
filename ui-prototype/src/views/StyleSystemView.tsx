import React, { useEffect, useId, useState } from "react";
import { Check, Moon, Pause, Play, Sun } from "lucide-react";
import type { AccentTheme, StyleSystemViewProps, ThemeMode } from "../types";
import {
  Badge,
  Button,
  Card,
  CopyButton,
  IconCloseButton,
  Kbd,
  MetricBar,
  NativeDialog,
  SectionHeader,
  SegmentedControl,
  Sparkline,
  StatusDot,
  Switch,
} from "../components/ui/Primitives";

const SWATCH_ITEMS = [
  { cssVar: "--bg-shell", name: "外框纸面", hex: "#F6F6F3 / #111110" },
  { cssVar: "--bg-sheet", name: "工作台面", hex: "#FFFFFF / #171716" },
  { cssVar: "--bg-subtle", name: "次级内衬", hex: "#FAFAFA / #1E1E1C" },
  { cssVar: "--bg-muted", name: "轨道底衬", hex: "#F2F2EE / #252523" },
  { cssVar: "--ink-primary", name: "曜石主墨", hex: "#18181B / #F4F4F1" },
  { cssVar: "--text-secondary", name: "次级正文", hex: "#52525B / #A1A1AA" },
  { cssVar: "--text-tertiary", name: "辅助文字", hex: "#71717A / #7E7E86" },
  { cssVar: "--accent", name: "品牌点缀", hex: "#3D5AFE · 5%" },
  { cssVar: "--status-ok", name: "正常在线", hex: "#10B981" },
  { cssVar: "--status-warn", name: "预警提示", hex: "#F59E0B" },
  { cssVar: "--status-danger", name: "越界告警", hex: "#EF4444" },
  { cssVar: "--status-idle", name: "静默待命", hex: "#94A3B8" },
] as const;

const ACCENT_ITEMS: Array<{
  id: AccentTheme;
  label: string;
  hex: string;
}> = [
  { id: "cobalt", label: "钴蓝", hex: "#3D5AFE" },
  { id: "vermilion", label: "朱砂", hex: "#E5484D" },
  { id: "jade", label: "翡翠", hex: "#16A34A" },
];

const SPARK_DATA = [
  24, 26, 25, 29, 34, 31, 28, 33, 42, 48, 44, 39, 36, 41, 53, 62, 58, 49, 45,
  43,
];

export function StyleSystemView(
  props: StyleSystemViewProps,
): React.JSX.Element {
  const { theme, accent, onThemeChange, onAccentChange, onNotify } = props;
  const dialogTitleId = useId();

  const [ticking, setTicking] = useState(true);
  const [tick, setTick] = useState(0);
  const [copiedVar, setCopiedVar] = useState<string | null>(null);

  const [segVal, setSegVal] = useState<"cards" | "table" | "matrix">("cards");
  const [swA, setSwA] = useState(true);
  const [swB, setSwB] = useState(false);
  const [barVal, setBarVal] = useState(64);
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => {
      setTick((t) => (t + 1) % 1000);
    }, 1200);
    return () => window.clearInterval(id);
  }, [ticking]);

  const handleCopySwatch = async (cssVar: string) => {
    try {
      await navigator.clipboard?.writeText(`var(${cssVar})`);
    } catch {
      // Clipboard ignored in restricted preview
    }
    setCopiedVar(cssVar);
    onNotify?.(`已复制 var(${cssVar})`, "info");
    window.setTimeout(() => {
      setCopiedVar((c) => (c === cssVar ? null : c));
    }, 1400);
  };

  const liveCpu = (32.4 + ((tick * 7) % 48) * 0.41).toFixed(1);
  const liveRx = (1420 + ((tick * 193) % 6800)).toLocaleString();
  const liveRtt = 22 + ((tick * 9) % 17);

  return (
    <div className="space-y-6">
      {/* Page Title */}
      <SectionHeader
        title="设计规范"
        actions={
          <SegmentedControl<ThemeMode>
            ariaLabel="明暗外观"
            value={theme}
            onChange={onThemeChange}
            options={[
              {
                value: "light",
                label: "浅色纸感",
                icon: <Sun className="h-3.5 w-3.5" aria-hidden="true" />,
              },
              {
                value: "dark",
                label: "深色哑光",
                icon: <Moon className="h-3.5 w-3.5" aria-hidden="true" />,
              },
            ]}
          />
        }
      />

      {/* 1. Theme Polarity & Accent Studio */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Card className="space-y-4 p-5 lg:col-span-6">
          <div className="flex items-center justify-between">
            <span
              style={{ color: "var(--text-primary)" }}
              className="text-[14px] font-semibold"
            >
              表面模式
            </span>
            <Badge tone="mono">92 / 5 / 3</Badge>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Light Preview */}
            <button
              type="button"
              aria-pressed={theme === "light"}
              onClick={() => onThemeChange("light")}
              style={{
                borderColor:
                  theme === "light"
                    ? "var(--ink-primary)"
                    : "var(--border-subtle)",
                backgroundColor: "var(--bg-subtle)",
              }}
              className="flex cursor-pointer flex-col gap-2.5 rounded-[10px] border p-3 text-left"
            >
              <div
                style={{
                  backgroundColor: "#F6F6F3",
                  border: "1px solid rgba(24,24,27,0.10)",
                }}
                className="flex h-20 w-full gap-1.5 rounded-[7px] p-1.5"
              >
                <div className="flex w-7 flex-col gap-1 pt-0.5">
                  <div
                    style={{ backgroundColor: "#18181B" }}
                    className="h-1.5 w-5 rounded-full"
                  />
                  <div
                    style={{ backgroundColor: "rgba(24,24,27,0.16)" }}
                    className="h-1 w-6 rounded-full"
                  />
                </div>
                <div
                  style={{
                    backgroundColor: "#FFFFFF",
                    border: "1px solid rgba(24,24,27,0.08)",
                  }}
                  className="flex flex-1 flex-col justify-between rounded-[5px] p-1.5"
                >
                  <div
                    style={{ backgroundColor: "#18181B" }}
                    className="h-1.5 w-8 rounded-full"
                  />
                  <div
                    style={{ backgroundColor: "#F2F2EE" }}
                    className="h-5 w-full rounded-[3px]"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span
                  style={{ color: "var(--text-primary)" }}
                  className="text-[12.5px] font-medium"
                >
                  浅色纸感
                </span>
                <span
                  style={{ color: "var(--text-tertiary)" }}
                  className="font-mono-num text-[11px]"
                >
                  #F6F6F3
                </span>
              </div>
            </button>

            {/* Dark Preview */}
            <button
              type="button"
              aria-pressed={theme === "dark"}
              onClick={() => onThemeChange("dark")}
              style={{
                borderColor:
                  theme === "dark"
                    ? "var(--ink-primary)"
                    : "var(--border-subtle)",
                backgroundColor: "var(--bg-subtle)",
              }}
              className="flex cursor-pointer flex-col gap-2.5 rounded-[10px] border p-3 text-left"
            >
              <div
                style={{
                  backgroundColor: "#111110",
                  border: "1px solid rgba(255,255,255,0.12)",
                }}
                className="flex h-20 w-full gap-1.5 rounded-[7px] p-1.5"
              >
                <div className="flex w-7 flex-col gap-1 pt-0.5">
                  <div
                    style={{ backgroundColor: "#F4F4F1" }}
                    className="h-1.5 w-5 rounded-full"
                  />
                  <div
                    style={{ backgroundColor: "rgba(255,255,255,0.22)" }}
                    className="h-1 w-6 rounded-full"
                  />
                </div>
                <div
                  style={{
                    backgroundColor: "#171716",
                    border: "1px solid rgba(255,255,255,0.08)",
                  }}
                  className="flex flex-1 flex-col justify-between rounded-[5px] p-1.5"
                >
                  <div
                    style={{ backgroundColor: "#F4F4F1" }}
                    className="h-1.5 w-8 rounded-full"
                  />
                  <div
                    style={{ backgroundColor: "#252523" }}
                    className="h-5 w-full rounded-[3px]"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span
                  style={{ color: "var(--text-primary)" }}
                  className="text-[12.5px] font-medium"
                >
                  深色哑光
                </span>
                <span
                  style={{ color: "var(--text-tertiary)" }}
                  className="font-mono-num text-[11px]"
                >
                  #111110
                </span>
              </div>
            </button>
          </div>
        </Card>

        {/* Accent Swatches & 92/5/3 Proportional Bar */}
        <Card className="flex flex-col justify-between gap-4 p-5 lg:col-span-6">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span
                style={{ color: "var(--text-primary)" }}
                className="text-[14px] font-semibold"
              >
                点缀色
              </span>
              <span
                style={{ color: "var(--text-tertiary)" }}
                className="font-mono-num text-[11.5px]"
              >
                5% 面积克制
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2.5">
              {ACCENT_ITEMS.map((item) => {
                const active = accent === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onAccentChange(item.id)}
                    style={{
                      backgroundColor: active
                        ? "var(--accent-soft)"
                        : "var(--bg-subtle)",
                      borderColor: active
                        ? "var(--accent-border)"
                        : "var(--border-hairline)",
                    }}
                    className="flex cursor-pointer flex-col gap-3 rounded-[10px] border p-3 text-left"
                  >
                    <span
                      style={{ backgroundColor: item.hex }}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-[7px] text-white"
                    >
                      {active && (
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                    </span>
                    <div>
                      <div
                        style={{ color: "var(--text-primary)" }}
                        className="text-[13px] font-semibold"
                      >
                        {item.label}
                      </div>
                      <div
                        style={{ color: "var(--text-tertiary)" }}
                        className="font-mono-num text-[11px]"
                      >
                        {item.hex}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Minimal 92 / 5 / 3 Visual Bar */}
          <div className="space-y-1.5">
            <div
              style={{ border: "1px solid var(--border-subtle)" }}
              className="flex h-3 w-full overflow-hidden rounded-full"
            >
              <div
                style={{ width: "82%", backgroundColor: "var(--bg-sheet)" }}
              />
              <div
                style={{ width: "10%", backgroundColor: "var(--ink-primary)" }}
              />
              <div style={{ width: "5%", backgroundColor: "var(--accent)" }} />
              <div
                style={{ width: "3%", backgroundColor: "var(--status-ok)" }}
              />
            </div>
            <div
              style={{ color: "var(--text-tertiary)" }}
              className="font-mono-num flex justify-between text-[11px]"
            >
              <span>92% 纸墨基底</span>
              <span>5% 点缀</span>
              <span>3% 状态</span>
            </div>
          </div>
        </Card>
      </div>

      {/* 2. Pure Visual Color Swatches */}
      <Card className="space-y-3.5 p-5">
        <div className="flex items-center justify-between">
          <span
            style={{ color: "var(--text-primary)" }}
            className="text-[14px] font-semibold"
          >
            色彩色板
          </span>
          <span
            style={{ color: "var(--text-tertiary)" }}
            className="text-[11.5px]"
          >
            点击复制变量
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
          {SWATCH_ITEMS.map((item) => {
            const copied = copiedVar === item.cssVar;
            return (
              <button
                key={item.cssVar}
                type="button"
                onClick={() => void handleCopySwatch(item.cssVar)}
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  border: "1px solid var(--border-hairline)",
                }}
                className="flex cursor-pointer flex-col gap-2.5 rounded-[8px] p-2.5 text-left transition-colors hover:border-[var(--border-strong)]"
              >
                <div
                  style={{
                    backgroundColor: `var(${item.cssVar})`,
                    border: "1px solid var(--border-subtle)",
                  }}
                  className="h-11 w-full rounded-[6px]"
                />
                <div className="min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <span
                      style={{ color: "var(--text-primary)" }}
                      className="truncate text-[12px] font-medium"
                    >
                      {item.name}
                    </span>
                    {copied && (
                      <Check
                        className="h-3 w-3 shrink-0"
                        style={{ color: "var(--status-ok)" }}
                        aria-hidden="true"
                      />
                    )}
                  </div>
                  <div
                    style={{ color: "var(--text-tertiary)" }}
                    className="font-mono-num truncate text-[10.5px]"
                  >
                    {item.hex}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </Card>

      {/* 3. Type Scale & Tabular Numbers */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Card className="space-y-3 p-5 lg:col-span-7">
          <div className="flex items-center justify-between">
            <span
              style={{ color: "var(--text-primary)" }}
              className="text-[14px] font-semibold"
            >
              字阶规范
            </span>
            <Badge tone="mono">Plus Jakarta Sans · JetBrains Mono</Badge>
          </div>

          <div className="divide-y divide-[var(--border-hairline)]">
            <div className="flex items-baseline justify-between py-2.5">
              <span
                style={{ color: "var(--text-primary)" }}
                className="text-[22px] font-semibold tracking-[-0.025em]"
              >
                Light Paper Studio
              </span>
              <span
                style={{ color: "var(--text-tertiary)" }}
                className="font-mono-num text-[11.5px]"
              >
                22px / 600
              </span>
            </div>
            <div className="flex items-baseline justify-between py-2.5">
              <span
                style={{ color: "var(--text-primary)" }}
                className="text-[17px] font-semibold tracking-[-0.015em]"
              >
                机群总览与服务迁移
              </span>
              <span
                style={{ color: "var(--text-tertiary)" }}
                className="font-mono-num text-[11.5px]"
              >
                17px / 600
              </span>
            </div>
            <div className="flex items-baseline justify-between py-2.5">
              <span
                style={{ color: "var(--text-secondary)" }}
                className="text-[13px]"
              >
                轻量清晰的商业级监控界面排版
              </span>
              <span
                style={{ color: "var(--text-tertiary)" }}
                className="font-mono-num text-[11.5px]"
              >
                13px / 400
              </span>
            </div>
            <div className="flex items-baseline justify-between pt-2.5">
              <span
                style={{ color: "var(--text-primary)" }}
                className="font-mono-num text-[12.5px] font-medium"
              >
                45.76.112.48 · 92.4% · 1,420 KB/s
              </span>
              <span
                style={{ color: "var(--text-tertiary)" }}
                className="font-mono-num text-[11.5px]"
              >
                12.5px Mono
              </span>
            </div>
          </div>
        </Card>

        <Card className="flex flex-col justify-between gap-3.5 p-5 lg:col-span-5">
          <div className="flex items-center justify-between">
            <span
              style={{ color: "var(--text-primary)" }}
              className="text-[14px] font-semibold"
            >
              等宽数字对齐
            </span>
            <Button
              size="xs"
              variant="ghost"
              icon={
                ticking ? (
                  <Pause className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <Play className="h-3 w-3" aria-hidden="true" />
                )
              }
              onClick={() => setTicking((v) => !v)}
            >
              {ticking ? "暂停" : "跳动"}
            </Button>
          </div>

          <div className="space-y-2">
            {[
              { label: "CPU", val: `${liveCpu}%` },
              { label: "实时速率", val: `${liveRx} KB/s` },
              { label: "网络延迟", val: `${liveRtt} ms` },
            ].map((row) => (
              <div
                key={row.label}
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  border: "1px solid var(--border-hairline)",
                }}
                className="flex items-center justify-between rounded-[8px] px-3 py-2 text-[12.5px]"
              >
                <span style={{ color: "var(--text-secondary)" }}>
                  {row.label}
                </span>
                <span
                  style={{
                    color: "var(--text-primary)",
                    borderLeft: "1px dashed var(--border-strong)",
                  }}
                  className="font-mono-num w-28 pl-2 text-right font-semibold"
                >
                  {row.val}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* 4. Radii Scale Blocks */}
      <Card className="space-y-3.5 p-5">
        <span
          style={{ color: "var(--text-primary)" }}
          className="block text-[14px] font-semibold"
        >
          圆角梯度
        </span>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { px: 6, label: "6px · 徽章与微按钮" },
            { px: 8, label: "8px · 按钮与输入框" },
            { px: 10, label: "10px · 数据卡片" },
            { px: 14, label: "14px · 工作台面与弹窗" },
          ].map((r) => (
            <div
              key={r.px}
              style={{
                borderRadius: r.px,
                backgroundColor: "var(--bg-subtle)",
                border: "1px solid var(--border-strong)",
              }}
              className="flex h-20 flex-col items-center justify-center gap-1"
            >
              <span
                style={{ color: "var(--text-primary)" }}
                className="font-mono-num text-[14px] font-semibold"
              >
                {r.px}px
              </span>
              <span
                style={{ color: "var(--text-tertiary)" }}
                className="text-[11px]"
              >
                {r.label}
              </span>
            </div>
          ))}
        </div>
      </Card>

      {/* 5. Interactive Controls Showcase */}
      <Card className="space-y-5 p-5">
        <span
          style={{ color: "var(--text-primary)" }}
          className="block text-[14px] font-semibold"
        >
          基础控件
        </span>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" size="sm">
                主要操作
              </Button>
              <Button variant="secondary" size="sm">
                次级按钮
              </Button>
              <Button variant="accent" size="sm">
                点缀高亮
              </Button>
              <Button variant="ghost" size="sm">
                轻量操作
              </Button>
              <Button variant="danger" size="sm">
                危险警示
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral">常规标签</Badge>
              <Badge tone="accent">当前使用</Badge>
              <Badge tone="ok">运行正常</Badge>
              <Badge tone="warn">负载偏高</Badge>
              <Badge tone="danger">连接中断</Badge>
              <CopyButton value="https://uniob.cloud" label="复制链接" />
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <StatusDot tone="ok" pulse label="在线" />
              <StatusDot tone="idle" label="待命" />
              <StatusDot tone="warn" label="预警" />
              <StatusDot tone="danger" label="告警" />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <SegmentedControl
                ariaLabel="视图切换示例"
                size="xs"
                value={segVal}
                onChange={setSegVal}
                options={[
                  { value: "cards", label: "卡片" },
                  { value: "table", label: "列表" },
                  { value: "matrix", label: "矩阵" },
                ]}
              />

              <div className="flex items-center gap-3">
                <Switch checked={swA} onChange={setSwA} ariaLabel="示例开关一" />
                <Switch checked={swB} onChange={setSwB} ariaLabel="示例开关二" />
                <div className="flex items-center gap-1">
                  <Kbd>⌘</Kbd>
                  <Kbd>K</Kbd>
                </div>
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => setPreviewOpen(true)}
                >
                  弹窗示例
                </Button>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div
              style={{
                backgroundColor: "var(--bg-subtle)",
                border: "1px solid var(--border-hairline)",
              }}
              className="flex flex-col justify-between rounded-[10px] p-3.5"
            >
              <div className="flex items-center justify-between text-[12px]">
                <span style={{ color: "var(--text-secondary)" }}>趋势曲线</span>
                <span
                  style={{ color: "var(--text-primary)" }}
                  className="font-mono-num font-semibold"
                >
                  43%
                </span>
              </div>
              <Sparkline
                data={SPARK_DATA}
                width={200}
                height={42}
                max={100}
                tone="accent"
                className="mt-2 w-full"
              />
            </div>

            <div
              style={{
                backgroundColor: "var(--bg-subtle)",
                border: "1px solid var(--border-hairline)",
              }}
              className="flex flex-col justify-between gap-3 rounded-[10px] p-3.5"
            >
              <MetricBar
                label="资源水位"
                valueLabel={`${barVal}%`}
                valuePct={barVal}
                thickness={4}
              />
              <input
                type="range"
                min={10}
                max={98}
                value={barVal}
                onChange={(e) => setBarVal(Number(e.target.value))}
                aria-label="调节演示水位"
                style={{ accentColor: "var(--ink-primary)" }}
                className="w-full cursor-pointer"
              />
            </div>
          </div>
        </div>
      </Card>

      {/* Clean Sample Modal */}
      <NativeDialog
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        titleId={dialogTitleId}
        maxWidthClass="max-w-[380px]"
      >
        <div className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <h3
              id={dialogTitleId}
              style={{ color: "var(--text-primary)" }}
              className="text-[15px] font-semibold"
            >
              弹窗组件示例
            </h3>
            <IconCloseButton onClick={() => setPreviewOpen(false)} />
          </div>

          <div
            style={{
              backgroundColor: "var(--bg-subtle)",
              border: "1px solid var(--border-hairline)",
              color: "var(--text-secondary)",
            }}
            className="rounded-[8px] p-3 text-[12.5px]"
          >
            支持键盘 <Kbd>Esc</Kbd> 与点击背景关闭。
          </div>

          <div className="flex justify-end">
            <Button
              autoFocus
              variant="primary"
              size="sm"
              onClick={() => setPreviewOpen(false)}
            >
              确定
            </Button>
          </div>
        </div>
      </NativeDialog>
    </div>
  );
}

export default StyleSystemView;
