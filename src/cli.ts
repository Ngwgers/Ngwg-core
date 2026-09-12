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
import { renameSync, existsSync } from "node:fs";
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
  ngwg update [core|theme|plugin [name...]]
                              update the CLI-managed copies in <root>/.ngwg/
                              (core, default theme, installed plugins) to the
                              latest version; without a target everything is
                              updated
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
  /** repo URL used by `ngwg update core` (resolved/injected by the CLI) */
  coreRepoUrl?: string;
  /** repo URL used by `ngwg update theme` (resolved/injected by the CLI) */
  themeRepoUrl?: string;
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
    case "update":
      await withExit(() => cmdUpdate(args, { coreDir, rootDir, log, coreRepoUrl: opts.coreRepoUrl, themeRepoUrl: opts.themeRepoUrl }));
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

/** `ngwg update` — refresh the CLI-managed copies under <root>/.ngwg/.
 * Core and theme stores are re-cloned from the repo URLs the CLI resolved;
 * plugin stores are re-fetched by the management fish script, which knows
 * every declaration flavour (git, tarball, local copy). */
async function cmdUpdate(
  args: string[],
  o: { coreDir: string; rootDir: string; log: Logger; coreRepoUrl?: string; themeRepoUrl?: string },
): Promise<void> {
  const coreValidate = (d: string) => existsSync(path.join(d, "src", "index.ts"));
  const themeValidate = (d: string) => existsSync(path.join(d, "theme.yaml"));
  const target = args[0];
  if (target === undefined) {
    await updateManagedCopy("core", path.join(o.rootDir, ".ngwg", "core"), o.coreRepoUrl, coreValidate, o.log);
    await updateManagedCopy("theme", path.join(o.rootDir, ".ngwg", "theme"), o.themeRepoUrl, themeValidate, o.log);
    const status = updatePlugins([], o.coreDir, o.rootDir);
    if (status !== 0) process.exit(status);
    return;
  }
  switch (target) {
    case "core":
      await updateManagedCopy("core", path.join(o.rootDir, ".ngwg", "core"), o.coreRepoUrl, coreValidate, o.log);
      return;
    case "theme":
      await updateManagedCopy("theme", path.join(o.rootDir, ".ngwg", "theme"), o.themeRepoUrl, themeValidate, o.log);
      return;
    case "plugin":
    case "plugins": {
      const status = updatePlugins(args.slice(1), o.coreDir, o.rootDir);
      if (status !== 0) process.exit(status);
      return;
    }
    default:
      o.log.error(`unknown update target '${target}' (use core, theme or plugin)`);
      console.log("usage: ngwg update [core|theme|plugin [name...]]");
      process.exit(2);
  }
}

/** Re-clone a CLI-managed store copy (core/theme) from its repo URL. The
 * fresh clone is fetched and validated in a temp dir first, so a failed
 * update never destroys the working copy. */
async function updateManagedCopy(
  name: string,
  storeDir: string,
  repoUrl: string | undefined,
  validate: (dir: string) => boolean,
  log: Logger,
): Promise<void> {
  if (!existsSync(storeDir)) {
    log.info(`no CLI-managed ${name} at ${storeDir} — nothing to update`);
    return;
  }
  if (!repoUrl) {
    throw new Error(`cannot update ${name}: the CLI did not provide a repo URL for it. ` + `Set Ngwg.core-repo-url / Ngwg.theme-repo-url in ngwg.yaml, then rerun ngwg update.`);
  }
  const tmp = `${storeDir}.update`;
  await rimraf(tmp);
  const res = spawnSync("git", ["clone", "--depth", "1", repoUrl, tmp], { stdio: "pipe" });
  if (res.status !== 0 || !validate(tmp)) {
    await rimraf(tmp);
    throw new Error(
      `could not update ${name} from ${repoUrl}:\n${res.stderr?.toString() || ""}` +
        `Check Ngwg.core-repo-url / Ngwg.theme-repo-url in ngwg.yaml, then rerun ngwg update.`,
    );
  }
  await rimraf(storeDir);
  renameSync(tmp, storeDir);
  log.ok(`updated ${name} → ${storeDir}`);
  if (name === "core") log.info("the new core is picked up on the next ngwg run");
}

/** Plugin updates go through the management fish script (fetch flavours and
 * declaration lookup live there). Returns the script's exit status. */
function updatePlugins(names: string[], coreDir: string, root: string): number {
  const script = path.join(coreDir, "scripts", "ngwg-plugins.fish");
  if (names.length === 0) {
    const res = spawnSync("fish", [script, "update-all", root], { stdio: "inherit" });
    return res.status ?? 1;
  }
  for (const name of names) {
    const res = spawnSync("fish", [script, "update", name, root], { stdio: "inherit" });
    if (res.status !== 0) return res.status ?? 1;
  }
  return 0;
}
