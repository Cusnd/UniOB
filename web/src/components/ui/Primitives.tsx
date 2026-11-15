import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, ChevronDown, Copy, X } from "lucide-react";

/* ============================================================================
 * Telemetry Rate & Unit Formatting Helpers
 * ============================================================================ */

const RATE_UNITS = ["B/s", "KB/s", "MB/s", "GB/s", "TB/s"];

export function formatBytesPerSec(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps) || bps <= 0) {
    return "0 B/s";
  }
  const k = 1024;
  const idx = Math.min(
    Math.floor(Math.log(bps) / Math.log(k)),
    RATE_UNITS.length - 1,
  );
  const val = bps / Math.pow(k, idx);
  const digits = idx === 0 ? 0 : val >= 100 ? 0 : 1;
  return `${val.toFixed(digits)} ${RATE_UNITS[idx]}`;
}

export function formatRateKbps(kbps: number): string {
  if (!Number.isFinite(kbps) || kbps <= 0) return "0 KB/s";
  if (kbps < 1000) {
    return `${Math.round(kbps)} KB/s`;
  }
  const mbps = kbps / 1024;
  if (mbps < 1000) {
    return `${mbps >= 100 ? mbps.toFixed(0) : mbps.toFixed(1)} MB/s`;
  }
  const gbps = mbps / 1024;
  return `${gbps.toFixed(2)} GB/s`;
}

function computeNiceCeiling(
  rawMax: number,
  rateMode: "none" | "bps" | "kbps",
): number {
  if (rateMode === "bps") {
    const safeBps = Math.max(rawMax, 10 * 1024);
    const kb = 1024;
    const mb = 1024 * 1024;
    const gb = 1024 * 1024 * 1024;
    const bpsSteps = [
      10 * kb,
      25 * kb,
      50 * kb,
      100 * kb,
      250 * kb,
      500 * kb,
      1 * mb,
      2 * mb,
      5 * mb,
      10 * mb,
      20 * mb,
      50 * mb,
      100 * mb,
      250 * mb,
      500 * mb,
      1 * gb,
      2 * gb,
      5 * gb,
      10 * gb,
    ];
    for (const step of bpsSteps) {
      if (safeBps <= step * 0.92) return step;
    }
  }

  const safe = Math.max(rawMax, rateMode === "kbps" ? 64 : 1);
  if (rateMode === "kbps") {
    const rateSteps = [
      100,
      250,
      500,
      1024,
      2048,
      5120,
      10240,
      20480,
      30720,
      51200,
      102400,
      204800,
      512000,
      1048576,
    ];
    for (const step of rateSteps) {
      if (safe <= step * 0.92) return step;
    }
  }

  const exp = Math.floor(Math.log10(safe));
  const base = Math.pow(10, exp);
  const norm = safe / base;
  if (norm <= 1) return 1 * base;
  if (norm <= 2) return 2 * base;
  if (norm <= 2.5) return 2.5 * base;
  if (norm <= 5) return 5 * base;
  return 10 * base;
}

function useMeasuredWidth(explicitWidth?: number): [
  React.RefObject<HTMLDivElement | null>,
  number,
] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState<number>(explicitWidth ?? 240);

  useEffect(() => {
    if (explicitWidth !== undefined) {
      setMeasured(explicitWidth);
      return;
    }
    const el = ref.current;
    if (!el) return;

    const update = () => {
      const w = Math.floor(el.getBoundingClientRect().width);
      if (w > 0) setMeasured(w);
    };
    update();

    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.floor(entry.contentRect.width);
        if (w > 0) setMeasured(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [explicitWidth]);

  return [ref, explicitWidth ?? measured];
}

/* ============================================================================
 * Top-Layer Native <dialog> Helpers (modern-web-guidance compliant)
 * ============================================================================ */

let cachedDisplayTransitionSupport: boolean | undefined;

function canTransitionDisplay(): boolean {
  if (cachedDisplayTransitionSupport !== undefined) {
    return cachedDisplayTransitionSupport;
  }
  if (
    typeof window === "undefined" ||
    !window.CSS?.supports?.("transition-behavior", "allow-discrete") ||
    !document.body
  ) {
    return false;
  }
  const probe = document.createElement("div");
  probe.style.cssText =
    "transition: display 1s allow-discrete !important; display: block;";
  document.body.appendChild(probe);
  getComputedStyle(probe).display;
  probe.style.display = "none";
  cachedDisplayTransitionSupport = getComputedStyle(probe).display === "block";
  probe.remove();
  return cachedDisplayTransitionSupport;
}

function supportsTopLayerExit(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean(window.CSS?.supports?.("overlay", "auto")) &&
    canTransitionDisplay()
  );
}

export async function closeDialogSmoothly(
  dialog: HTMLDialogElement | null,
): Promise<void> {
  if (!dialog || !dialog.open) return;
  if (!supportsTopLayerExit()) {
    dialog.setAttribute("data-closing", "");
    const animations = dialog.getAnimations({ subtree: true });
    if (animations.length > 0) {
      await Promise.race([
        Promise.allSettled(animations.map((a) => a.finished)),
        new Promise((resolve) => setTimeout(resolve, 280)),
      ]);
    }
    if (!dialog.hasAttribute("data-closing")) return;
    dialog.removeAttribute("data-closing");
  }
  if (dialog.open) {
    dialog.close();
  }
}

function isPointerOutsideDialog(
  e: PointerEvent,
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

export interface NativeDialogProps {
  open: boolean;
  onClose: () => void;
  titleId: string;
  variant?: "modal" | "drawer";
  maxWidthClass?: string;
  children: React.ReactNode;
}

export function NativeDialog({
  open,
  onClose,
  titleId,
  variant = "modal",
  maxWidthClass = "max-w-[560px]",
  children,
}: NativeDialogProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      dialog.removeAttribute("data-closing");
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      void closeDialogSmoothly(dialog);
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => {
      dialog.returnValue = "";
      dialog.removeAttribute("data-closing");
      onCloseRef.current();
    };

    const handleCancel = (event: Event) => {
      event.preventDefault();
      void closeDialogSmoothly(dialog);
    };

    dialog.addEventListener("close", handleClose);
    dialog.addEventListener("cancel", handleCancel);

    let cleanupLightDismiss: (() => void) | undefined;
    if (!("closedBy" in HTMLDialogElement.prototype)) {
      let pressedOutside = false;
      const onPointerDown = (e: PointerEvent) => {
        pressedOutside =
          e.target === dialog && isPointerOutsideDialog(e, dialog);
      };
      const onPointerUp = (e: PointerEvent) => {
        if (
          pressedOutside &&
          e.target === dialog &&
          isPointerOutsideDialog(e, dialog)
        ) {
          void closeDialogSmoothly(dialog);
        }
        pressedOutside = false;
      };
      dialog.addEventListener("pointerdown", onPointerDown);
      dialog.addEventListener("pointerup", onPointerUp);
      cleanupLightDismiss = () => {
        dialog.removeEventListener("pointerdown", onPointerDown);
        dialog.removeEventListener("pointerup", onPointerUp);
      };
    }

    return () => {
      dialog.removeEventListener("close", handleClose);
      dialog.removeEventListener("cancel", handleCancel);
      cleanupLightDismiss?.();
    };
  }, []);

  const baseClass =
    variant === "drawer"
      ? `uniob-drawer w-full ${maxWidthClass}`
      : `uniob-modal m-auto w-[calc(100%-24px)] rounded-[14px] ${maxWidthClass}`;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className={baseClass}
      {...({ closedby: "any" } as Record<string, string>)}
    >
      <div className="flex h-full w-full flex-col overflow-hidden">
        {children}
      </div>
    </dialog>
  );
}

/* ============================================================================
 * 1. Button
 * ============================================================================ */
export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "accent"
  | "danger";
export type ButtonSize = "xs" | "sm" | "md";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: React.ReactNode;
}

export function Button({
  variant = "secondary",
  size = "sm",
  icon,
  children,
  className = "",
  type = "button",
  ...rest
}: ButtonProps): React.JSX.Element {
  const sizeClasses: Record<ButtonSize, string> = {
    xs: "h-7 px-2.5 text-[12px] gap-1.5 rounded-[6px]",
    sm: "h-8 px-3 text-[12.5px] gap-1.5 rounded-[8px]",
    md: "h-9 px-3.5 text-[13px] gap-2 rounded-[8px]",
  };

  const variantStyles: Record<ButtonVariant, React.CSSProperties> = {
    primary: {
      backgroundColor: "var(--ink-primary)",
      color: "var(--ink-on-primary)",
      boxShadow: "var(--shadow-btn-primary)",
      border: "1px solid transparent",
    },
    secondary: {
      backgroundColor: "var(--bg-card)",
      color: "var(--text-primary)",
      border: "1px solid var(--border-subtle)",
      boxShadow: "0 1px 1px rgba(24,24,27,0.02)",
    },
    ghost: {
      backgroundColor: "transparent",
      color: "var(--text-secondary)",
      border: "1px solid transparent",
    },
    accent: {
      backgroundColor: "var(--accent-soft)",
      color: "var(--accent-ink)",
      border: "1px solid var(--accent-border)",
    },
    danger: {
      backgroundColor: "var(--status-danger-bg)",
      color: "var(--status-danger-ink)",
      border: "1px solid var(--status-danger-border)",
    },
  };

  return (
    <button
      type={type}
      style={variantStyles[variant]}
      className={`inline-flex shrink-0 cursor-pointer items-center justify-center font-medium whitespace-nowrap transition-all duration-150 select-none hover:opacity-92 active:scale-[0.99] disabled:pointer-events-none disabled:opacity-45 ${sizeClasses[size]} ${className}`}
      {...rest}
    >
      {icon && <span className="inline-flex shrink-0">{icon}</span>}
      {children}
    </button>
  );
}

/* ============================================================================
 * 2. Badge
 * ============================================================================ */
export type BadgeTone =
  | "neutral"
  | "subtle"
  | "accent"
  | "ok"
  | "warn"
  | "danger"
  | "mono";

export interface BadgeProps {
  tone?: BadgeTone;
  children: React.ReactNode;
  className?: string;
  title?: string;
}

export function Badge({
  tone = "neutral",
  children,
  className = "",
  title,
}: BadgeProps): React.JSX.Element {
  const styles: Record<BadgeTone, React.CSSProperties> = {
    neutral: {
      backgroundColor: "var(--bg-subtle)",
      color: "var(--text-secondary)",
      border: "1px solid var(--border-hairline)",
    },
    subtle: {
      backgroundColor: "var(--bg-muted)",
      color: "var(--text-tertiary)",
      border: "1px solid transparent",
    },
    accent: {
      backgroundColor: "var(--accent-soft)",
      color: "var(--accent-ink)",
      border: "1px solid var(--accent-border)",
    },
    ok: {
      backgroundColor: "var(--status-ok-bg)",
      color: "var(--status-ok-ink)",
      border: "1px solid var(--status-ok-border)",
    },
    warn: {
      backgroundColor: "var(--status-warn-bg)",
      color: "var(--status-warn-ink)",
      border: "1px solid var(--status-warn-border)",
    },
    danger: {
      backgroundColor: "var(--status-danger-bg)",
      color: "var(--status-danger-ink)",
      border: "1px solid var(--status-danger-border)",
    },
    mono: {
      backgroundColor: "var(--bg-subtle)",
      color: "var(--text-secondary)",
      border: "1px solid var(--border-hairline)",
      fontFamily: "var(--font-mono)",
      fontVariantNumeric: "tabular-nums",
    },
  };

  return (
    <span
      title={title}
      style={styles[tone]}
      className={`inline-flex items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[11px] leading-tight font-medium whitespace-nowrap tabular-nums ${className}`}
    >
      {children}
    </span>
  );
}

/* ============================================================================
 * 3. StatusDot
 * Distinct geometry per state (circle / hollow ring / diamond) per WCAG 1.4.1
 * ============================================================================ */
export type StatusDotTone = "ok" | "warn" | "danger" | "idle" | "accent";

export interface StatusDotProps {
  tone: StatusDotTone;
  label?: string;
  pulse?: boolean;
  className?: string;
}

export function StatusDot({
  tone,
  label,
  pulse = false,
  className = "",
}: StatusDotProps): React.JSX.Element {
  const colorMap: Record<StatusDotTone, string> = {
    ok: "var(--status-ok)",
    warn: "var(--status-warn)",
    danger: "var(--status-danger)",
    idle: "var(--status-idle)",
    accent: "var(--accent)",
  };

  const shapeStyle: React.CSSProperties =
    tone === "idle"
      ? {
          width: 7,
          height: 7,
          borderRadius: "999px",
          border: `1.5px solid ${colorMap[tone]}`,
          backgroundColor: "transparent",
        }
      : tone === "danger"
        ? {
            width: 6.5,
            height: 6.5,
            borderRadius: "1.5px",
            transform: "rotate(45deg)",
            backgroundColor: colorMap[tone],
          }
        : {
            width: 6.5,
            height: 6.5,
            borderRadius: "999px",
            backgroundColor: colorMap[tone],
          };

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[12px] ${className}`}
    >
      <span className="relative inline-flex h-2 w-2 items-center justify-center">
        {pulse && (
          <span
            style={{ backgroundColor: colorMap[tone] }}
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-35"
          />
        )}
        <span aria-hidden="true" style={shapeStyle} className="shrink-0" />
      </span>
      {label && (
        <span style={{ color: "var(--text-secondary)" }} className="leading-none">
          {label}
        </span>
      )}
    </span>
  );
}

/* ============================================================================
 * 4. SegmentedControl
 * ============================================================================ */
export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
  badge?: string | number;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
  size?: "xs" | "sm";
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = "sm",
}: SegmentedControlProps<T>): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      style={{
        backgroundColor: "var(--bg-muted)",
        border: "1px solid var(--border-hairline)",
      }}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-[8px] p-0.5"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            style={
              active
                ? {
                    backgroundColor: "var(--bg-sheet)",
                    color: "var(--text-primary)",
                    boxShadow: "0 1px 2px rgba(24,24,27,0.06)",
                  }
                : {
                    backgroundColor: "transparent",
                    color: "var(--text-secondary)",
                  }
            }
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded-[6px] font-medium whitespace-nowrap transition-all duration-150 ${
              size === "xs"
                ? "h-6 px-2 text-[11.5px]"
                : "h-7 px-2.5 text-[12px]"
            }`}
          >
            {opt.icon && <span className="inline-flex shrink-0">{opt.icon}</span>}
            <span>{opt.label}</span>
            {opt.badge !== undefined && (
              <span
                style={{ color: active ? "var(--accent-ink)" : "var(--text-tertiary)" }}
                className="font-mono-num text-[10.5px]"
              >
                {opt.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ============================================================================
 * 5. Sparkline · 100% Width ResizeObserver 1:1 Pixel SVG (Zero Clipping/Stretch)
 * ============================================================================ */
export interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  max?: number;
  tone?: "accent" | "ok" | "warn" | "danger" | "neutral";
  fillArea?: boolean;
  thresholdPct?: number;
  className?: string;
}

export function Sparkline({
  data,
  width,
  height = 28,
  max,
  tone = "accent",
  fillArea = true,
  thresholdPct,
  className = "",
}: SparklineProps): React.JSX.Element {
  const gradId = useId();
  const [wrapRef, pxWidth] = useMeasuredWidth(width);
  const safe =
    data.length >= 2
      ? data
      : data.length === 1
        ? [data[0]!, data[0]!]
        : [0, 0];
  const computedMax = Math.max(max ?? 0, ...safe, 1);
  const padY = 2;
  const usableH = Math.max(4, height - padY * 2);
  const w = Math.max(24, pxWidth);

  const coords = safe.map((v, idx) => {
    const x = (idx / (safe.length - 1)) * w;
    const clamped = Math.max(0, Math.min(computedMax, v));
    const y = padY + usableH - (clamped / computedMax) * usableH;
    return [x, y] as const;
  });

  const strokePath = coords
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");

  const areaPath = `${strokePath} L${w.toFixed(1)},${height} L0,${height} Z`;

  const strokeColorMap: Record<NonNullable<SparklineProps["tone"]>, string> = {
    accent: "var(--accent)",
    ok: "var(--status-ok)",
    warn: "var(--status-warn)",
    danger: "var(--status-danger)",
    neutral: "var(--text-tertiary)",
  };
  const strokeColor = strokeColorMap[tone];

  const thresholdY =
    thresholdPct !== undefined
      ? padY +
        usableH -
        (Math.min(computedMax, thresholdPct) / computedMax) * usableH
      : null;

  return (
    <div
      ref={wrapRef}
      style={width !== undefined ? { width } : undefined}
      className={`${width !== undefined ? "inline-block shrink-0" : "block w-full min-w-0"} ${className}`}
    >
      <svg
        width={w}
        height={height}
        viewBox={`0 0 ${w} ${height}`}
        aria-hidden="true"
        className="block overflow-visible"
      >
        {fillArea && (
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={strokeColor} stopOpacity="0.06" />
              <stop offset="100%" stopColor={strokeColor} stopOpacity="0.0" />
            </linearGradient>
          </defs>
        )}
        <line
          x1={0}
          y1={Math.round(height - 1) + 0.5}
          x2={w}
          y2={Math.round(height - 1) + 0.5}
          stroke="var(--border-hairline)"
          strokeWidth={1}
        />
        {thresholdY !== null && (
          <line
            x1={0}
            y1={Math.round(thresholdY) + 0.5}
            x2={w}
            y2={Math.round(thresholdY) + 0.5}
            stroke="var(--border-strong)"
            strokeDasharray="2 3"
            strokeWidth={1}
          />
        )}
        {fillArea && <path d={areaPath} fill={`url(#${gradId})`} />}
        <path
          d={strokePath}
          fill="none"
          stroke={strokeColor}
          strokeWidth={1.25}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

/* ============================================================================
 * 5b. ObservabilityChart · Pixel-Exact Clinical Telemetry Chart
 * - 1:1 ResizeObserver SVG pixel coordinates (zero non-uniform aspect scaling)
 * - Crisp 1px dashed horizontal & vertical cartesian gridlines (2 3)
 * - Explicit JetBrains Mono tabular-nums 10px Y-axis & optional X-axis ticks
 * - Sharp 1.25px angular polylines (1–2+ series, <= 0.06 subtle fill)
 * - Interactive hover vertical crosshair + sample dots + exact value readout
 * ============================================================================ */
export interface ObservabilitySeries {
  label: string;
  color: string;
  data: number[];
  fillOpacity?: number;
  dashed?: boolean;
}

export interface ObservabilityChartProps {
  series: ObservabilitySeries[];
  height?: number;
  yMax?: number;
  yUnit?: string;
  isRateBps?: boolean;
  isRateKbps?: boolean;
  formatValue?: (val: number) => string;
  formatYTick?: (val: number) => string;
  showYAxis?: boolean;
  yAxisPlacement?: "left" | "overlay";
  showXAxisTicks?: boolean;
  timeLabels?: string[];
  hoverIndex?: number | null;
  onHoverIndexChange?: (idx: number | null) => void;
  ariaLabel?: string;
  className?: string;
}

export function ObservabilityChart({
  series,
  height = 88,
  yMax,
  yUnit = "",
  isRateBps = false,
  isRateKbps = false,
  formatValue,
  formatYTick,
  showYAxis = true,
  yAxisPlacement,
  showXAxisTicks = false,
  timeLabels,
  hoverIndex,
  onHoverIndexChange,
  ariaLabel,
  className = "",
}: ObservabilityChartProps): React.JSX.Element {
  const baseId = useId();
  const [wrapRef, totalW] = useMeasuredWidth();
  const [internalHover, setInternalHover] = useState<number | null>(null);

  const activeHover = hoverIndex !== undefined ? hoverIndex : internalHover;
  const setHover = (idx: number | null) => {
    if (hoverIndex === undefined) setInternalHover(idx);
    onHoverIndexChange?.(idx);
  };

  const rateMode: "none" | "bps" | "kbps" =
    isRateBps || yUnit === "B/s"
      ? "bps"
      : isRateKbps || yUnit === "KB/s"
        ? "kbps"
        : "none";

  const pointCount = Math.max(
    2,
    ...series.map((s) => s.data.length),
  );

  const resolvedValueFmt = useMemo(() => {
    if (formatValue) return formatValue;
    if (rateMode === "bps") return formatBytesPerSec;
    if (rateMode === "kbps") return formatRateKbps;
    return (v: number) =>
      `${Number.isInteger(v) ? v : v.toFixed(1)}${yUnit}`;
  }, [formatValue, rateMode, yUnit]);

  const resolvedTickFmt = useMemo(() => {
    if (formatYTick) return formatYTick;
    if (rateMode === "bps") {
      return (v: number) => (v <= 0 ? "0" : formatBytesPerSec(v));
    }
    if (rateMode === "kbps") {
      return (v: number) => (v <= 0 ? "0" : formatRateKbps(v));
    }
    return (v: number) => {
      if (v <= 0) return `0${yUnit}`;
      return `${Number.isInteger(v) ? v : v.toFixed(0)}${yUnit}`;
    };
  }, [formatYTick, rateMode, yUnit]);

  const ceiling = useMemo(() => {
    if (yMax !== undefined && yMax > 0) return yMax;
    let peak = 0;
    for (const s of series) {
      for (const v of s.data) {
        if (Number.isFinite(v) && v > peak) peak = v;
      }
    }
    return computeNiceCeiling(peak, rateMode);
  }, [series, yMax, rateMode]);

  const axisMode =
    yAxisPlacement ?? (height >= 112 && showYAxis ? "left" : "overlay");
  const padLeft = showYAxis && axisMode === "left" ? 56 : 2;
  const padRight = 2;
  const padTop = 6;
  const padBottom = showXAxisTicks ? 18 : 4;

  const svgW = Math.max(80, totalW);
  const plotW = Math.max(32, svgW - padLeft - padRight);
  const plotH = Math.max(24, height - padTop - padBottom);

  const xForIndex = (idx: number) =>
    padLeft + (idx / Math.max(1, pointCount - 1)) * plotW;
  const yForValue = (val: number) => {
    const clamped = Math.max(
      0,
      Math.min(ceiling, Number.isFinite(val) ? val : 0),
    );
    return padTop + plotH - (clamped / ceiling) * plotH;
  };

  const yTop = Math.round(padTop) + 0.5;
  const yMid = Math.round(padTop + plotH * 0.5) + 0.5;
  const yZero = Math.round(padTop + plotH) + 0.5;

  const vGridFractions = [0.25, 0.5, 0.75];

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = e.clientX - rect.left - padLeft;
    const ratio = Math.max(0, Math.min(1, relX / plotW));
    const idx = Math.round(ratio * (pointCount - 1));
    setHover(idx);
  };

  const hoveredX =
    activeHover !== null && activeHover >= 0 && activeHover < pointCount
      ? xForIndex(activeHover)
      : null;

  const xTickLabels = useMemo(() => {
    if (!showXAxisTicks) return null;
    if (timeLabels && timeLabels.length > 0) {
      const lastIdx = timeLabels.length - 1;
      const midIdx = Math.floor(lastIdx / 2);
      return [
        { x: padLeft, text: timeLabels[0] ?? "", align: "start" as const },
        {
          x: padLeft + plotW * 0.5,
          text: timeLabels[midIdx] ?? "",
          align: "middle" as const,
        },
        {
          x: padLeft + plotW,
          text: timeLabels[lastIdx] ?? "现在",
          align: "end" as const,
        },
      ];
    }
    return [
      { x: padLeft, text: "-1m", align: "start" as const },
      { x: padLeft + plotW * 0.5, text: "-30s", align: "middle" as const },
      { x: padLeft + plotW, text: "现在", align: "end" as const },
    ];
  }, [showXAxisTicks, timeLabels, padLeft, plotW]);

  const hoverTimeText = useMemo(() => {
    if (activeHover === null) return "";
    if (timeLabels && timeLabels.length > 0) {
      const mapped =
        timeLabels[Math.min(activeHover, timeLabels.length - 1)] ?? "";
      if (mapped) return mapped;
    }
    const secAgo = (pointCount - 1 - activeHover) * 2;
    return secAgo <= 0 ? "现在" : `-${secAgo}s`;
  }, [activeHover, timeLabels, pointCount]);

  return (
    <div
      ref={wrapRef}
      aria-label={ariaLabel}
      className={`relative block w-full min-w-0 select-none ${className}`}
    >
      <svg
        width={svgW}
        height={height}
        viewBox={`0 0 ${svgW} ${height}`}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHover(null)}
        className="block touch-none overflow-visible"
      >
        <defs>
          {series.map((s, sIdx) => {
            const fillOp = Math.min(0.06, s.fillOpacity ?? 0.05);
            return (
              <linearGradient
                key={s.label + sIdx}
                id={`${baseId}-grad-${sIdx}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor={s.color} stopOpacity={fillOp} />
                <stop offset="100%" stopColor={s.color} stopOpacity={0} />
              </linearGradient>
            );
          })}
        </defs>

        {/* Horizontal Cartesian Gridlines (top, 50%, 0 baseline) */}
        <line
          x1={padLeft}
          y1={yTop}
          x2={padLeft + plotW}
          y2={yTop}
          stroke="var(--border-subtle)"
          strokeWidth={1}
          strokeDasharray="2 3"
        />
        <line
          x1={padLeft}
          y1={yMid}
          x2={padLeft + plotW}
          y2={yMid}
          stroke="var(--border-hairline)"
          strokeWidth={1}
          strokeDasharray="2 3"
        />
        <line
          x1={padLeft}
          y1={yZero}
          x2={padLeft + plotW}
          y2={yZero}
          stroke="var(--border-subtle)"
          strokeWidth={1}
        />

        {/* Vertical Cartesian Gridlines */}
        {vGridFractions.map((frac) => {
          const gx = Math.round(padLeft + plotW * frac) + 0.5;
          return (
            <line
              key={frac}
              x1={gx}
              y1={padTop}
              x2={gx}
              y2={padTop + plotH}
              stroke="var(--border-hairline)"
              strokeWidth={1}
              strokeDasharray="2 3"
            />
          );
        })}

        {/* Series Fills & Crisp 1.25px Angular Polylines */}
        {series.map((s, sIdx) => {
          if (s.data.length === 0) return null;
          const samples =
            s.data.length === 1 ? [s.data[0]!, s.data[0]!] : s.data;
          const len = samples.length;
          const pts = samples.map((v, i) => {
            const x = padLeft + (i / (len - 1)) * plotW;
            const y = yForValue(v);
            return [x, y] as const;
          });
          const linePath = pts
            .map(
              ([x, y], i) =>
                `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`,
            )
            .join(" ");
          const firstX = pts[0]?.[0] ?? padLeft;
          const lastX = pts[pts.length - 1]?.[0] ?? padLeft + plotW;
          const areaPath = `${linePath} L${lastX.toFixed(1)},${(padTop + plotH).toFixed(1)} L${firstX.toFixed(1)},${(padTop + plotH).toFixed(1)} Z`;

          return (
            <g key={s.label + sIdx}>
              {!s.dashed && (
                <path d={areaPath} fill={`url(#${baseId}-grad-${sIdx})`} />
              )}
              <path
                d={linePath}
                fill="none"
                stroke={s.color}
                strokeWidth={1.25}
                strokeDasharray={s.dashed ? "3 2.5" : undefined}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          );
        })}

        {/* Explicit JetBrains Mono Tabular Y-Axis Ticks */}
        {showYAxis && axisMode === "left" && (
          <g
            style={{
              fontFamily: "var(--font-mono)",
              fontVariantNumeric: "tabular-nums",
              fontSize: "10px",
              fill: "var(--text-tertiary)",
            }}
          >
            <text x={padLeft - 6} y={padTop + 3.5} textAnchor="end">
              {resolvedTickFmt(ceiling)}
            </text>
            <text x={padLeft - 6} y={padTop + plotH * 0.5 + 3.5} textAnchor="end">
              {resolvedTickFmt(ceiling * 0.5)}
            </text>
            <text x={padLeft - 6} y={padTop + plotH} textAnchor="end">
              {resolvedTickFmt(0)}
            </text>
          </g>
        )}

        {showYAxis && axisMode === "overlay" && (
          <g
            style={{
              fontFamily: "var(--font-mono)",
              fontVariantNumeric: "tabular-nums",
              fontSize: "9.5px",
              fill: "var(--text-tertiary)",
            }}
            pointerEvents="none"
          >
            <text
              x={padLeft + plotW - 2}
              y={padTop + 9}
              textAnchor="end"
              style={{
                paintOrder: "stroke",
                stroke: "var(--bg-card)",
                strokeWidth: 3,
                strokeLinejoin: "round",
              }}
            >
              {resolvedTickFmt(ceiling)}
            </text>
            {plotH >= 54 && (
              <text
                x={padLeft + plotW - 2}
                y={padTop + plotH * 0.5 - 2}
                textAnchor="end"
                style={{
                  paintOrder: "stroke",
                  stroke: "var(--bg-card)",
                  strokeWidth: 3,
                  strokeLinejoin: "round",
                }}
              >
                {resolvedTickFmt(ceiling * 0.5)}
              </text>
            )}
            <text
              x={padLeft + plotW - 2}
              y={padTop + plotH - 2}
              textAnchor="end"
              style={{
                paintOrder: "stroke",
                stroke: "var(--bg-card)",
                strokeWidth: 3,
                strokeLinejoin: "round",
              }}
            >
              {resolvedTickFmt(0)}
            </text>
          </g>
        )}

        {/* X-Axis Time Ticks */}
        {xTickLabels && (
          <g
            style={{
              fontFamily: "var(--font-mono)",
              fontVariantNumeric: "tabular-nums",
              fontSize: "10px",
              fill: "var(--text-tertiary)",
            }}
            pointerEvents="none"
          >
            {xTickLabels.map((tk, i) => (
              <text key={i} x={tk.x} y={height - 3} textAnchor={tk.align}>
                {tk.text}
              </text>
            ))}
          </g>
        )}

        {/* Interactive Hover Vertical Crosshair & Sample Dots */}
        {hoveredX !== null && activeHover !== null && (
          <g pointerEvents="none">
            <line
              x1={Math.round(hoveredX) + 0.5}
              y1={padTop}
              x2={Math.round(hoveredX) + 0.5}
              y2={padTop + plotH}
              stroke="var(--text-tertiary)"
              strokeWidth={1}
              strokeDasharray="2 2"
            />
            {series.map((s, sIdx) => {
              if (s.data.length === 0) return null;
              const val = s.data[Math.min(activeHover, s.data.length - 1)];
              if (val === undefined) return null;
              return (
                <circle
                  key={s.label + sIdx}
                  cx={hoveredX}
                  cy={yForValue(val)}
                  r={3}
                  fill={s.color}
                  stroke="var(--bg-card)"
                  strokeWidth={1.5}
                />
              );
            })}
          </g>
        )}
      </svg>

      {/* Floating Exact Value Readout on Hover */}
      {hoveredX !== null && activeHover !== null && (
        <div
          style={{
            backgroundColor: "var(--bg-sheet)",
            border: "1px solid var(--border-subtle)",
            boxShadow: "0 2px 8px rgba(24,24,27,0.08)",
            left:
              hoveredX > svgW * 0.58
                ? Math.max(padLeft, hoveredX - 8)
                : Math.min(svgW - 8, hoveredX + 8),
            transform:
              hoveredX > svgW * 0.58 ? "translateX(-100%)" : "translateX(0)",
          }}
          className="font-mono-num pointer-events-none absolute top-1 z-10 flex items-center gap-2 rounded-[6px] px-2 py-0.5 text-[10.5px] leading-tight whitespace-nowrap"
        >
          {series.map((s, sIdx) => {
            const val = s.data[Math.min(activeHover, Math.max(0, s.data.length - 1))] ?? 0;
            return (
              <span
                key={s.label + sIdx}
                className="inline-flex items-center gap-1 font-medium"
              >
                <span
                  style={{ backgroundColor: s.color }}
                  className="inline-block h-1.5 w-1.5 rounded-full"
                />
                <span style={{ color: "var(--text-secondary)" }}>{s.label}</span>
                <span style={{ color: "var(--text-primary)" }}>
                  {resolvedValueFmt(val)}
                </span>
              </span>
            );
          })}
          <span style={{ color: "var(--text-tertiary)" }}>{hoverTimeText}</span>
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * 6. MetricBar
 * ============================================================================ */
export interface MetricBarProps {
  valuePct: number;
  label?: string;
  valueLabel?: string;
  warnAt?: number;
  dangerAt?: number;
  recoveryMarkerPct?: number;
  toneOverride?: "accent" | "ok" | "warn" | "danger" | "ink" | "muted";
  thickness?: 3 | 4 | 6;
  className?: string;
}

export function MetricBar({
  valuePct,
  label,
  valueLabel,
  warnAt = 75,
  dangerAt = 88,
  toneOverride,
  thickness = 3,
  className = "",
}: MetricBarProps): React.JSX.Element {
  const clamped = Math.max(0, Math.min(100, valuePct));
  const isMuted = toneOverride === "muted";

  let fillColor = "var(--ink-primary)";
  if (toneOverride === "muted") fillColor = "var(--text-muted)";
  else if (toneOverride === "accent") fillColor = "var(--accent)";
  else if (toneOverride === "ok") fillColor = "var(--status-ok)";
  else if (toneOverride === "warn") fillColor = "var(--status-warn)";
  else if (toneOverride === "danger") fillColor = "var(--status-danger)";
  else if (toneOverride === "ink") fillColor = "var(--ink-primary)";
  else if (clamped >= dangerAt) fillColor = "var(--status-danger)";
  else if (clamped >= warnAt) fillColor = "var(--status-warn)";
  else fillColor = "var(--accent)";

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      {(label || valueLabel) && (
        <div className="flex items-center justify-between gap-2 text-[12px] leading-none">
          {label && (
            <span
              style={{
                color: isMuted ? "var(--text-muted)" : "var(--text-tertiary)",
              }}
            >
              {label}
            </span>
          )}
          {valueLabel && (
            <span
              style={{
                color: isMuted ? "var(--text-tertiary)" : "var(--text-primary)",
              }}
              className="font-mono-num font-medium"
            >
              {valueLabel}
            </span>
          )}
        </div>
      )}
      <div
        role={label ? "meter" : undefined}
        aria-label={label}
        aria-valuemin={label ? 0 : undefined}
        aria-valuemax={label ? 100 : undefined}
        aria-valuenow={label ? Math.round(clamped) : undefined}
        aria-valuetext={label && valueLabel ? valueLabel : undefined}
        style={{
          height: thickness,
          backgroundColor: "var(--bg-muted)",
        }}
        className="relative w-full overflow-hidden rounded-full"
      >
        <div
          style={{
            width: `${clamped}%`,
            backgroundColor: fillColor,
            opacity: isMuted ? 0.55 : 1,
          }}
          className="h-full rounded-full transition-[width] duration-300 ease-out"
        />
      </div>
    </div>
  );
}

/* ============================================================================
 * 7. Card
 * ============================================================================ */
export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
  padded?: boolean;
}

export function Card({
  interactive = false,
  padded = true,
  className = "",
  children,
  ...rest
}: CardProps): React.JSX.Element {
  return (
    <div
      className={`atelier-card ${interactive ? "atelier-card-interactive cursor-pointer" : ""} ${
        padded ? "p-5" : ""
      } ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

/* ============================================================================
 * 8. Kbd
 * ============================================================================ */
export function Kbd({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <kbd
      style={{
        backgroundColor: "var(--bg-subtle)",
        color: "var(--text-tertiary)",
        border: "1px solid var(--border-subtle)",
        boxShadow: "0 1px 0 var(--border-hairline)",
      }}
      className={`inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] px-1 font-mono text-[10.5px] leading-none font-medium select-none ${className}`}
    >
      {children}
    </kbd>
  );
}

/* ============================================================================
 * 9. Switch
 * ============================================================================ */
export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
}

export function Switch({
  checked,
  onChange,
  ariaLabel,
  disabled = false,
}: SwitchProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        backgroundColor: checked ? "var(--ink-primary)" : "var(--bg-muted)",
        border: "1px solid var(--border-subtle)",
      }}
      className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45"
    >
      <span
        style={{
          backgroundColor: checked
            ? "var(--ink-on-primary)"
            : "var(--bg-sheet)",
          transform: checked ? "translateX(15px)" : "translateX(0)",
        }}
        className="inline-block h-3.5 w-3.5 rounded-full shadow-xs transition-transform duration-150"
      />
    </button>
  );
}

/* ============================================================================
 * 10. SectionHeader
 * ============================================================================ */
export interface SectionHeaderProps {
  eyebrow?: string;
  title: string;
  description?: string;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export function SectionHeader({
  title,
  badge,
  actions,
  className = "",
}: SectionHeaderProps): React.JSX.Element {
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 ${className}`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2.5">
        <h2
          style={{ color: "var(--text-primary)" }}
          className="text-[18px] leading-snug font-semibold tracking-[-0.015em]"
        >
          {title}
        </h2>
        {badge}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

/* ============================================================================
 * 11. TabBar
 * ============================================================================ */
export interface TabItem<T extends string> {
  id: T;
  label: string;
  icon?: React.ReactNode;
  count?: string | number;
}

export interface TabBarProps<T extends string> {
  tabs: TabItem<T>[];
  activeTab: T;
  onChange: (tab: T) => void;
  ariaLabel: string;
  className?: string;
}

export function TabBar<T extends string>({
  tabs,
  activeTab,
  onChange,
  ariaLabel,
  className = "",
}: TabBarProps<T>): React.JSX.Element {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const handleKeyDown = (e: React.KeyboardEvent, idx: number) => {
    let nextIdx: number | null = null;
    if (e.key === "ArrowRight") nextIdx = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft")
      nextIdx = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = tabs.length - 1;

    if (nextIdx !== null) {
      e.preventDefault();
      const target = tabs[nextIdx];
      if (target) {
        onChange(target.id);
        tabRefs.current[nextIdx]?.focus();
      }
    }
  };

  return (
    <div role="tablist" aria-label={ariaLabel} className={`uniob-tablist ${className}`}>
      {tabs.map((tab, idx) => {
        const selected = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              tabRefs.current[idx] = el;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
            className="uniob-tab"
          >
            {tab.icon && <span className="inline-flex shrink-0">{tab.icon}</span>}
            <span>{tab.label}</span>
            {tab.count !== undefined && (
              <span
                style={{
                  backgroundColor: selected
                    ? "var(--accent-soft)"
                    : "var(--bg-muted)",
                  color: selected ? "var(--accent-ink)" : "var(--text-tertiary)",
                }}
                className="font-mono-num rounded-[5px] px-1.5 py-0.5 text-[10.5px] leading-none"
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ============================================================================
 * 12. CopyButton & IconCloseButton
 * ============================================================================ */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback below for HTTP origins
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({
  value,
  label = "复制",
  copiedLabel = "已复制",
  onCopied,
  className = "",
}: {
  value: string;
  label?: string;
  copiedLabel?: string;
  onCopied?: () => void;
  className?: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await copyTextToClipboard(value);
    setCopied(true);
    onCopied?.();
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      style={{
        backgroundColor: copied ? "var(--status-ok-bg)" : "var(--bg-subtle)",
        color: copied ? "var(--status-ok-ink)" : "var(--text-secondary)",
        border: `1px solid ${copied ? "var(--status-ok-border)" : "var(--border-subtle)"}`,
      }}
      className={`inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-[6px] px-2 text-[11.5px] font-medium whitespace-nowrap transition-colors duration-150 ${className}`}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <Copy className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      )}
      <span>{copied ? copiedLabel : label}</span>
    </button>
  );
}

export function IconCloseButton({
  onClick,
  ariaLabel = "关闭",
}: {
  onClick: () => void;
  ariaLabel?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      style={{ color: "var(--text-tertiary)" }}
      className="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-[7px] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
    >
      <X className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}

/* ============================================================================
 * 13. GroupCombobox · Top-Layer Editable Group Selector
 * Replaces native <datalist> to avoid empty-datalist dead arrows, prefilled
 * value filtering traps, and <dialog> top-layer popup dismissal bugs.
 * ============================================================================ */
const PRESET_GROUP_SUGGESTIONS = [
  "亚太节点",
  "欧美节点",
  "港澳台",
  "国内节点",
  "边缘节点",
] as const;

export interface GroupComboboxProps {
  id: string;
  name?: string;
  value: string;
  onChange: (next: string) => void;
  existingGroups: string[];
  placeholder?: string;
}

interface GroupOptionItem {
  value: string;
  label: string;
  kind: "existing" | "preset" | "custom";
}

export function GroupCombobox({
  id,
  name = "group_name",
  value,
  onChange,
  existingGroups,
  placeholder = "例如：亚太节点",
}: GroupComboboxProps): React.JSX.Element {
  const listboxId = useId();
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const pointerInPopoverRef = useRef(false);

  const [menuOpen, setMenuOpen] = useState(false);
  const [filterByInput, setFilterByInput] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const supportsPopover =
    typeof HTMLElement !== "undefined" &&
    typeof HTMLElement.prototype.showPopover === "function";

  const baseOptions = useMemo<GroupOptionItem[]>(() => {
    const seen = new Set<string>();
    const list: GroupOptionItem[] = [];
    for (const raw of existingGroups) {
      const trimmed = raw.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      list.push({ value: trimmed, label: trimmed, kind: "existing" });
    }
    for (const preset of PRESET_GROUP_SUGGESTIONS) {
      if (seen.has(preset)) continue;
      seen.add(preset);
      list.push({ value: preset, label: preset, kind: "preset" });
    }
    return list;
  }, [existingGroups]);

  const items = useMemo<GroupOptionItem[]>(() => {
    const trimmed = value.trim();
    const q = trimmed.toLowerCase();
    if (!filterByInput || !q) {
      return baseOptions;
    }
    const matched = baseOptions.filter((opt) =>
      opt.label.toLowerCase().includes(q),
    );
    const hasExact = baseOptions.some((opt) => opt.value.toLowerCase() === q);
    if (!hasExact) {
      return [{ value: trimmed, label: trimmed, kind: "custom" }, ...matched];
    }
    return matched;
  }, [baseOptions, filterByInput, value]);

  const showPopoverMenu = menuOpen && items.length > 0;

  useLayoutEffect(() => {
    const popoverEl = popoverRef.current;
    const anchorEl = anchorRef.current;
    if (!popoverEl || !anchorEl || !showPopoverMenu) return;

    const reposition = () => {
      if (supportsPopover && !popoverEl.matches(":popover-open")) {
        try {
          popoverEl.showPopover();
        } catch {
          // Ignore if element is not yet connected
        }
      }
      if (!supportsPopover) return;

      const rect = anchorEl.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) return;

      popoverEl.style.width = `${rect.width}px`;
      const clampedLeft = Math.max(
        8,
        Math.min(window.innerWidth - rect.width - 8, rect.left),
      );
      popoverEl.style.left = `${clampedLeft}px`;

      const menuHeight = popoverEl.offsetHeight || 180;
      const spaceBelow = window.innerHeight - rect.bottom - 12;
      const spaceAbove = rect.top - 12;
      if (spaceBelow < menuHeight && spaceAbove > spaceBelow) {
        popoverEl.style.top = `${Math.max(8, rect.top - menuHeight - 4)}px`;
      } else {
        popoverEl.style.top = `${rect.bottom + 4}px`;
      }
    };

    reposition();

    const handleScroll = (event: Event) => {
      if (
        event.target instanceof Node &&
        popoverEl.contains(event.target)
      ) {
        return;
      }
      reposition();
    };

    const parentDialog = anchorEl.closest("dialog");
    const handleDialogClose = () => setMenuOpen(false);

    window.addEventListener("resize", reposition);
    document.addEventListener("scroll", handleScroll, true);
    parentDialog?.addEventListener("transitionend", reposition);
    parentDialog?.addEventListener("close", handleDialogClose);

    return () => {
      window.removeEventListener("resize", reposition);
      document.removeEventListener("scroll", handleScroll, true);
      parentDialog?.removeEventListener("transitionend", reposition);
      parentDialog?.removeEventListener("close", handleDialogClose);
      if (supportsPopover && popoverEl.matches(":popover-open")) {
        try {
          popoverEl.hidePopover();
        } catch {
          // Ignore if already closed
        }
      }
    };
  }, [showPopoverMenu, items.length, supportsPopover]);

  useEffect(() => {
    if (!menuOpen) return;
    const handleOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (
        anchorRef.current?.contains(target) ||
        popoverRef.current?.contains(target)
      ) {
        return;
      }
      setMenuOpen(false);
      setActiveIndex(-1);
    };
    document.addEventListener("pointerdown", handleOutsidePointerDown, true);
    return () => {
      document.removeEventListener(
        "pointerdown",
        handleOutsidePointerDown,
        true,
      );
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!showPopoverMenu || activeIndex < 0) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, showPopoverMenu]);

  const selectOption = (nextVal: string) => {
    onChange(nextVal);
    setMenuOpen(false);
    setFilterByInput(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!menuOpen) {
        setFilterByInput(false);
        setMenuOpen(true);
        setActiveIndex(0);
      } else if (items.length > 0) {
        setActiveIndex((prev) => (prev + 1) % items.length);
      }
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!menuOpen) {
        setFilterByInput(false);
        setMenuOpen(true);
        setActiveIndex(Math.max(0, items.length - 1));
      } else if (items.length > 0) {
        setActiveIndex((prev) => (prev <= 0 ? items.length - 1 : prev - 1));
      }
      return;
    }

    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      if (showPopoverMenu && activeIndex >= 0 && items[activeIndex]) {
        e.preventDefault();
        selectOption(items[activeIndex].value);
      }
      return;
    }

    if (e.key === "Escape" && menuOpen) {
      e.preventDefault();
      e.stopPropagation();
      setMenuOpen(false);
      setActiveIndex(-1);
      return;
    }

    if (e.key === "Tab" && menuOpen) {
      setMenuOpen(false);
      setActiveIndex(-1);
    }
  };

  const hasValue = value.length > 0;
  const activeOptionId =
    showPopoverMenu && activeIndex >= 0 && items[activeIndex]
      ? `${listboxId}-opt-${activeIndex}`
      : undefined;

  return (
    <div ref={anchorRef} className="relative">
      <input
        ref={inputRef}
        id={id}
        name={name}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showPopoverMenu}
        aria-controls={listboxId}
        aria-activedescendant={activeOptionId}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onClick={() => {
          if (!menuOpen) {
            setFilterByInput(false);
            setActiveIndex(-1);
            setMenuOpen(true);
          }
        }}
        onChange={(e) => {
          onChange(e.target.value);
          setFilterByInput(true);
          setActiveIndex(-1);
          setMenuOpen(true);
        }}
        onKeyDown={handleKeyDown}
        onBlur={(e) => {
          if (pointerInPopoverRef.current) return;
          const nextFocused = e.relatedTarget as Node | null;
          if (
            nextFocused &&
            (anchorRef.current?.contains(nextFocused) ||
              popoverRef.current?.contains(nextFocused))
          ) {
            return;
          }
          setMenuOpen(false);
          setActiveIndex(-1);
        }}
        style={{
          backgroundColor: "var(--bg-subtle)",
          color: "var(--text-primary)",
          border: "1px solid var(--border-subtle)",
        }}
        className={`h-9 w-full rounded-[8px] pl-3 text-[13px] outline-none ${
          hasValue ? "pr-13" : "pr-8"
        }`}
      />

      <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
        {hasValue && (
          <button
            type="button"
            tabIndex={-1}
            aria-label="清空分组"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onChange("");
              setFilterByInput(false);
              setActiveIndex(-1);
              setMenuOpen(true);
              inputRef.current?.focus();
            }}
            style={{ color: "var(--text-tertiary)" }}
            className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-[5px] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          tabIndex={-1}
          aria-label={showPopoverMenu ? "收起分组列表" : "展开分组列表"}
          aria-expanded={showPopoverMenu}
          aria-controls={listboxId}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (menuOpen) {
              setMenuOpen(false);
              setActiveIndex(-1);
            } else {
              setFilterByInput(false);
              setActiveIndex(-1);
              setMenuOpen(true);
            }
            inputRef.current?.focus();
          }}
          style={{ color: "var(--text-tertiary)" }}
          className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-[5px] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform duration-150 ${
              showPopoverMenu ? "rotate-180" : ""
            }`}
            aria-hidden="true"
          />
        </button>
      </div>

      {showPopoverMenu && (
        <div
          ref={popoverRef}
          id={listboxId}
          role="listbox"
          aria-label="分组选项"
          {...(supportsPopover ? { popover: "manual" } : {})}
          onPointerDown={() => {
            pointerInPopoverRef.current = true;
            window.requestAnimationFrame(() => {
              pointerInPopoverRef.current = false;
            });
          }}
          style={{
            backgroundColor: "var(--bg-sheet)",
            border: "1px solid var(--border-subtle)",
            boxShadow: "var(--shadow-popover)",
            color: "var(--text-primary)",
          }}
          className={`${
            supportsPopover
              ? "fixed inset-auto m-0"
              : "absolute top-[calc(100%+4px)] right-0 left-0 z-50"
          } max-h-[212px] overflow-y-auto rounded-[10px] p-1 text-[12.5px]`}
        >
          {items.map((item, idx) => {
            const selected =
              item.kind !== "custom" && value.trim() === item.value;
            const active = idx === activeIndex;
            return (
              <div
                key={`${item.kind}:${item.value}`}
                ref={(el) => {
                  optionRefs.current[idx] = el;
                }}
                id={`${listboxId}-opt-${idx}`}
                role="option"
                aria-selected={selected}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => selectOption(item.value)}
                style={{
                  backgroundColor: active
                    ? "var(--bg-hover)"
                    : selected
                      ? "var(--accent-soft)"
                      : "transparent",
                  color: selected
                    ? "var(--accent-ink)"
                    : "var(--text-primary)",
                }}
                className="flex cursor-pointer items-center justify-between gap-2 rounded-[7px] px-2.5 py-1.5 transition-colors select-none"
              >
                <span className="truncate font-medium">
                  {item.kind === "custom"
                    ? `使用新分组 “${item.label}”`
                    : item.label}
                </span>
                <span className="inline-flex shrink-0 items-center gap-1.5">
                  {item.kind === "existing" && !selected && (
                    <span
                      style={{ color: "var(--text-tertiary)" }}
                      className="text-[11px]"
                    >
                      已有
                    </span>
                  )}
                  {item.kind === "custom" && (
                    <span
                      style={{ color: "var(--accent-ink)" }}
                      className="text-[11px] font-medium"
                    >
                      新建
                    </span>
                  )}
                  {selected && (
                    <Check
                      style={{ color: "var(--accent-ink)" }}
                      className="h-3.5 w-3.5"
                      aria-hidden="true"
                    />
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
