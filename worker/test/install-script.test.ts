import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { TEST_ORIGIN } from "./helpers";

describe("GET /install.sh", () => {
  it("renders dynamic bash installer with systemd hardening and musl targets", async () => {
    const res = await SELF.fetch(`${TEST_ORIGIN}/install.sh`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/x-shellscript");

    const script = await res.text();
    expect(script).toContain("#!/usr/bin/env bash");
    expect(script).toContain("--url");
    expect(script).toContain("--id");
    expect(script).toContain("--token");
    expect(script).toContain("--cmdline");
    expect(script).toContain("--disable-proc");
    expect(script).toContain("--uninstall");
    expect(script).toContain("x86_64-unknown-linux-musl");
    expect(script).toContain("aarch64-unknown-linux-musl");
    expect(script).toContain("MemoryMax=24M");
    expect(script).toContain("StateDirectory=uniob");
    expect(script).toContain("StateDirectoryMode=0750");
    expect(script).toContain("/var/lib/uniob");
    expect(script).toContain("NoNewPrivileges=true");
    expect(script).toContain("ProtectSystem=strict");
    expect(script).toContain("User=nobody");
    expect(script).toContain('DEFAULT_REPO="Cusnd/UniOB"');
    expect(script).toContain(`DEFAULT_ORIGIN="${TEST_ORIGIN}"`);
    expect(script).toContain('REPO_EXPLICIT="true"');
    expect(script).toContain('SELF_BIN_URL="${HTTP_ORIGIN}/releases/${BIN_NAME}"');
    expect(script).toContain("toml_escape()");
    expect(script).toContain("is_valid_elf()");
    expect(script).toContain("require_arg()");
    expect(script).toContain("--url=*)");
    expect(script).toContain("SHA256SUMS");
    expect(script).toContain('[[ ! -f "${CONFIG_PATH}"');
    expect(script).toContain('url = "${ESC_URL}"');
  });

  it("uses GITHUB_REPO env override when configured", async () => {
    const prev = env.GITHUB_REPO;
    (env as { GITHUB_REPO?: string }).GITHUB_REPO = "myorg/uniob-custom";
    try {
      const res = await SELF.fetch(`${TEST_ORIGIN}/install.sh`);
      const script = await res.text();
      expect(script).toContain('DEFAULT_REPO="myorg/uniob-custom"');
    } finally {
      (env as { GITHUB_REPO?: string }).GITHUB_REPO = prev;
    }
  });
});

describe("GET /install-hub.sh", () => {
  it("renders dynamic bash installer for uniob-hub with watchdog and import-bundle flags", async () => {
    const res = await SELF.fetch(`${TEST_ORIGIN}/install-hub.sh`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/x-shellscript");

    const script = await res.text();
    expect(script).toContain("#!/usr/bin/env bash");
    expect(script).toContain("--listen");
    expect(script).toContain("--domain");
    expect(script).toContain("--watchdog-url");
    expect(script).toContain("--watchdog-secret");
    expect(script).toContain("--import-bundle");
    expect(script).toContain("--uninstall");
    expect(script).toContain("StateDirectory=uniob-hub");
    expect(script).toContain("ProtectSystem=strict");
    expect(script).toContain("User=nobody");
    expect(script).toContain('CONFIG_DIR="/etc/uniob-hub"');
    expect(script).toContain('CONFIG_PATH="${CONFIG_DIR}/hub.toml"');
    expect(script).toContain('STATE_DIR="/var/lib/uniob-hub"');
    expect(script).toContain('DB_PATH="${STATE_DIR}/uniob.db"');
    expect(script).toContain("x86_64-unknown-linux-musl");
    expect(script).toContain('mode = "builtin"');
    expect(script).toContain("--import-only");
    expect(script).toContain("toml_escape()");
    expect(script).toContain("is_valid_elf()");
    expect(script).toContain("require_arg()");
    expect(script).toContain("--listen=*)");
    expect(script).toContain("SHA256SUMS");
    expect(script).toContain("chmod -R a+rX");
    expect(script).toContain("uniob-agent-");
    expect(script).toContain('systemctl stop "${SERVICE_NAME}"');
    expect(script).toContain('[[ ! -f "${CONFIG_PATH}"');
    expect(script).not.toContain("Warning: failed to import bundle");
    expect(script).toContain(`DEFAULT_ORIGIN="${TEST_ORIGIN}"`);
  });
});
