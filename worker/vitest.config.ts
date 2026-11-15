import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(async () => {
  const migrationsPath = path.resolve(__dirname, "migrations");
  const migrations = await readD1Migrations(migrationsPath);

  return {
    plugins: [
      cloudflareTest({
        wrangler: {
          configPath: "./wrangler.jsonc",
        },
        miniflare: {
          // Point assets to a local test fixture so worker tests run cleanly
          // even before ../web/dist has been built.
          assets: {
            directory: path.resolve(__dirname, "./test/fixtures/assets"),
            binding: "ASSETS",
            not_found_handling: "single-page-application",
            run_worker_first: ["/api/*", "/install.sh", "/install-hub.sh", "/releases/migration/*"],
          } as any,
          bindings: {
            TEST_MIGRATIONS: migrations,
            AUTH_MODE: "",
            CF_ACCESS_TEAM_DOMAIN: "",
            CF_ACCESS_AUD: "",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
    },
  };
});
