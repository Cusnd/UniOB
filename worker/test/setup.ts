import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";
import { clearAuthCachesForTest } from "../src/auth";

beforeEach(async () => {
  clearAuthCachesForTest();
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
