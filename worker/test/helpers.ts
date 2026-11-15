import { SELF } from "cloudflare:test";
import type { AgentHelloFrame, AgentMetricsFrame } from "../src/types";

export const TEST_ORIGIN = "https://uniob.example.com";

export async function setupAndLogin(password = "StrongPass123!"): Promise<string> {
  const res = await SELF.fetch(`${TEST_ORIGIN}/api/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    throw new Error(`Setup failed: ${res.status} ${await res.text()}`);
  }
  const setCookie = res.headers.get("Set-Cookie") ?? "";
  const cookiePair = setCookie.split(";")[0] ?? "";
  if (!cookiePair.startsWith("uniob_session=")) {
    throw new Error(`Missing uniob_session cookie: ${setCookie}`);
  }
  return cookiePair;
}

export async function authedFetch(
  path: string,
  cookie: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cookie", cookie);
  return SELF.fetch(`${TEST_ORIGIN}${path}`, {
    ...init,
    headers,
  });
}

export async function createTestNode(
  cookie: string,
  overrides: Record<string, unknown> = {},
): Promise<{
  node: { id: string; name: string; group_name: string };
  agent_token: string;
  install_cmd: string;
}> {
  const res = await authedFetch("/api/nodes", cookie, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "hk-nano-01",
      group_name: "香港",
      ...overrides,
    }),
  });
  if (res.status !== 201) {
    throw new Error(`Create node failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function connectAgentWs(
  nodeId: string,
  token: string,
): Promise<WebSocket> {
  const res = await SELF.fetch(`${TEST_ORIGIN}/api/agent/ws`, {
    headers: {
      Upgrade: "websocket",
      "X-UniOB-Node-Id": nodeId,
      Authorization: `Bearer ${token}`,
      "X-UniOB-Agent-Version": "0.1.0",
    },
  });
  if (res.status !== 101 || !res.webSocket) {
    throw new Error(`Agent WS connect failed: ${res.status}`);
  }
  res.webSocket.accept();
  return res.webSocket;
}

export async function connectClientWs(cookie: string): Promise<WebSocket> {
  const res = await SELF.fetch(`${TEST_ORIGIN}/api/client/ws`, {
    headers: {
      Upgrade: "websocket",
      Cookie: cookie,
    },
  });
  if (res.status !== 101 || !res.webSocket) {
    throw new Error(`Client WS connect failed: ${res.status}`);
  }
  res.webSocket.accept();
  return res.webSocket;
}

export function makeHelloFrame(
  overrides: Partial<AgentHelloFrame> = {},
): AgentHelloFrame {
  return {
    t: "hello",
    v: 1,
    agent_ver: "0.1.0",
    hostname: "hk-bgp-nano-01",
    os: "Debian GNU/Linux 12 (bookworm)",
    kernel: "6.1.0-26-amd64",
    arch: "x86_64",
    cpu_model: "AMD EPYC 7763 64-Core Processor",
    cpu_cores: 1,
    mem_total: 1_000_000_000,
    swap_total: 1_000_000_000,
    boot_time: 1762001234,
    proc_enabled: true,
    ...overrides,
  };
}

export function makeMetricsFrame(
  ts: number,
  overrides: Partial<AgentMetricsFrame> = {},
): AgentMetricsFrame {
  return {
    t: "m",
    ts,
    up: 1000,
    cpu: {
      all: 15.0,
      cores: [15.0],
      steal: 0.5,
      iowait: 0.2,
      load: [0.2, 0.15, 0.1],
      ...(overrides.cpu ?? {}),
    },
    mem: {
      used: 400_000_000,
      avail: 600_000_000,
      cached: 200_000_000,
      swap_used: 10_000_000,
      ...(overrides.mem ?? {}),
    },
    disks: overrides.disks ?? [
      {
        mp: "/",
        fs: "ext4",
        total: 20_000_000_000,
        used: 6_000_000_000,
        r_bps: 1024,
        w_bps: 4096,
      },
    ],
    net: {
      rx_bps: 10_000,
      tx_bps: 20_000,
      rx_tot: 1_000_000,
      tx_tot: 2_000_000,
      tcp_est: 12,
      tcp_tw: 3,
      udp: 2,
      ...(overrides.net ?? {}),
    },
    ...(overrides.procs !== undefined ? { procs: overrides.procs } : {}),
  };
}

export function nextWsMessage<T = unknown>(
  ws: WebSocket,
  predicate: (msg: T) => boolean = () => true,
  timeoutMs = 3000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error("Timed out waiting for WebSocket message"));
    }, timeoutMs);

    const onMessage = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") {
        return;
      }
      try {
        const parsed = JSON.parse(ev.data) as T;
        if (predicate(parsed)) {
          clearTimeout(timer);
          ws.removeEventListener("message", onMessage);
          resolve(parsed);
        }
      } catch {
        // ignore non-JSON
      }
    };

    ws.addEventListener("message", onMessage);
  });
}

export async function flushMicrotasks(ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 15));
  }
}
