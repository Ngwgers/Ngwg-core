// Ngwg command implementations. This module has NO knowledge of where the
// core itself lives — the CLI bootstrap (Ngwg-cli) resolves/downloads the
// core, then dynamically imports this file and hands over everything the
// commands need: the core directory (for the plugin-management fish script),
// the official default plugin/theme sources, argv and the project root.
//
//   import { cliMain } from "<resolved-core>/src/cli.ts";
//   await cliMain({ argv, coreDir, rootDir, defaultPlugins, defaultTheme });

import { build, startDevServer, Logger, setLogLevel } from "./index.ts";
import { addCommand, ADD_USAGE } from "./commands/add.ts";
import { rimraf, ensureDir, writeText, exists } from "./util/fs.ts";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const USAGE = `ngwg — a quiet static site generator

usage:
  ngwg build                  generate public/ (full pipeline, steps 1-9)
  ngwg dev [--port N] [--speed KBPS]
                              dev daemon with live-reload; --speed simulates a
                              weak network (10 KB/s ≈ a 10 KB file in 1s;
                              0 or negative disables, the default)
  ngwg init                   scaffold ngwg.yaml + source/ in the current dir
  ngwg add [-L title] [-T tag...] [-C category...] [-D date]
                              create a post; without flags an interactive
                              form opens (-D defaults to today)
  ngwg plugin install <name> <url>
  ngwg plugin install-all     install every plugin declared in the configs
  ngwg plugin list
  ngwg plugin remove <name>
  ngwg plugin path
  ngwg clean                  remove public/ and the .ngwg/ directory
  ngwg help | version

options:
  --root=DIR                  project root (default: current directory)
  --quiet                     only errors and warnings
  --verbose                   trace every operation (reads, writes, parses…)

log levels: default prints the core version, loaded plugins, reload progress
and errors/warnings; --quiet keeps only errors/warnings; --verbose adds a
trace of all operations on top of the default output.

the core itself, the default plugins (files, feature) and the default theme
are fetched automatically into <root>/.ngwg/ on first use. override their
sources in ngwg.yaml:

  Ngwg:
    core-repo-url: https://github.com/Ngwgers/Ngwg-core
    theme-repo-url: https://github.com/Ngwgers/Ngwg-default-theme
  plugins:
    files: https://github.com/Ngwgers/Ngwg-files
    feature: https://github.com/Ngwgers/Ngwg-feature`;

export interface CliOptions {
  argv: string[];
  /** resolved core directory (scripts/, used by the plugin fish script) */
  coreDir: string;
  /** project root (fish already resolved --root) */
  rootDir: string;
  /** official fallback plugin sources (CLI hardcodes/overrides them) */
  defaultPlugins: Record<string, string>;
  /** official fallback theme for bare theme names */
  defaultTheme?: { name: string; dir: string };
}

export async function cliMain(opts: CliOptions): Promise<void> {
  const { argv, coreDir, rootDir } = opts;
  const log = new Logger("ngwg");

  const { rest } = extractLogFlags(argv);
  const cmd = rest[0];
  const args = rest.slice(1);

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    case "version":
    case "--version":
    case "-v":
      console.log(`ngwg 0.1.0 (core 0.1.0, bun ${Bun.version}, core at ${coreDir})`);
      return;
    case "build":
      await withExit(() => build(rootDir, { log, defaultPlugins: opts.defaultPlugins, defaultTheme: opts.defaultTheme }));
      return;
    case "dev": {
      const portIdx = args.indexOf("--port");
      const port = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : undefined;
      if (portIdx >= 0 && (isNaN(port) || port! <= 0)) {
        log.error("--port needs a positive number");
        process.exit(2);
      }
      const speedIdx = args.indexOf("--speed");
      const speed = speedIdx >= 0 ? parseFloat(args[speedIdx + 1]) : undefined;
      if (speedIdx >= 0 && isNaN(speed)) {
        log.error("--speed needs a number (KB/s; 0 or negative disables throttling)");
        process.exit(2);
      }
      await withExit(() =>
        startDevServer({
          rootDir,
          port,
          speed,
          log,
          defaultPlugins: opts.defaultPlugins,
          defaultTheme: opts.defaultTheme,
        }),
      );
      return;
    }
    case "init":
      await withExit(() => cmdInit(rootDir, log));
      return;
    case "add":
    case "new":
      await withExit(() => addCommand(args, rootDir, log));
      // raw-mode stdin keeps the event loop alive after completion
      process.exit(0);
    case "clean":
      await withExit(() => cmdClean(rootDir, log));
      return;
    case "plugin":
    case "plugins":
      cmdPlugin(args, coreDir, rootDir, log);
      return;
    default:
      log.error(`unknown command '${cmd}'`);
      console.log(USAGE);
      process.exit(2);
  }
}

async function withExit(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    new Logger("ngwg").error((e as Error).message);
    process.exit(1);
  }
}

/** Split --quiet/--verbose out of argv and apply the log level. */
function extractLogFlags(args: string[]): { rest: string[] } {
  const rest: string[] = [];
  for (const a of args) {
    if (a === "--quiet" || a === "-q") setLogLevel("quiet");
    else if (a === "--verbose" || a === "-V") setLogLevel("verbose");
    else rest.push(a);
  }
  return { rest };
}

async function cmdInit(root: string, log: Logger): Promise<void> {
  const configPath = path.join(root, "ngwg.yaml");
  if (await exists(configPath)) {
    log.error(`ngwg.yaml already exists at ${configPath}`);
    process.exit(1);
  }
  await ensureDir(path.join(root, "source", "_posts"));
  await writeText(
    configPath,
    `# ngwg configuration\ntitle: My Site\ndescription: 安静的站点\nbaseurl: /\ntheme: pacific\nsource_dir: source\npublic_dir: public\n`,
  );
  await writeText(
    path.join(root, "source", "_posts", "2026-01-01-hello-world.md"),
    `---\ntitle: 你好，世界\ndate: 2026-01-01\ntags:\n  - 随笔\ncategories: 开始\n---\n\n# 你好，世界\n\n这是第一篇文章。风从海面吹过来。\n`,
  );
  log.ok(`scaffolded ngwg.yaml and source/_posts in ${root}`);
  log.info("run `ngwg build` to generate public/");
}

async function cmdClean(root: string, log: Logger): Promise<void> {
  await rimraf(path.join(root, "public"));
  await rimraf(path.join(root, ".ngwg"));
  log.ok("removed public/ and .ngwg/");
}

/** plugin management is Fish's job; the script ships inside the core dir. */
function cmdPlugin(args: string[], coreDir: string, root: string, log: Logger): void {
  const script = path.join(coreDir, "scripts", "ngwg-plugins.fish");
  const sub = args[0];
  const full = [script];
  switch (sub) {
    case "install":
      full.push("install", args[1] ?? "", args[2] ?? "", root);
      break;
    case "install-all":
      full.push("install-all", root);
      break;
    case "list":
    case "ls":
      full.push("list", root);
      break;
    case "remove":
    case "rm":
      full.push("remove", args[1] ?? "", root);
      break;
    case "path":
      full.push("path", root);
      break;
    default:
      log.error("usage: ngwg plugin {install <name> <url>|install-all|list|remove <name>|path}");
      process.exit(2);
  }
  const res = spawnSync("fish", full, { stdio: "inherit" });
  process.exit(res.status ?? 1);
}
