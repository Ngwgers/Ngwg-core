// The ngwg dev daemon: builds the site, then keeps running — an HTTP server
// in front of public/ (with live-reload script injection) plus a watcher
// that rewinds the pipeline on changes:
//
//   config / plugin change → full pipeline restart (back to step 1)
//   theme change           → re-read theme, redeploy (back to the theme step)
//   source change          → re-parse changed files, redeploy (back to step 7)

import * as path from "node:path";
import { Engine } from "../core/engine.ts";
import { Logger } from "../util/log.ts";
import { CONFIG_FILENAMES } from "../config/loader.ts";
import { exists, readBytes } from "../util/fs.ts";
import { Watcher, planReload, type WatcherRoots } from "./watcher.ts";

const LIVE_RELOAD_JS = `
// ngwg live-reload client
(function () {
  var ws = null;
  function connect() {
    ws = new WebSocket("ws://" + location.host + "/__ngwg/ws");
    ws.onmessage = function (e) {
      if (e.data === "reload") location.reload();
    };
    ws.onclose = function () {
      // server restarted — reload once it is back
      setTimeout(function () { location.reload(); }, 1200);
    };
  }
  connect();
  console.log("[ngwg] live-reload connected");
})();
`;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};

export interface DevOptions {
  rootDir: string;
  port?: number;
  log?: Logger;
  /**
   * simulated network speed in KB/s: a 10 KB file takes ~1s at speed 10.
   * Negative or 0 disables throttling (default). The CLI --speed flag wins
   * over the `dev_speed` field in ngwg.yaml.
   */
  speed?: number;
  /** fallback plugin/theme sources — see EngineOptions (CLI provides them) */
  defaultPlugins?: Record<string, string>;
  defaultTheme?: { name: string; dir: string };
  /** CLI-owned plugin-management script — see EngineOptions */
  pluginScript?: string;
}

export interface DevHandle {
  port: number;
  stop: () => Promise<void>;
}

export async function startDevServer(opts: DevOptions): Promise<DevHandle> {
  const { rootDir } = opts;
  const log = opts.log ?? new Logger();
  const engine = new Engine(rootDir, {
    log,
    defaultPlugins: opts.defaultPlugins,
    defaultTheme: opts.defaultTheme,
    pluginScript: opts.pluginScript,
  });
  const clients = new Set<any>();

  let busy = false;
  let rerunPending: { reset: "all" | "theme" | "sources"; changed: string[] } | null = null;

  const broadcast = (msg: string) => {
    for (const ws of clients) {
      try {
        ws.send(msg);
      } catch {}
    }
  };

  // initial build (pipeline step 1..9); a fatal error here is fatal for dev too
  await engine.run({ reset: "all" });

  const currentRoots = (): WatcherRoots => {
    const st = engine.state;
    return {
      configFiles: CONFIG_FILENAMES.map((f) => path.join(rootDir, f)),
      themeRoot: st?.themeRoot ?? null,
      sourceDir: st ? path.resolve(rootDir, st.config.source_dir ?? "source") : null,
      pluginDirs: [
        path.join(rootDir, ".ngwg", "plugins"),
        ...st.plugins.loaded.map((p) => p.root),
      ],
    };
  };

  const runAndNotify = async (plan: { reset: "all" | "theme" | "sources"; changed: string[] }, label: string) => {
    if (busy) {
      rerunPending = plan; // coalesce bursts; the newest plan wins
      return;
    }
    busy = true;
    try {
      for (const p of plan.changed) log.debug(`changed: ${p}`);
      log.info(`${label} — rebuilding (reset: ${plan.reset})`);
      await engine.run(plan);
      if (plan.reset === "all") watcher.updateRoots(currentRoots());
      broadcast("reload");
      log.ok("reloaded");
    } catch (e) {
      log.error(`reload failed: ${(e as Error).message}`);
      broadcast("error");
    } finally {
      busy = false;
      if (rerunPending) {
        const next = rerunPending;
        rerunPending = null;
        void runAndNotify(next, "changes (queued)");
      }
    }
  };

  const watcher = new Watcher(currentRoots(), (changes) => {
    const plan = planReload(changes);
    const label =
      plan.reset === "all"
        ? `${changes.length} config/plugin file(s) changed`
        : `${changes.length} file(s) changed`;
    void runAndNotify(plan, label);
  });
  watcher.start();

  const server = Bun.serve({
    port: opts.port ?? 4000,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/__ngwg/ws") {
        const upgraded = server.upgrade(req);
        if (upgraded) return undefined as any;
        return new Response("websocket upgrade failed", { status: 500 });
      }

      if (url.pathname === "/__ngwg/live.js") {
        return new Response(LIVE_RELOAD_JS, {
          headers: { "Content-Type": "text/javascript; charset=utf-8" },
        });
      }

      const st = engine.state;
      if (!st) return new Response("ngwg: no build state (check the terminal for errors)", { status: 503 });
      const publicDir = path.resolve(rootDir, st.config.public_dir ?? "public");

      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith("/")) rel += "index.html";
      let file = path.join(publicDir, rel);
      if (!(await exists(file))) {
        // directory-style URLs without trailing slash
        if (await exists(file + ".html")) file += ".html";
        else if (await exists(path.join(file, "index.html"))) file = path.join(file, "index.html");
        else return new Response("404 Not Found", { status: 404 });
      }

      const ext = path.extname(file).toLowerCase();
      const data = await readBytes(file);

      // weak-network simulation: delay proportional to the response size
      const speed = opts.speed !== undefined ? opts.speed : (st.config.dev_speed ?? 0);
      if (speed > 0) {
        const delayMs = (data.byteLength * 1000) / (speed * 1024);
        if (delayMs > 0) await Bun.sleep(delayMs);
      }

      const headers: Record<string, string> = {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
      };

      if (ext === ".html") {
        let html = new TextDecoder().decode(data);
        if (!html.includes("/__ngwg/live.js")) {
          html = html.replace(
            /<\/body>/i,
            `<script src="/__ngwg/live.js"></script></body>`,
          );
        }
        return new Response(html, { headers });
      }
      return new Response(data, { headers });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
      },
      message() {},
      close(ws) {
        clients.delete(ws);
      },
    },
  });

  log.ok(`dev server running at http://localhost:${server.port} (Ctrl+C to stop)`);

  return {
    port: server.port,
    stop: async () => {
      watcher.stop();
      server.stop(true);
    },
  };
}
