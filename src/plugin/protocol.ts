// Plugin protocol definitions and runtime validation.
//
// A plugin module's default export is an object with any subset of three
// *arrays* — `parsers`, `deployers`, `helpers`. Each element is an
// independent, self-contained unit (e.g. a markdown parser or an HTML
// deployer) that declares which files/tasks it handles:
//
//   export default {
//     parsers:  [markdownParser],          // → ngwg-parser-v1
//     deployers: [templateDeployer],       // → ngwg-deployer-v1
//     helpers:  [featureHelpers],          // → ngwg-helper-v1
//     onLoad(ctx) { … }, onUnload() { … },
//   };
//
// The array a unit appears in determines its protocol; units carry no
// `protocol` field themselves. Core discovers at load time which protocols
// a module speaks — a plugin exporting only `helpers` is fully legal.

import type {
  DeployEnv,
  PluginContext,
  RenderTask,
  SourceObject,
} from "../types.ts";

export const PARSER_PROTOCOL = "ngwg-parser-v1";
export const DEPLOYER_PROTOCOL = "ngwg-deployer-v1";
export const HELPER_PROTOCOL = "ngwg-helper-v1";
export const OPTION_PROTOCOL = "ngwg-option-v1";

export const KNOWN_PROTOCOLS = [PARSER_PROTOCOL, DEPLOYER_PROTOCOL, HELPER_PROTOCOL, OPTION_PROTOCOL] as const;

/**
 * Built-in file types a parser unit can claim by name. A type is just a
 * named bundle of extensions; "按文件类型或文件后缀" — units may match by
 * either (or both; the match is the union of both sets).
 */
export const FILE_TYPES: Record<string, string[]> = {
  markdown: [".md", ".markdown"],
  html: [".html", ".htm"],
  text: [".txt", ".text"],
  json: [".json"],
  yaml: [".yaml", ".yml"],
  css: [".css"],
  image: [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".avif"],
};

/**
 * The two kinds of render tasks a deployer unit can claim: "page" tasks
 * render a theme layout, "asset" tasks copy bytes verbatim.
 */
export const TASK_TYPES = ["page", "asset"] as const;
export type TaskTypeV1 = (typeof TASK_TYPES)[number];

export interface ParserUnitV1 {
  /** unit name, e.g. "ngwg-markdown-parser" (used in logs and errors) */
  name: string;
  version: string;
  /** file extensions handled, lowercase with dot, e.g. [".md", ".markdown"] */
  extensions?: string[];
  /** file types handled, keys of FILE_TYPES, e.g. ["markdown"] */
  types?: string[];
  /**
   * convert one matched file into a SourceObject (or null to skip it).
   * May also return an ARRAY: the primary object plus any derived objects
   * the parser extracted from it (e.g. images referenced by a markdown
   * file). Each returned object must carry its own absolute `path` — the
   * engine keys the source map by it, and a parser's output takes
   * precedence over the plain-asset copy of the same file.
   */
  parseFile(ctx: PluginContext, filePath: string, content: Uint8Array):
    | Promise<SourceObject | SourceObject[] | null>
    | SourceObject
    | SourceObject[]
    | null;
}

export interface DeployerUnitV1 {
  /** unit name, e.g. "ngwg-template-deployer" (used in logs and errors) */
  name: string;
  version: string;
  /** output extensions handled, lowercase with dot, e.g. [".html"] */
  extensions?: string[];
  /** task kinds handled: "page" (layout render) and/or "asset" (verbatim copy) */
  types?: TaskTypeV1[];
  /**
   * catch-all: matches every task no regular deployer claimed. Must not be
   * combined with extensions/types. Deployers are consulted in load order
   * (user config → theme required → must-load fallback, flattened per-plugin
   * unit order); fallback units form the tail of that order.
   */
  fallback?: boolean;
  /** write the matched tasks into env.publicDir */
  deploy(ctx: PluginContext, env: DeployEnv, tasks: RenderTask[]): Promise<void> | void;
}

export interface HelperUnitV1 {
  name: string;
  version: string;
  /** functions exposed to themes as `h.<name>` inside templates */
  helpers: Record<string, (...args: any[]) => any>;
  /** optional: contribute extra data to site.data during pipeline step 7 */
  buildData?(ctx: PluginContext, site: any, sources: SourceObject[]): Promise<Record<string, any>> | Record<string, any>;
  /**
   * optional: called once after all deployers wrote public/ — lets a helper
   * unit generate extra artifacts (e.g. sitemap.xml, rss.xml). Writing
   * outside env.publicDir is a protocol violation.
   */
  afterDeploy?(ctx: PluginContext, env: DeployEnv): Promise<void> | void;
}

/**
 * Declares which options a plugin reads (ngwg-option-v1). Implementing this
 * protocol is the GATE for option exposure: a module without an options unit
 * never receives ctx.options, even when the user configured some.
 */
export interface OptionUnitV1 {
  name: string;
  version: string;
  /**
   * option keys this plugin publishes for multi-plugin collaboration. A user
   * key placed at `plugins.<name>.option.<key>` reaches other plugins'
   * ctx.options.shared only when listed here.
   */
  public?: string[];
  /**
   * option keys holding secrets (API keys, …). Users must place them under
   * `plugins.<name>.option.private.<key>`; a key listed here but placed at
   * the top level is rejected with a warning and never passed anywhere.
   */
  private?: string[];
  /** opt in to reading other plugins' public options via ctx.options.shared */
  readShared?: boolean;
}

export type ProtocolUnit = ParserUnitV1 | DeployerUnitV1 | HelperUnitV1 | OptionUnitV1;

export interface PluginModule {
  parsers?: ParserUnitV1[];
  deployers?: DeployerUnitV1[];
  helpers?: HelperUnitV1[];
  options?: OptionUnitV1[];
  onLoad?(ctx: PluginContext): void | Promise<void>;
  onUnload?(): void | Promise<void>;
}

export interface PluginLoadResult {
  ok: boolean;
  /** which protocols the module implements (empty when invalid) */
  protocols: string[];
  unitNames: string[];
  errors: string[];
  module?: PluginModule;
  parsers: ParserUnitV1[];
  deployers: DeployerUnitV1[];
  helpers: HelperUnitV1[];
  options: OptionUnitV1[];
}

function isObject(v: any): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isUnitList(v: any): boolean {
  return v === undefined || (Array.isArray(v) && v.every((e) => isObject(e)));
}

/** Expand a unit's `types` + `extensions` into one lowercase extension set. */
export function matchExtensions(extensions?: string[], types?: string[], registry: Record<string, string[]> = FILE_TYPES): Set<string> {
  const set = new Set<string>();
  for (const e of extensions ?? []) set.add(e.toLowerCase());
  for (const t of types ?? []) for (const e of registry[t] ?? []) set.add(e.toLowerCase());
  return set;
}

function validateExtensions(list: any, label: string, errors: string[]): boolean {
  if (!Array.isArray(list) || list.some((e: any) => typeof e !== "string" || !e.startsWith("."))) {
    errors.push(`${label}: "extensions" must be an array of dot-prefixed strings (e.g. [".md"])`);
    return false;
  }
  return true;
}

function validateParserUnit(unit: any, label: string, errors: string[]): void {
  const hasExt = Array.isArray(unit.extensions) && unit.extensions.length > 0;
  const hasTypes = Array.isArray(unit.types) && unit.types.length > 0;
  if (!hasExt && !hasTypes) {
    errors.push(`${label}: parser unit must declare what it handles — a non-empty "extensions" array of dot-prefixed strings and/or a non-empty "types" array of file types (${Object.keys(FILE_TYPES).join(", ")})`);
  }
  if (unit.extensions !== undefined && !validateExtensions(unit.extensions, label, errors)) return;
  if (unit.types !== undefined) {
    for (const t of unit.types) {
      if (!FILE_TYPES[t]) {
        errors.push(`${label}: unknown file type ${JSON.stringify(t)}; known types: ${Object.keys(FILE_TYPES).join(", ")}`);
      }
    }
  }
  if (typeof unit.parseFile !== "function") {
    errors.push(`${label}: parser unit must implement parseFile(ctx, filePath, content)`);
  }
}

function validateDeployerUnit(unit: any, label: string, errors: string[]): void {
  if (unit.fallback !== undefined && typeof unit.fallback !== "boolean") {
    errors.push(`${label}: "fallback" must be a boolean when provided`);
    return;
  }
  if (unit.fallback === true) {
    if (unit.extensions !== undefined || unit.types !== undefined) {
      errors.push(`${label}: a fallback deployer matches everything unclaimed — it must not declare "extensions" or "types"`);
    }
  } else {
    const hasExt = Array.isArray(unit.extensions) && unit.extensions.length > 0;
    const hasTypes = Array.isArray(unit.types) && unit.types.length > 0;
    if (!hasExt && !hasTypes) {
      errors.push(`${label}: deployer unit must declare what it handles — a non-empty "types" array of task kinds (${TASK_TYPES.join(", ")}) and/or a non-empty "extensions" array of output extensions, or "fallback: true"`);
    }
    if (unit.extensions !== undefined && !validateExtensions(unit.extensions, label, errors)) return;
    if (unit.types !== undefined) {
      for (const t of unit.types) {
        if (!TASK_TYPES.includes(t)) {
          errors.push(`${label}: unknown task kind ${JSON.stringify(t)}; known kinds: ${TASK_TYPES.join(", ")}`);
        }
      }
    }
  }
  if (typeof unit.deploy !== "function") {
    errors.push(`${label}: deployer unit must implement deploy(ctx, env, tasks)`);
  }
}

function validateHelperUnit(unit: any, label: string, errors: string[]): void {
  if (!isObject(unit.helpers)) {
    errors.push(`${label}: helper unit must provide a "helpers" object of functions`);
  } else {
    for (const [k, fn] of Object.entries(unit.helpers)) {
      if (typeof fn !== "function") errors.push(`${label}: helper "${k}" is not a function`);
    }
  }
  if (unit.afterDeploy !== undefined && typeof unit.afterDeploy !== "function") {
    errors.push(`${label}: helper unit "afterDeploy" must be a function when provided`);
  }
}

function validateOptionUnit(unit: any, label: string, errors: string[]): void {
  for (const key of ["public", "private"] as const) {
    const v = unit[key];
    if (v !== undefined && (!Array.isArray(v) || v.some((e: any) => typeof e !== "string"))) {
      errors.push(`${label}: option unit "${key}" must be an array of option-key strings when provided`);
    }
  }
  if (unit.readShared !== undefined && typeof unit.readShared !== "boolean") {
    errors.push(`${label}: option unit "readShared" must be a boolean when provided`);
  }
}

/**
 * Runtime-validate an imported plugin module. Returns everything Core needs
 * to decide whether the plugin can be used and which protocols it speaks.
 * A module exporting none of the arrays is a load failure.
 */
export function validatePluginModule(mod: any, label: string): PluginLoadResult {
  const errors: string[] = [];
  const parsers: ParserUnitV1[] = [];
  const deployers: DeployerUnitV1[] = [];
  const helpers: HelperUnitV1[] = [];
  const options: OptionUnitV1[] = [];

  if (!isObject(mod)) {
    errors.push(
      `${label}: expected an object exporting { parsers, deployers, helpers, options } unit arrays (ngwg-*-v1), got ${Array.isArray(mod) ? "an array" : typeof mod}`,
    );
  } else {
    for (const key of ["parsers", "deployers", "helpers", "options"] as const) {
      if (!isUnitList(mod[key])) {
        errors.push(`${label}: "${key}" must be an array of unit objects (or omitted)`);
      }
    }
    if (errors.length === 0) {
      (mod.parsers ?? []).forEach((unit: any, i: number) => {
        if (typeof unit?.name !== "string" || !unit.name) errors.push(`${label}[parsers][${i}]: missing "name"`);
        if (typeof unit?.version !== "string" || !unit.version) errors.push(`${label}[parsers][${i}]: missing "version"`);
        const before = errors.length;
        validateParserUnit(unit, `${label}[parsers][${i}]`, errors);
        if (errors.length === before) parsers.push(unit);
      });
      (mod.deployers ?? []).forEach((unit: any, i: number) => {
        if (typeof unit?.name !== "string" || !unit.name) errors.push(`${label}[deployers][${i}]: missing "name"`);
        if (typeof unit?.version !== "string" || !unit.version) errors.push(`${label}[deployers][${i}]: missing "version"`);
        const before = errors.length;
        validateDeployerUnit(unit, `${label}[deployers][${i}]`, errors);
        if (errors.length === before) deployers.push(unit);
      });
      (mod.helpers ?? []).forEach((unit: any, i: number) => {
        if (typeof unit?.name !== "string" || !unit.name) errors.push(`${label}[helpers][${i}]: missing "name"`);
        if (typeof unit?.version !== "string" || !unit.version) errors.push(`${label}[helpers][${i}]: missing "version"`);
        const before = errors.length;
        validateHelperUnit(unit, `${label}[helpers][${i}]`, errors);
        if (errors.length === before) helpers.push(unit);
      });
      (mod.options ?? []).forEach((unit: any, i: number) => {
        if (typeof unit?.name !== "string" || !unit.name) errors.push(`${label}[options][${i}]: missing "name"`);
        if (typeof unit?.version !== "string" || !unit.version) errors.push(`${label}[options][${i}]: missing "version"`);
        const before = errors.length;
        validateOptionUnit(unit, `${label}[options][${i}]`, errors);
        if (errors.length === before) options.push(unit);
      });
    }
  }

  if (parsers.length === 0 && deployers.length === 0 && helpers.length === 0 && options.length === 0 && errors.length === 0) {
    errors.push(
      `${label}: module implements none of the known protocols (${KNOWN_PROTOCOLS.join(", ")}) — export a non-empty parsers/deployers/helpers/options array`,
    );
  }

  const protocols: string[] = [];
  if (parsers.length > 0) protocols.push(PARSER_PROTOCOL);
  if (deployers.length > 0) protocols.push(DEPLOYER_PROTOCOL);
  if (helpers.length > 0) protocols.push(HELPER_PROTOCOL);
  if (options.length > 0) protocols.push(OPTION_PROTOCOL);

  return {
    ok: errors.length === 0 && protocols.length > 0,
    protocols,
    unitNames: [...parsers, ...deployers, ...helpers, ...options].map((u) => u.name),
    errors,
    module: isObject(mod) ? (mod as PluginModule) : undefined,
    parsers,
    deployers,
    helpers,
    options,
  };
}
