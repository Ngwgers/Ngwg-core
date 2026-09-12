// The Ngwg build engine.
//
// The workflow is event-driven: every pipeline step is an event on the
// EventQueue (config:check → config:load → config:validate → theme:load →
// plugins:load → sources:parse → data:process → site:deploy). Trusted plugins
// can splice their own events between steps; the queue serializes everything.
//
// Live-reload reuses the same pipeline at a lower entry point:
//   reset "all"     → full run (step 1)          — config / plugin changes
//   reset "theme"   → re-read theme, then steps 7-9 — theme changes
//   reset "sources" → re-parse changed files (step 6 subset), then steps 7-9
// A newer run invalidates the older one between steps (RunInterrupted).

import * as path from "node:path";
import { EventQueue, Steps, ALL_STEPS } from "../events/queue.ts";
import { Logger } from "../util/log.ts";
import { ensureDir, exists, extOf, isDir, readBytes, readText, rimraf, walkFiles } from "../util/fs.ts";
import { Pool, PoolAborted } from "../util/pool.ts";
import {
  loadUserConfig,
  validateUserConfig,
  findConfigFile,
  ConfigError,
} from "../config/loader.ts";
import { parseYaml } from "../config/yaml.ts";
import {
  loadAllPlugins,
  type LoadAllResult,
  type LoadedUnit,
} from "../plugin/loader.ts";
import { matchExtensions, type DeployerUnitV1, type ParserUnitV1 } from "../plugin/protocol.ts";
import { loadTheme, resolveThemeDir, ThemeError } from "./theme.ts";
import { buildSiteData } from "./data.ts";
import { buildRenderTasks } from "./tasks.ts";
import type { DeployEnv, PluginContext, RenderTask, SiteData, SourceObject, ThemeObject, UserConfig } from "../types.ts";

export const CORE_VERSION = "0.1.0";

export class RunInterrupted extends Error {
  constructor() {
    super("run interrupted by a newer change");
  }
}

export type ResetLevel = "all" | "theme" | "sources";

export interface EngineState {
  configFile: string;
  config: UserConfig;
  themeRoot: string;
  theme: ThemeObject;
  plugins: LoadAllResult;
  /** all parsed source objects keyed by absolute path */
  sources: Map<string, SourceObject>;
  data: SiteData;
}

export interface EngineOptions {
  log?: Logger;
  concurrency?: number;
  /**
   * fallback plugin declarations used when neither the user config nor the
   * theme declares a plugin with that key. The CLI hardcodes the official
   * files/feature URLs here; Core itself knows no default URLs.
   */
  defaultPlugins?: Record<string, string>;
  /** fallback for bare theme names (CLI ensures the official default theme) */
  defaultTheme?: { name: string; dir: string };
}

export class Engine {
  readonly log: Logger;
  readonly queue: EventQueue;
  state: EngineState | null = null;
  private runToken = 0;
  private pluginContexts = new Map<string, PluginContext>();
  helperMap: Record<string, (...args: any[]) => any> = {};
  private lastError: Error | null = null;
  private opts: EngineOptions;

  constructor(public rootDir: string, opts: EngineOptions = {}) {
    this.opts = opts;
    this.log = opts.log ?? new Logger();
    this.queue = new EventQueue();
    this.registerSteps();
  }

  // -------------------------------------------------------------------------
  // Plugin context factory
  // -------------------------------------------------------------------------

  private makeContext = (pluginName: string, trusted: boolean): PluginContext => {
    const queue = this.queue;
    const engine = this;
    const ctx: PluginContext = {
      coreVersion: CORE_VERSION,
      rootDir: this.rootDir,
      get config() {
        return engine.currentConfig!;
      },
      trusted,
      log: {
        info: (m) => this.log.child(pluginName).info(m),
        warn: (m) => this.log.child(pluginName).warn(m),
        error: (m) => this.log.child(pluginName).error(m),
        debug: (m) => this.log.child(pluginName).debug(m),
      },
      helpers: this.helperMap,
      yaml: {
        parse: (text: string) => parseYaml(text),
      },
      // canonical relPath for parsers: relative to the configured source
      // directory (posix separators), read from the config current at call time
      relPath: (filePath: string) =>
        path
          .relative(path.resolve(this.rootDir, engine.currentConfig?.source_dir ?? "source"), filePath)
          .replace(/\\/g, "/"),
      events: {
        on: (name, handler) => queue.on(name, handler),
        emit: async (name, payload) => {
          // plugin-local emit: direct dispatch, never enters the workflow queue
          for (const h of queue.handlersFor(name)) await h(payload, { name, payload, source: pluginName });
        },
        injectAfter: (afterStep, evt) => queue.injectAfter(pluginName, afterStep, evt),
      },
    };
    this.pluginContexts.set(pluginName, ctx);
    return ctx;
  };

  // -------------------------------------------------------------------------
  // Public entry points
  // -------------------------------------------------------------------------

  /** One build pass at the given reset level. Throws on fatal errors. */
  async run(opts: { reset: ResetLevel; changed?: string[] }): Promise<void> {
    const token = ++this.runToken;
    this.lastError = null;

    const steps: string[] =
      opts.reset === "all"
        ? [Steps.START, ...ALL_STEPS.filter((s) => s !== Steps.START && s !== Steps.END), Steps.END]
        : opts.reset === "theme"
          ? [Steps.THEME_LOAD, Steps.SOURCES_PARSE, Steps.DATA_PROCESS, Steps.SITE_DEPLOY]
          : [Steps.SOURCES_PARSE, Steps.DATA_PROCESS, Steps.SITE_DEPLOY];

    this.interruptToken = token;
    try {
      for (const step of steps) {
        if (token !== this.runToken) throw new RunInterrupted();
        await this.queue.emit(step, { reset: opts.reset, changed: opts.changed ?? [] });
        if (this.lastError) throw this.lastError;
      }
    } catch (e) {
      if (e instanceof RunInterrupted || e instanceof PoolAborted) return; // superseded, not an error
      throw e;
    }
  }

  private interruptToken = 0;

  private assertCurrent(token: number) {
    if (token !== this.interruptToken) throw new RunInterrupted();
  }

  // -------------------------------------------------------------------------
  // Pipeline steps, registered as queue handlers
  // -------------------------------------------------------------------------

  private registerSteps() {
    const q = this.queue;

    q.on(Steps.START, async () => {
      this.log.info(`ngwg core v${CORE_VERSION} — build starting at ${this.rootDir}`);
    });

    q.on(Steps.CONFIG_CHECK, async () => {
      const file = await findConfigFile(this.rootDir).catch((e) => {
        throw new ConfigError((e as Error).message);
      });
      this.state = null;
      this._pendingConfigFile = file;
    });

    q.on(Steps.CONFIG_LOAD, async () => {
      const config = await loadUserConfig(this.rootDir);
      this.currentConfig = config;
      this._pendingConfigFile = await findConfigFile(this.rootDir);
    });

    q.on(Steps.CONFIG_VALIDATE, async () => {
      const errors = validateUserConfig(this.currentConfig!, this._pendingConfigFile!);
      if (errors.length > 0) {
        throw new ConfigError("invalid configuration:\n  " + errors.join("\n  "));
      }
    });

    q.on(Steps.THEME_LOAD, async () => {
      this.assertCurrent(this.interruptToken);
      const config = this.currentConfig!;
      // theme may be "pacific", a path, or { pacific: { overrides } }
      let selector: string;
      let themeOverrides: Record<string, any> | undefined;
      if (typeof config.theme === "string") {
        selector = config.theme;
      } else {
        const keys = Object.keys(config.theme);
        if (keys.length !== 1) {
          throw new ConfigError(`"theme" map supports exactly one theme key, got: ${keys.join(", ")}`);
        }
        selector = keys[0];
        themeOverrides = config.theme[keys[0]];
        this.log.debug(`theme overrides applied for "${selector}": ${Object.keys(themeOverrides).join(", ")}`);
      }
      const themeRoot = await resolveThemeDir(selector, this.rootDir, this.opts.defaultTheme);
      // pass the declared selector so theme errors show what the user wrote
      const theme = await loadTheme(themeRoot, themeOverrides, selector);
      this.log.info(`theme: ${theme.config.name} (${themeRoot})`);
      this._pendingThemeRoot = themeRoot;
      this._pendingTheme = theme;
    });

    q.on(Steps.PLUGINS_LOAD, async () => {
      this.assertCurrent(this.interruptToken);
      const config = this.currentConfig!;
      // theme config is already inside the loaded theme object
      const themeConfig = this._pendingTheme!.config;
      this.pluginContexts.clear();
      this.helperMap = {};
      const result = await loadAllPlugins({
        rootDir: this.rootDir,
        config,
        themeConfig,
        log: this.log,
        queue: this.queue,
        makeContext: this.makeContext,
        defaultPlugins: this.opts.defaultPlugins,
      });
      // keep the helperMap object identity stable: plugin contexts captured
      // it at creation time, so merge instead of reassigning
      Object.assign(this.helperMap, result.helperMap);
      // keep plugin load results for the new state; keep sources if partial
      this._pendingPlugins = result;
    });

    q.on(Steps.SOURCES_PARSE, async (payload) => {
      this.assertCurrent(this.interruptToken);
      const { reset, changed } = payload as { reset: string; changed: string[] };
      const config: UserConfig =
        reset === "all" ? this.currentConfig! : this.state!.config;
      const sourceDir = path.resolve(this.rootDir, config.source_dir ?? "source");

      if (reset === "all") {
        const sources = await this.parseAllSources(config, sourceDir, this._pendingPlugins!.parsers);
        this.state = {
          configFile: this._pendingConfigFile!,
          config,
          themeRoot: this._pendingThemeRoot!,
          theme: this._pendingTheme!,
          plugins: this._pendingPlugins!,
          sources,
          data: {} as SiteData,
        };
      } else if (reset === "theme") {
        this.state!.theme = this._pendingTheme!;
        this.state!.themeRoot = this._pendingThemeRoot!;
        // plugin set declared by the new theme.yaml is NOT reloaded on a theme
        // reset; a plugin change triggers a full run instead.
        this.refreshHelperMap();
      } else {
        // "sources": re-parse just the changed files (step 6, scoped)
        await this.reparseSources(sourceDir, this.state!.plugins.parsers, changed);
      }
      this.log.info(`sources: ${this.state!.sources.size} file(s) collected`);
    });

    q.on(Steps.DATA_PROCESS, async () => {
      this.assertCurrent(this.interruptToken);
      const st = this.state!;
      st.data = buildSiteData(st.config, st.sources, st.plugins.helpers, this.pluginContexts);
      this.log.info(
        `data: ${st.data.posts.length} post(s), ${Object.keys(st.data.tags).length} tag(s), ` +
          `${Object.keys(st.data.categories).length} category(ies)`,
      );
    });

    q.on(Steps.SITE_DEPLOY, async () => {
      this.assertCurrent(this.interruptToken);
      await this.deploy();
    });

    q.on(Steps.END, async () => {
      this.log.ok(`build finished → ${path.join(this.rootDir, this.state!.config.public_dir ?? "public")}`);
    });
  }

  private currentConfig: UserConfig | null = null;
  private _pendingConfigFile: string | null = null;
  private _pendingThemeRoot: string | null = null;
  private _pendingTheme: ThemeObject | null = null;
  private _pendingPlugins: LoadAllResult | null = null;

  private refreshHelperMap() {
    this.helperMap = {};
    for (const h of this.state!.plugins.helpers) {
      Object.assign(this.helperMap, h.helpers);
    }
    for (const ctx of this.pluginContexts.values()) {
      ctx.helpers = this.helperMap;
    }
  }

  // -------------------------------------------------------------------------
  // Source parsing (step 6)
  // -------------------------------------------------------------------------

  /**
   * Resolve the parser unit that handles a file extension: the first unit
   * (in plugin load order) whose declared extensions/types cover it wins.
   */
  private findParser(
    parsers: LoadedUnit<ParserUnitV1>[],
    ext: string,
  ): LoadedUnit<ParserUnitV1> | null {
    for (const p of parsers) {
      if (matchExtensions(p.unit.extensions, p.unit.types).has(ext)) return p;
    }
    return null;
  }

  private async parseAllSources(
    config: UserConfig,
    sourceDir: string,
    parsers: LoadedUnit<ParserUnitV1>[],
  ): Promise<Map<string, SourceObject>> {
    const sources = new Map<string, SourceObject>();
    if (!(await isDir(sourceDir))) {
      this.log.warn(`source directory ${sourceDir} does not exist — site will contain no content`);
      return sources;
    }
    const files = await walkFiles(sourceDir);
    const pool = new Pool(8);
    await pool.run(files, async (rel) => {
      const abs = path.join(sourceDir, rel);
      const ext = extOf(rel);
      const entry = this.findParser(parsers, ext);
      let obj: SourceObject | null;
      if (entry) {
        this.log.debug(`parse ${rel} via ${entry.unit.name}`);
        obj = await entry.unit.parseFile(this.pluginContexts.get(entry.plugin) ?? this.systemContext(), abs, await readBytes(abs));
      } else {
        this.log.debug(`asset ${rel} (no parser for ${ext || "raw file"})`);
        obj = this.assetObject(sourceDir, abs, rel);
      }
      if (obj) sources.set(abs, obj);
    });
    return sources;
  }

  private async reparseSources(sourceDir: string, parsers: LoadedUnit<ParserUnitV1>[], changed: string[]) {
    if (!this.state) return;
    for (const file of changed) {
      if (path.dirname(file) === this.rootDir || file === this.state.configFile) continue;
      const inSource = file.startsWith(sourceDir + path.sep);
      const inPlugins = file.includes(`${path.sep}.ngwg${path.sep}plugins${path.sep}`);
      if (!inSource && !inPlugins) continue;
      if (!(await exists(file))) {
        this.state.sources.delete(file);
        continue;
      }
      const rel = path.relative(sourceDir, file);
      const entry = this.findParser(parsers, extOf(file));
      let obj: SourceObject | null;
      if (entry) {
        obj = await entry.unit.parseFile(this.pluginContexts.get(entry.plugin) ?? this.systemContext(), file, await readBytes(file));
      } else if (inSource) {
        obj = this.assetObject(sourceDir, file, rel);
      } else {
        continue;
      }
      if (obj) this.state.sources.set(file, obj);
      else this.state.sources.delete(file);
    }
  }

  private systemContext(): PluginContext {
    let ctx = this.pluginContexts.get("__core__");
    if (!ctx) ctx = this.makeContext("__core__", false);
    return ctx;
  }

  private assetObject(sourceDir: string, abs: string, rel: string): SourceObject {
    return {
      path: abs,
      relPath: rel,
      url: "",
      kind: "asset",
      meta: {},
      raw: undefined, // filled lazily by deploy task building
      ext: extOf(rel),
    };
  }

  // -------------------------------------------------------------------------
  // Deploy (step 8)
  // -------------------------------------------------------------------------

  private async deploy() {
    const st = this.state!;
    const publicDir = path.resolve(this.rootDir, st.config.public_dir ?? "public");

    // fill asset bytes (kept out of parse step so watch reloads stay cheap)
    for (const obj of st.sources.values()) {
      if (obj.kind === "asset" && !obj.raw) {
        obj.raw = await readBytes(obj.path);
      }
    }

    const tasks = buildRenderTasks(st.data, st.theme, [...st.sources.values()].filter((s) => s.kind === "asset"), publicDir, this.helperMap);
    const env: DeployEnv = {
      rootDir: this.rootDir,
      publicDir,
      theme: st.theme,
      helpers: this.helperMap,
      site: st.data,
    };

    await rimraf(publicDir);
    await ensureDir(publicDir);

    // Partition tasks among deployer units: the first unit (in plugin load
    // order) whose declared types/extensions cover a task claims it.
    const deployers = st.plugins.deployers;
    const claimed: RenderTask[][] = deployers.map(() => []);
    const orphans: RenderTask[] = [];
    for (const task of tasks) {
      const kind: "page" | "asset" = task.copy ? "asset" : "page";
      const ext = path.extname(task.outPath).toLowerCase();
      const idx = deployers.findIndex((d) =>
        (d.unit.types ?? []).includes(kind) || matchExtensions(d.unit.extensions).has(ext),
      );
      if (idx === -1) orphans.push(task);
      else claimed[idx].push(task);
    }
    if (orphans.length > 0) {
      const sample = orphans[0];
      const covered = deployers.map((d) => `${d.unit.name} (${[...(d.unit.types ?? []), ...(d.unit.extensions ?? [])].join(", ")})`).join("; ");
      const msg =
        `${orphans.length} render task(s) match no deployer, e.g. "${path.relative(publicDir, sample.outPath)}" ` +
        `(kind: ${sample.copy ? "asset" : "page"}). Deployers loaded: ${covered || "none"}. ` +
        `Install a plugin providing ngwg-deployer-v1 that covers them, or extend the match of an existing deployer.`;
      this.log.error(msg);
      throw new Error(msg);
    }

    for (let i = 0; i < deployers.length; i++) {
      const d = deployers[i];
      const ctx = this.pluginContexts.get(d.plugin) ?? this.systemContext();
      this.log.debug(`deploy ${claimed[i].length} task(s) via deployer "${d.unit.name}"`);
      await d.unit.deploy(ctx, env, claimed[i]);
    }

    // helper plugins may generate extra artifacts into public/ (sitemap,
    // rss, …) once the pages are in place — protocol subset, fully optional
    for (const helper of st.plugins.helpers) {
      if (!helper.afterDeploy) continue;
      this.log.debug(`afterDeploy via helper "${helper.name}"`);
      const hctx = this.pluginContexts.get(helper.name) ?? this.systemContext();
      await helper.afterDeploy(hctx, env);
    }
    this.log.info(`deployed ${tasks.length} file(s) → ${publicDir}`);
  }
}
