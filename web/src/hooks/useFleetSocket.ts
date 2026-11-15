import { useCallback, useEffect, useRef, useState } from "react";
import { mergeMetricsNetworkState } from "../utils/networkQuality";
import type {
  FleetTickData,
  HardwarePatch,
  NodeMetricsSnapshot,
  NodeSummary,
  ProcEntry,
  WsInboundMessage,
  WsOutboundMessage,
} from "../types";

export type WsConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export interface LiveMetricSample {
  ts: number;
  metrics: NodeMetricsSnapshot;
}

export interface ProcsPacket {
  nodeId: string;
  ts: number;
  procs: ProcEntry[];
}

interface UseFleetSocketOptions {
  enabled: boolean;
  fleetActive: boolean;
  onNodesUpdater: (updater: (prev: NodeSummary[]) => NodeSummary[]) => void;
  onActiveAlertsChange: (count: number) => void;
  onAlertEvent?: () => void;
}

const MAX_LIVE_POINTS = 180;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 25000;
const LEASE_RENEW_INTERVAL_MS = 50000;
const ACTIVITY_RESET_THROTTLE_MS = 5000;

function mergeHardware(node: NodeSummary, hw?: HardwarePatch): NodeSummary {
  if (!hw) return node;
  return {
    ...node,
    hostname: hw.hostname ?? node.hostname,
    os: hw.os ?? node.os,
    kernel: hw.kernel ?? node.kernel,
    arch: hw.arch ?? node.arch,
    cpu_model: hw.cpu_model ?? node.cpu_model,
    cpu_cores: hw.cpu_cores ?? node.cpu_cores,
    mem_total: hw.mem_total ?? node.mem_total,
    swap_total: hw.swap_total ?? node.swap_total,
    agent_version: hw.agent_version ?? hw.agent_ver ?? node.agent_version,
    caps: Array.isArray(hw.caps) ? hw.caps : node.caps,
    proc_enabled:
      typeof hw.proc_enabled === "boolean" ? hw.proc_enabled : node.proc_enabled,
  };
}

function applyFleetTicks(
  prev: NodeSummary[],
  ticks: FleetTickData[],
): NodeSummary[] {
  if (ticks.length === 0) return prev;
  const byId = new Map<string, FleetTickData>();
  for (const tick of ticks) {
    if (!tick || typeof tick.nodeId !== "string") continue;
    const existing = byId.get(tick.nodeId);
    if (!existing) {
      byId.set(tick.nodeId, tick);
    } else {
      byId.set(tick.nodeId, {
        ...existing,
        ...tick,
        hardware: tick.hardware
          ? { ...existing.hardware, ...tick.hardware }
          : existing.hardware,
        caps: tick.caps ?? existing.caps,
        auto_update_override:
          tick.auto_update_override !== undefined
            ? tick.auto_update_override
            : existing.auto_update_override,
        update_status:
          tick.update_status !== undefined
            ? tick.update_status
            : existing.update_status,
        traffic: tick.traffic ?? existing.traffic,
        metrics: mergeMetricsNetworkState(existing.metrics, tick.metrics),
      });
    }
  }
  if (byId.size === 0) return prev;

  let changed = false;
  const next = prev.map((node) => {
    const tick = byId.get(node.id);
    if (!tick) return node;
    changed = true;
    const patched = mergeHardware(node, tick.hardware);
    return {
      ...patched,
      online: tick.online,
      last_seen_ts: tick.last_seen_ts,
      caps: Array.isArray(tick.caps) ? tick.caps : patched.caps,
      auto_update_override:
        tick.auto_update_override !== undefined
          ? tick.auto_update_override
          : patched.auto_update_override,
      update_status:
        tick.update_status !== undefined
          ? tick.update_status
          : patched.update_status,
      traffic: tick.traffic ?? patched.traffic,
      metrics: mergeMetricsNetworkState(patched.metrics, tick.metrics),
    };
  });
  return changed ? next : prev;
}

function isDocumentVisible(): boolean {
  if (typeof document === "undefined") return true;
  return !document.hidden && document.visibilityState === "visible";
}

export function useFleetSocket({
  enabled,
  fleetActive,
  onNodesUpdater,
  onActiveAlertsChange,
  onAlertEvent,
}: UseFleetSocketOptions) {
  const [wsStatus, setWsStatus] = useState<WsConnectionStatus>(
    enabled ? "connecting" : "disconnected",
  );
  const [liveSeriesByNode, setLiveSeriesByNode] = useState<
    Record<string, LiveMetricSample[]>
  >({});
  const [procsPacket, setProcsPacket] = useState<ProcsPacket | null>(null);
  const [liveNodeId, setLiveNodeId] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const activeNodeSubRef = useRef<{ nodeId: string; proc: boolean } | null>(null);
  const attemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const heartbeatTimerRef = useRef<number | null>(null);
  const renewTimerRef = useRef<number | null>(null);
  const idleTimerRef = useRef<number | null>(null);

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const fleetActiveRef = useRef(fleetActive);
  fleetActiveRef.current = fleetActive;
  const isVisibleRef = useRef(isDocumentVisible());
  const isIdleRef = useRef(false);
  const fleetSubscribedRef = useRef(false);
  const lastActivityResetAtRef = useRef(0);

  const reconnectIfNeededRef = useRef<() => void>(() => {});
  const syncHeartbeatRef = useRef<() => void>(() => {});
  const syncLeaseRenewRef = useRef<() => void>(() => {});

  const onNodesUpdaterRef = useRef(onNodesUpdater);
  onNodesUpdaterRef.current = onNodesUpdater;
  const onActiveAlertsChangeRef = useRef(onActiveAlertsChange);
  onActiveAlertsChangeRef.current = onActiveAlertsChange;
  const onAlertEventRef = useRef(onAlertEvent);
  onAlertEventRef.current = onAlertEvent;

  const sendMessage = useCallback((msg: WsOutboundMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const syncFleetSubscription = useCallback(() => {
    const want =
      enabledRef.current &&
      fleetActiveRef.current &&
      isVisibleRef.current &&
      !isIdleRef.current;

    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      fleetSubscribedRef.current = false;
      syncLeaseRenewRef.current();
      return;
    }

    if (want && !fleetSubscribedRef.current) {
      ws.send(JSON.stringify({ op: "sub_fleet" } satisfies WsOutboundMessage));
      fleetSubscribedRef.current = true;
    } else if (!want && fleetSubscribedRef.current) {
      ws.send(JSON.stringify({ op: "unsub_fleet" } satisfies WsOutboundMessage));
      fleetSubscribedRef.current = false;
    }
    syncLeaseRenewRef.current();
  }, []);

  const resyncActiveNodeSubscription = useCallback(() => {
    const ws = wsRef.current;
    const activeNode = activeNodeSubRef.current;
    if (
      ws &&
      ws.readyState === WebSocket.OPEN &&
      activeNode &&
      isVisibleRef.current &&
      !isIdleRef.current
    ) {
      ws.send(
        JSON.stringify({
          op: "sub_node",
          nodeId: activeNode.nodeId,
          proc: activeNode.proc,
        } satisfies WsOutboundMessage),
      );
    }
  }, []);

  const resetIdleTimer = useCallback(
    (force = false) => {
      if (!enabledRef.current) return;
      const now = Date.now();
      const wasIdle = isIdleRef.current;
      if (
        !force &&
        !wasIdle &&
        idleTimerRef.current !== null &&
        now - lastActivityResetAtRef.current < ACTIVITY_RESET_THROTTLE_MS
      ) {
        return;
      }

      lastActivityResetAtRef.current = now;
      isIdleRef.current = false;

      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
      }
      idleTimerRef.current = window.setTimeout(() => {
        idleTimerRef.current = null;
        isIdleRef.current = true;
        syncFleetSubscription();
        syncHeartbeatRef.current();
        syncLeaseRenewRef.current();
      }, IDLE_TIMEOUT_MS);

      if (wasIdle) {
        reconnectIfNeededRef.current();
        syncFleetSubscription();
        resyncActiveNodeSubscription();
        syncHeartbeatRef.current();
        syncLeaseRenewRef.current();
      }
    },
    [resyncActiveNodeSubscription, syncFleetSubscription],
  );

  const subNode = useCallback(
    (nodeId: string, proc: boolean) => {
      const prev = activeNodeSubRef.current;
      if (prev && prev.nodeId === nodeId && prev.proc === proc) {
        return;
      }
      activeNodeSubRef.current = { nodeId, proc };
      if (!proc) {
        setProcsPacket((cur) => (cur?.nodeId === nodeId ? null : cur));
      }
      sendMessage({ op: "sub_node", nodeId, proc });
      syncLeaseRenewRef.current();
    },
    [sendMessage],
  );

  const unsubNode = useCallback(
    (nodeId: string) => {
      const prev = activeNodeSubRef.current;
      if (prev && prev.nodeId === nodeId) {
        activeNodeSubRef.current = null;
      }
      setProcsPacket((cur) => (cur?.nodeId === nodeId ? null : cur));
      sendMessage({ op: "unsub_node", nodeId });
      syncLeaseRenewRef.current();
    },
    [sendMessage],
  );

  const seedLiveSeries = useCallback(
    (nodeId: string, metrics: NodeMetricsSnapshot | null) => {
      if (!metrics) return;
      setLiveSeriesByNode((prev) => {
        const existing = prev[nodeId] ?? [];
        if (existing.some((p) => p.ts === metrics.ts)) return prev;
        const next = [...existing, { ts: metrics.ts, metrics }]
          .sort((a, b) => a.ts - b.ts)
          .slice(-MAX_LIVE_POINTS);
        return { ...prev, [nodeId]: next };
      });
    },
    [],
  );

  useEffect(() => {
    fleetActiveRef.current = fleetActive;
    if (fleetActive && isVisibleRef.current) {
      resetIdleTimer(true);
    }
    syncFleetSubscription();
    syncHeartbeatRef.current();
    syncLeaseRenewRef.current();
  }, [fleetActive, resetIdleTimer, syncFleetSubscription]);

  useEffect(() => {
    if (!enabled) {
      fleetSubscribedRef.current = false;
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      setWsStatus("disconnected");
      setLiveNodeId(null);
      return;
    }

    let disposed = false;
    isVisibleRef.current = isDocumentVisible();
    isIdleRef.current = false;

    const clearHeartbeat = () => {
      if (heartbeatTimerRef.current !== null) {
        window.clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
    };

    const clearLeaseRenew = () => {
      if (renewTimerRef.current !== null) {
        window.clearInterval(renewTimerRef.current);
        renewTimerRef.current = null;
      }
    };

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const clearTimers = () => {
      clearReconnectTimer();
      clearHeartbeat();
      clearLeaseRenew();
    };

    const syncHeartbeat = () => {
      const ws = wsRef.current;
      const shouldPulse =
        !disposed &&
        Boolean(ws && ws.readyState === WebSocket.OPEN) &&
        isVisibleRef.current &&
        !isIdleRef.current;

      if (!shouldPulse) {
        clearHeartbeat();
        return;
      }
      if (heartbeatTimerRef.current !== null) return;
      heartbeatTimerRef.current = window.setInterval(() => {
        const cur = wsRef.current;
        if (
          cur &&
          cur.readyState === WebSocket.OPEN &&
          isVisibleRef.current &&
          !isIdleRef.current
        ) {
          cur.send(JSON.stringify({ op: "ping" } satisfies WsOutboundMessage));
        }
      }, HEARTBEAT_INTERVAL_MS);
    };
    syncHeartbeatRef.current = syncHeartbeat;

    const syncLeaseRenew = () => {
      const ws = wsRef.current;
      const hasActiveSub =
        fleetSubscribedRef.current || activeNodeSubRef.current !== null;
      const shouldRenew =
        !disposed &&
        Boolean(ws && ws.readyState === WebSocket.OPEN) &&
        isVisibleRef.current &&
        !isIdleRef.current &&
        hasActiveSub;
      setLiveNodeId(shouldRenew ? activeNodeSubRef.current?.nodeId ?? null : null);

      if (!shouldRenew) {
        clearLeaseRenew();
        return;
      }
      if (renewTimerRef.current !== null) return;
      renewTimerRef.current = window.setInterval(() => {
        const cur = wsRef.current;
        if (
          cur &&
          cur.readyState === WebSocket.OPEN &&
          isVisibleRef.current &&
          !isIdleRef.current &&
          (fleetSubscribedRef.current || activeNodeSubRef.current !== null)
        ) {
          cur.send(JSON.stringify({ op: "renew" } satisfies WsOutboundMessage));
        }
      }, LEASE_RENEW_INTERVAL_MS);
    };
    syncLeaseRenewRef.current = syncLeaseRenew;

    const connect = () => {
      if (disposed) return;
      clearTimers();
      fleetSubscribedRef.current = false;
      setWsStatus(attemptRef.current === 0 ? "connecting" : "reconnecting");

      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${window.location.host}/api/client/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) {
          ws.close();
          return;
        }
        attemptRef.current = 0;
        fleetSubscribedRef.current = false;
        setWsStatus("connected");
        syncFleetSubscription();
        if (activeNodeSubRef.current) {
          ws.send(
            JSON.stringify({
              op: "sub_node",
              nodeId: activeNodeSubRef.current.nodeId,
              proc: activeNodeSubRef.current.proc,
            } satisfies WsOutboundMessage),
          );
        }
        syncHeartbeat();
        syncLeaseRenew();
      };

      ws.onmessage = (event) => {
        if (disposed || typeof event.data !== "string") return;
        let msg: WsInboundMessage;
        try {
          msg = JSON.parse(event.data) as WsInboundMessage;
        } catch {
          return;
        }

        switch (msg.t) {
          case "fleet_tick": {
            onNodesUpdaterRef.current((prev) => applyFleetTicks(prev, [msg]));
            break;
          }
          case "fleet_batch": {
            if (Array.isArray(msg.ticks) && msg.ticks.length > 0) {
              onNodesUpdaterRef.current((prev) =>
                applyFleetTicks(prev, msg.ticks),
              );
            }
            break;
          }
          case "node_detail": {
            onNodesUpdaterRef.current((prev) =>
              prev.map((node) =>
                node.id === msg.nodeId
                  ? {
                      ...node,
                      online: msg.online,
                      last_seen_ts: msg.ts,
                      metrics: mergeMetricsNetworkState(node.metrics, msg.metrics),
                    }
                  : node,
              ),
            );
            if (msg.metrics) {
              setLiveSeriesByNode((prev) => {
                const list = prev[msg.nodeId] ?? [];
                if (list.length > 0 && list[list.length - 1].ts === msg.ts) {
                  return prev;
                }
                const next = [...list, { ts: msg.ts, metrics: msg.metrics }].slice(
                  -MAX_LIVE_POINTS,
                );
                return { ...prev, [msg.nodeId]: next };
              });
            }
            if (Array.isArray(msg.procs)) {
              setProcsPacket({
                nodeId: msg.nodeId,
                ts: msg.ts,
                procs: msg.procs,
              });
            }
            break;
          }
          case "node_offline": {
            onNodesUpdaterRef.current((prev) =>
              prev.map((node) =>
                node.id === msg.nodeId
                  ? {
                      ...node,
                      online: false,
                      last_seen_ts: msg.last_seen_ts ?? node.last_seen_ts,
                    }
                  : node,
              ),
            );
            break;
          }
          case "alert_change": {
            if (typeof msg.activeAlertsCount === "number") {
              onActiveAlertsChangeRef.current(msg.activeAlertsCount);
            }
            onAlertEventRef.current?.();
            break;
          }
          case "pong":
            break;
        }
      };

      ws.onerror = () => {
        // onclose handles reconnect
      };

      ws.onclose = () => {
        clearHeartbeat();
        clearLeaseRenew();
        fleetSubscribedRef.current = false;
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
        if (disposed) return;
        setWsStatus("reconnecting");
        setLiveNodeId(null);
        if (!isVisibleRef.current || isIdleRef.current) {
          return;
        }
        const idx = Math.min(attemptRef.current, RECONNECT_DELAYS_MS.length - 1);
        const baseDelay = RECONNECT_DELAYS_MS[idx];
        const jitter = baseDelay * (0.85 + Math.random() * 0.3);
        attemptRef.current += 1;
        reconnectTimerRef.current = window.setTimeout(connect, Math.round(jitter));
      };
    };

    const reconnectIfNeeded = () => {
      if (disposed || !enabledRef.current) return;
      const cur = wsRef.current;
      if (
        !cur ||
        cur.readyState === WebSocket.CLOSED ||
        cur.readyState === WebSocket.CLOSING
      ) {
        attemptRef.current = 0;
        clearReconnectTimer();
        connect();
      }
    };
    reconnectIfNeededRef.current = reconnectIfNeeded;

    const onVisibilityChange = () => {
      const visible = isDocumentVisible();
      isVisibleRef.current = visible;
      if (visible) {
        resetIdleTimer(true);
        reconnectIfNeeded();
        syncFleetSubscription();
        resyncActiveNodeSubscription();
        syncHeartbeat();
        syncLeaseRenew();
      } else {
        syncFleetSubscription();
        syncHeartbeat();
        syncLeaseRenew();
      }
    };

    const onWindowFocus = () => {
      if (!isDocumentVisible()) return;
      isVisibleRef.current = true;
      resetIdleTimer(true);
      reconnectIfNeeded();
      syncFleetSubscription();
      resyncActiveNodeSubscription();
      syncHeartbeat();
      syncLeaseRenew();
    };

    const onUserActivity = () => {
      if (!enabledRef.current || !isDocumentVisible()) return;
      resetIdleTimer(false);
    };

    if (isVisibleRef.current) {
      resetIdleTimer(true);
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onWindowFocus);
    const activityEvents: (keyof WindowEventMap)[] = [
      "mousemove",
      "keydown",
      "pointerdown",
      "scroll",
      "touchstart",
      "wheel",
    ];
    for (const evt of activityEvents) {
      window.addEventListener(evt, onUserActivity, { passive: true });
    }

    connect();

    return () => {
      disposed = true;
      fleetSubscribedRef.current = false;
      reconnectIfNeededRef.current = () => {};
      syncHeartbeatRef.current = () => {};
      syncLeaseRenewRef.current = () => {};
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onWindowFocus);
      for (const evt of activityEvents) {
        window.removeEventListener(evt, onUserActivity);
      }
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      clearTimers();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [enabled, resetIdleTimer, resyncActiveNodeSubscription, syncFleetSubscription]);

  return {
    wsStatus,
    liveNodeId,
    liveSeriesByNode,
    procsPacket,
    subNode,
    unsubNode,
    seedLiveSeries,
  };
}
