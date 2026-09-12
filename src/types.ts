// Ngwg-core — shared domain types.
// These types describe the data that flows through the build pipeline:
// source files -> SourceObject -> SiteData -> RenderTask -> public/ output.

/** A single file inside the user's source directory, converted by a parser plugin. */
export interface SourceObject {
  /** absolute path of the source file */
  path: string;
  /** path relative to the source directory */
  relPath: string;
  /** site URL this object is published at, e.g. "/posts/hello/" ("" for assets) */
  url: string;
  /** posts live in source/_posts (or frontmatter date), everything else is a page */
  kind: "post" | "page" | "asset";
  /** frontmatter / metadata produced by the parser */
  meta: Record<string, any>;
  /** raw text body (markdown source) when applicable */
  body?: string;
  /** rendered HTML body when the parser produces one */
  html?: string;
  /**
   * rendered HTML of the part before the `<!-- more -->` marker — the
   * excerpt (前言/摘要) shown on listing pages. Absent when the post has
   * no marker (themes fall back to an auto-generated plain excerpt).
   */
  excerptHtml?: string;
  /** binary payload for asset files that are copied verbatim */
  raw?: Uint8Array;
  /** lowercase extension including the dot, e.g. ".md" */
  ext: string;
}

export interface ThemeObject {
  config: ThemeConfig;
  /** absolute path of the theme root */
  root: string;
  /** layout templates, name -> template source (from layout/*.html) */
  layouts: Record<string, string>;
  /** partial templates (from partial/*.html) */
  partials: Record<string, string>;
  /**
   * theme i18n translations (from i18n/<lang>.yaml), keyed by the normalized
   * language tag (lang_REGION, e.g. "zh_CN") — values are the YAML documents
   * as parsed (nested maps of strings). Empty when the theme ships none.
   */
  i18n: Record<string, Record<string, any>>;
  /** static assets shipped with the theme (from assets/**) */
  assets: { relPath: string; content: Uint8Array }[];
}

export interface ArchiveGroup {
  name: string;
  url: string;
  posts: SourceObject[];
}

/** Everything produced by the data-processing step (pipeline step 7). */
export interface SiteData {
  title: string;
  description: string;
  baseurl: string;
  /** all posts, sorted by date descending (frontmatter `hidden: true` excluded) */
  posts: SourceObject[];
  /**
   * hidden posts (`hidden: true`): still deployed and reachable at their URL
   * via their own page task, but absent from every listing (index, tags,
   * categories, archives) and from RSS/sitemap
   */
  hiddenPosts: SourceObject[];
  /** all non-post pages */
  pages: SourceObject[];
  /** tag name -> posts */
  tags: Record<string, SourceObject[]>;
  /** category name -> posts */
  categories: Record<string, SourceObject[]>;
  /** archive groups (by year by default) */
  archives: ArchiveGroup[];
  /** extra data contributed by helper plugins via buildData() */
  extra: Record<string, any>;
}

export interface RenderTask {
  /** absolute path of the output file inside public/ */
  outPath: string;
  /** render a named theme layout with `context` */
  template?: string;
  context?: Record<string, any>;
  /** or copy binary content verbatim (theme/source assets) */
  copy?: { content: Uint8Array };
}

/** Environment handed to a deployer plugin once per deploy run. */
export interface DeployEnv {
  rootDir: string;
  publicDir: string;
  theme: ThemeObject;
  /** helper functions exposed by ngwg-helper-v1 plugins */
  helpers: Record<string, (...args: any[]) => any>;
  site: SiteData;
  /**
   * deployment language, normalized to lang_REGION ("zh_CN") — taken from
   * `language` in ngwg.yaml or the $NGWG_LANG environment variable;
   * undefined when the user set neither (the deployer then falls back to the
   * theme's default_language)
   */
  language?: string;
}

// ---------------------------------------------------------------------------
// User & theme configuration (parsed from YAML)
// ---------------------------------------------------------------------------

export interface UserConfig {
  title: string;
  description?: string;
  baseurl?: string;
  /** site origin for absolute URLs (RSS, sitemap, canonical), e.g. "https://example.com" */
  url?: string;
  /**
   * theme name (resolved from bundled themes) or a filesystem path — or a
   * map with exactly one such key whose value overrides the theme's own
   * config, so users can tweak a theme without editing it:
   *
   *   theme:
   *     pacific:
   *       per_page: 5
   *       layouts:
   *         post: post
   */
  theme: string | Record<string, Record<string, any>>;
  source_dir?: string;
  public_dir?: string;
  /** plugin name -> URL/path — or a declaration object with options */
  plugins?: Record<string, string | PluginDeclaration>;
  /** per-plugin options; `plugin.<name>.allowCustomEvent` gates event injection */
  plugin?: Record<string, Record<string, any>>;
  /**
   * deployment language for i18n-aware themes ("zh-CN", "zh_CN.UTF-8" and
   * friends are all accepted and normalized to lang_REGION). Overrides
   * nothing else; $NGWG_LANG is used when this is absent.
   */
  language?: string;
  /** dev server port */
  dev_port?: number;
  /**
   * dev server throttling in KB/s (a 10 KB file takes ~1s at 10) to test
   * weak-network reachability; 0 or negative disables it (default)
   */
  dev_speed?: number;
}

/**
 * A plugin declaration with options: `plugins.<name>` in ngwg.yaml may be a
 * plain URL string or an object of this shape.
 */
export interface PluginDeclaration {
  /** where to fetch/load the plugin from (same semantics as the string form) */
  url: string;
  /**
   * options for the plugin. Top-level keys are public candidates (shareable
   * with other opted-in plugins, as far as the plugin declares them public);
   * `private.<key>` holds secrets (API keys, …) that only the plugin itself
   * can read. Exposure is gated by the plugin implementing ngwg-option-v1.
   */
  option?: Record<string, any>;
}

/**
 * Option exposure for plugins implementing ngwg-option-v1. Absent on the
 * context when the plugin does not implement the protocol — configuration
 * is then never handed to the plugin.
 */
export interface PluginOptions {
  /** the plugin's own options: `option.*` plus its `option.private.*` flattened in */
  self: Record<string, any>;
  /**
   * other plugins' public options keyed by their manifest name — only
   * populated when the reading plugin declared `readShared: true`
   */
  shared: Record<string, Record<string, any>>;
}

export interface ThemeConfig {
  name: string;
  version?: string;
  description?: string;
  /** layout name overrides: page kind -> layout file base name */
  layouts?: Record<string, string>;
  /** plugins a theme requires to work; name -> URL */
  plugins?: {
    required?: Record<string, string>;
    /** nice-to-have plugins; never fetched automatically */
    optional?: Record<string, string>;
  };
  /** posts per page on index listing (default 10) */
  per_page?: number;
  /**
   * language used when the user set neither `language` nor $NGWG_LANG —
   * must match an i18n/<lang>.yaml file name of this theme
   */
  default_language?: string;
}

// ---------------------------------------------------------------------------
// Plugin protocol types — see src/plugin/protocol.ts for runtime validation.
// ---------------------------------------------------------------------------

export interface PluginContext {
  coreVersion: string;
  /** project root (the directory containing ngwg.yaml) */
  rootDir: string;
  config: UserConfig;
  trusted: boolean;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
  };
  /** read-only view over every helper registered by helper plugins */
  helpers: Record<string, (...args: any[]) => any>;
  /** YAML utilities provided by Core (same subset parser Core itself uses) */
  yaml: {
    parse(text: string): any;
  };
  /**
   * path relative to the configured source directory (posix separators) —
   * the canonical way a parser derives SourceObject.relPath from the
   * absolute filePath it receives
   */
  relPath(filePath: string): string;
  /**
   * options exposure (ngwg-option-v1). Only present when the plugin module
   * implements the protocol; otherwise configuration is never handed over.
   */
  options?: PluginOptions;
  events: {
    /** listen to a workflow event (built-in steps or injected custom events) */
    on(name: string, handler: (payload: any) => void | Promise<void>): void;
    /** emit a plugin-local event; runs registered handlers, never touches the workflow */
    emit(name: string, payload?: any): Promise<void>;
    /**
     * inject a custom event into the main workflow after a built-in step.
     * Throws unless the plugin is trusted via `plugin.<name>.allowCustomEvent: true`.
     */
    injectAfter(afterStep: string, evt: { name: string; payload?: any }): Promise<void>;
  };
}
