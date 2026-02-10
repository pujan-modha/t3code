import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fixPath } from "./fixPath";
import { createLogger } from "./logger";
import { createServer } from "./wsServer";

fixPath();

const DEFAULT_PORT = 3773;
const cwd = process.cwd();
const logger = createLogger("server");

async function findAvailablePort(preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(preferred, () => {
      server.close(() => resolve(preferred));
    });
    server.on("error", () => {
      // Preferred port busy — let the OS pick one
      const fallback = net.createServer();
      fallback.listen(0, () => {
        const addr = fallback.address();
        const port =
          typeof addr === "object" && addr !== null ? addr.port : 0;
        fallback.close(() => {
          if (port > 0) resolve(port);
          else reject(new Error("Could not find an available port."));
        });
      });
      fallback.on("error", reject);
    });
  });
}

function resolveStaticDir(): string | undefined {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  // Check for bundled client (npm publish / npx scenario):
  // dist/client/ lives alongside dist/index.js
  const bundledClient = path.resolve(__dirname, "client");
  try {
    const stat = fs.statSync(path.join(bundledClient, "index.html"));
    if (stat.isFile()) return bundledClient;
  } catch {
    // Not bundled — check monorepo layout
  }

  // Monorepo layout: apps/server/dist/index.js → apps/renderer/dist/
  const monorepoClient = path.resolve(__dirname, "../../renderer/dist");
  try {
    const stat = fs.statSync(path.join(monorepoClient, "index.html"));
    if (stat.isFile()) return monorepoClient;
  } catch {
    // Not found — probably dev mode, Vite will serve
  }

  return undefined;
}

async function main() {
  const port = await findAvailablePort(DEFAULT_PORT);
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const staticDir = devUrl ? undefined : resolveStaticDir();

  if (!devUrl && !staticDir) {
    logger.warn(
      "renderer bundle missing and no VITE_DEV_SERVER_URL; web UI unavailable",
      {
        hint:
          "Run `bun run --cwd apps/renderer build` or set VITE_DEV_SERVER_URL for dev mode.",
      },
    );
  }

  const server = createServer({ port, cwd, staticDir, devUrl });
  await server.start();

  const url = `http://localhost:${port}`;
  logger.info("CodeThing running", { url, cwd });

  // Open browser (dynamic import because `open` is ESM-only)
  try {
    const open = await import("open");
    const target = devUrl ?? url;
    await open.default(target);
  } catch {
    logger.info("browser auto-open unavailable", {
      hint: `Open ${devUrl ?? url} in your browser.`,
    });
  }

  // Graceful shutdown
  const shutdown = () => {
    logger.info("shutting down");
    server.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error("failed to start CodeThing", { error: err });
  process.exit(1);
});
