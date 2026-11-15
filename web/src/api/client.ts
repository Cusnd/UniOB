import type {
  AgentUpdateCheckResponse,
  AgentUpdateConfig,
  AgentUpdateConfigResponse,
  AlertIncident,
  AlertRule,
  AuthStatus,
  CreateNodePayload,
  CreateNodeResponse,
  ExportBundle,
  HubMigratePayload,
  HubMigrateResponse,
  HubStatusResponse,
  ImportBundleResponse,
  MetricsRange,
  MigrationTicketPayload,
  MigrationTicketResponse,
  NodeMetricsHistoryResponse,
  NodeSummary,
  NotificationChannel,
  RotateTokenResponse,
  SmartMigratePayload,
  SmartMigrateResponse,
  TriggerAgentUpdatePayload,
  TriggerAgentUpdateResponse,
  UpdateNodePayload,
  WatchdogConfig,
} from "../types";
import type {
  NetworkNodeOverride, NetworkQualityConfig, NetworkQualityConfigResponse,
  NetworkQualityQuery, NetworkQualityRange,
} from "../types/network-quality";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type UnauthorizedHandler = (status: 401 | 403) => void;
let onUnauthorized: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

export function normalizeWatchdogConfig(raw: unknown): WatchdogConfig {
  const unwrapped =
    raw && typeof raw === "object"
      ? ((raw as { config?: unknown }).config ?? raw)
      : raw;
  const cfg =
    unwrapped && typeof unwrapped === "object"
      ? (unwrapped as Record<string, unknown>)
      : {};
  const channelIds = Array.isArray(cfg.channel_ids)
    ? cfg.channel_ids.filter(
        (id): id is string => typeof id === "string" && id.trim().length > 0
      )
    : [];
  return {
    enabled: Boolean(cfg.enabled),
    secret: typeof cfg.secret === "string" ? cfg.secret : "",
    timeout_sec:
      typeof cfg.timeout_sec === "number" && Number.isFinite(cfg.timeout_sec)
        ? cfg.timeout_sec
        : 900,
    cooldown_sec:
      typeof cfg.cooldown_sec === "number" && Number.isFinite(cfg.cooldown_sec)
        ? cfg.cooldown_sec
        : 1800,
    hub_label:
      typeof cfg.hub_label === "string"
        ? cfg.hub_label
        : "Self-Hosted UniOB Hub",
    channel_ids: channelIds,
  };
}

async function request<T>(
  path: string,
  options: RequestInit & { skipUnauthorizedHook?: boolean } = {},
): Promise<T> {
  const { skipUnauthorizedHook, headers, ...init } = options;
  const finalHeaders = new Headers(headers);
  if (init.body && !finalHeaders.has("Content-Type")) {
    finalHeaders.set("Content-Type", "application/json");
  }

  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: finalHeaders,
    });
  } catch (err) {
    const detail = err instanceof Error && err.message ? `: ${err.message}` : "";
    throw new ApiError(0, `网络请求失败，请检查连接或刷新页面${detail}`);
  }

  if (
    res.redirected &&
    typeof res.url === "string" &&
    (res.url.includes("/cdn-cgi/access/") ||
      res.url.includes("cloudflareaccess.com"))
  ) {
    if (!skipUnauthorizedHook && onUnauthorized) {
      onUnauthorized(401);
    }
    throw new ApiError(401, "Cloudflare Access 会话已过期，请刷新页面重新登录");
  }

  if (
    (res.status === 401 || res.status === 403) &&
    !skipUnauthorizedHook &&
    onUnauthorized
  ) {
    onUnauthorized(res.status);
  }

  const contentType = res.headers.get("content-type")?.toLowerCase() ?? "";
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (res.ok) {
        if (
          contentType.includes("text/html") ||
          text.trimStart().startsWith("<")
        ) {
          if (!skipUnauthorizedHook) {
            onUnauthorized?.(401);
          }
          throw new ApiError(401, "登录会话已失效，请刷新页面重新鉴权");
        }
        throw new ApiError(502, "服务器返回了非 JSON 响应");
      }
      data = { error: text };
    }
  }

  if (!res.ok) {
    const errObj = (data ?? {}) as { error?: string; message?: string };
    const msg = errObj.error || errObj.message || `HTTP ${res.status}`;
    throw new ApiError(res.status, msg);
  }

  return data as T;
}

export const api = {
  getAuthMe(): Promise<AuthStatus> {
    return request<AuthStatus>("/api/auth/me", { skipUnauthorizedHook: true });
  },

  setupPassword(password: string): Promise<{ ok: true }> {
    return request<{ ok: true }>("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ password }),
      skipUnauthorizedHook: true,
    });
  },

  login(password: string): Promise<{ ok: true }> {
    return request<{ ok: true }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
      skipUnauthorizedHook: true,
    });
  },

  logout(): Promise<{ ok: true }> {
    return request<{ ok: true }>("/api/auth/logout", {
      method: "POST",
      skipUnauthorizedHook: true,
    });
  },

  getNodes(): Promise<{ nodes: NodeSummary[]; activeAlertsCount: number }> {
    return request<{ nodes: NodeSummary[]; activeAlertsCount: number }>("/api/nodes");
  },

  createNode(payload: CreateNodePayload): Promise<CreateNodeResponse> {
    return request<CreateNodeResponse>("/api/nodes", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  updateNode(id: string, payload: UpdateNodePayload): Promise<{ node: NodeSummary }> {
    return request<{ node: NodeSummary }>(`/api/nodes/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },

  deleteNode(id: string): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/api/nodes/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  rotateNodeToken(id: string): Promise<RotateTokenResponse> {
    return request<RotateTokenResponse>(
      `/api/nodes/${encodeURIComponent(id)}/rotate-token`,
      { method: "POST" },
    );
  },

  getNodeMetrics(id: string, range: MetricsRange): Promise<NodeMetricsHistoryResponse> {
    return request<NodeMetricsHistoryResponse>(
      `/api/nodes/${encodeURIComponent(id)}/metrics?range=${encodeURIComponent(range)}`,
    );
  },

  getNetworkQualityConfig(signal?: AbortSignal): Promise<NetworkQualityConfigResponse<NetworkQualityConfig>> {
    return request("/api/network-quality/config", { signal });
  },

  updateNetworkQualityConfig(config: NetworkQualityConfig): Promise<NetworkQualityConfigResponse<NetworkQualityConfig>> {
    return request("/api/network-quality/config", { method: "PUT", body: JSON.stringify(config) });
  },

  getNodeNetworkQualityConfig(id: string, signal?: AbortSignal): Promise<NetworkQualityConfigResponse<NetworkNodeOverride>> {
    return request(`/api/nodes/${encodeURIComponent(id)}/network-quality/config`, { signal });
  },

  updateNodeNetworkQualityConfig(id: string, config: NetworkNodeOverride): Promise<NetworkQualityConfigResponse<NetworkNodeOverride>> {
    return request(`/api/nodes/${encodeURIComponent(id)}/network-quality/config`, { method: "PUT", body: JSON.stringify(config) });
  },

  getNodeNetworkQuality(id: string, range: NetworkQualityRange, cursor?: string, signal?: AbortSignal): Promise<NetworkQualityQuery> {
    const query = new URLSearchParams({ range });
    if (cursor) query.set("cursor", cursor);
    return request(`/api/nodes/${encodeURIComponent(id)}/network-quality?${query}`, { signal });
  },

  getChannels(): Promise<{ channels: NotificationChannel[] }> {
    return request<{ channels: NotificationChannel[] }>("/api/alerts/channels");
  },

  createChannel(
    payload: Omit<NotificationChannel, "id" | "created_at">,
  ): Promise<{ channel: NotificationChannel }> {
    return request<{ channel: NotificationChannel }>("/api/alerts/channels", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  updateChannel(
    id: string,
    payload: Partial<Omit<NotificationChannel, "id" | "created_at">>,
  ): Promise<{ channel: NotificationChannel }> {
    return request<{ channel: NotificationChannel }>(
      `/api/alerts/channels/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(payload),
      },
    );
  },

  deleteChannel(id: string): Promise<{ ok: true }> {
    return request<{ ok: true }>(
      `/api/alerts/channels/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  },

  testChannel(id: string): Promise<{ ok: boolean; error?: string }> {
    return request<{ ok: boolean; error?: string }>(
      `/api/alerts/channels/${encodeURIComponent(id)}/test`,
      { method: "POST" },
    );
  },

  getRules(): Promise<{ rules: AlertRule[] }> {
    return request<{ rules: AlertRule[] }>("/api/alerts/rules");
  },

  createRule(
    payload: Omit<AlertRule, "id" | "created_at">,
  ): Promise<{ rule: AlertRule }> {
    return request<{ rule: AlertRule }>("/api/alerts/rules", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  applyRulePresets(channelIds: string[]): Promise<{ rules: AlertRule[] }> {
    return request<{ rules: AlertRule[] }>("/api/alerts/rules/presets", {
      method: "POST",
      body: JSON.stringify({ channel_ids: channelIds }),
    });
  },

  updateRule(
    id: string,
    payload: Partial<Omit<AlertRule, "id" | "created_at">>,
  ): Promise<{ rule: AlertRule }> {
    return request<{ rule: AlertRule }>(
      `/api/alerts/rules/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(payload),
      },
    );
  },

  deleteRule(id: string): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/api/alerts/rules/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  getIncidents(params?: {
    status?: "all" | "firing" | "resolved";
    limit?: number;
    offset?: number;
  }): Promise<{ incidents: AlertIncident[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.status) query.set("status", params.status);
    if (params?.limit !== undefined) query.set("limit", String(params.limit));
    if (params?.offset !== undefined) query.set("offset", String(params.offset));
    const qs = query.toString();
    return request<{ incidents: AlertIncident[]; total: number }>(
      `/api/alerts/incidents${qs ? `?${qs}` : ""}`,
    );
  },

  getHubStatus(): Promise<HubStatusResponse> {
    return request<HubStatusResponse>("/api/hub/status");
  },

  exportBundle(): Promise<ExportBundle> {
    return request<ExportBundle>("/api/export/bundle");
  },

  importBundle(bundle: ExportBundle): Promise<ImportBundleResponse> {
    return request<ImportBundleResponse>("/api/import/bundle", {
      method: "POST",
      body: JSON.stringify(bundle),
    });
  },

  createMigrationTicket(
    payload: MigrationTicketPayload
  ): Promise<MigrationTicketResponse> {
    return request<MigrationTicketResponse>("/api/migration/ticket", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  smartMigrateHub(payload: SmartMigratePayload): Promise<SmartMigrateResponse> {
    return request<SmartMigrateResponse>("/api/hub/migrate-smart", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  migrateHub(payload: HubMigratePayload): Promise<HubMigrateResponse> {
    return request<HubMigrateResponse>("/api/hub/migrate", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async getWatchdogConfig(): Promise<WatchdogConfig> {
    const raw = await request<unknown>("/api/watchdog/config");
    return normalizeWatchdogConfig(raw);
  },

  async updateWatchdogConfig(payload: WatchdogConfig): Promise<WatchdogConfig> {
    const raw = await request<unknown>("/api/watchdog/config", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    return normalizeWatchdogConfig(raw);
  },

  getAgentUpdateConfig(signal?: AbortSignal): Promise<AgentUpdateConfigResponse> {
    return request<AgentUpdateConfigResponse>("/api/agent-update/config", {
      signal,
    });
  },

  updateAgentUpdateConfig(
    cfg: Partial<AgentUpdateConfig>,
  ): Promise<AgentUpdateConfigResponse> {
    return request<AgentUpdateConfigResponse>("/api/agent-update/config", {
      method: "PUT",
      body: JSON.stringify(cfg),
    });
  },

  checkAgentUpdates(): Promise<AgentUpdateCheckResponse> {
    return request<AgentUpdateCheckResponse>("/api/agent-update/check", {
      method: "POST",
    });
  },

  triggerAgentUpdate(
    payload: TriggerAgentUpdatePayload = {},
  ): Promise<TriggerAgentUpdateResponse> {
    return request<TriggerAgentUpdateResponse>("/api/agent-update/trigger", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
};
