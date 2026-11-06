// The Ngwg event queue.
//
// The whole build workflow is expressed as events flowing through a single
// ordered queue. Built-in pipeline steps enqueue canonical events
// (config:check, config:load, ..., site:deploy) and Core registers handlers
// for them. Trusted plugins may splice their own events into the queue
// (injectAfter), which is how plugins extend the main workflow.
//
// Trust rule: injectAfter throws unless the calling plugin was explicitly
// trusted by the user with `plugins.<key>.security.allowCustomEvent: true`
// (key = the plugin's declaration key in ngwg.yaml).
//
// Reserved names: the canonical pipeline step names in `Steps` belong to the
// pipeline alone. Plugins may listen to them, but they may not emit them
// locally or inject events under those names — otherwise a plugin could run a
// core step handler a second time (or out of order).

export interface QueuedEvent {
  name: string;
  payload?: any;
  /** plugin name that injected this event, or null for core events */
  source: string | null;
}

type Handler = (payload: any, evt: QueuedEvent) => void | Promise<void>;

interface HandlerEntry {
  fn: Handler;
  /** plugin manifest name, or null for Core's own handlers */
  owner: string | null;
}

export class EventInjectionDenied extends Error {
  constructor(plugin: string) {
    super(
      `plugin "${plugin}" tried to inject a custom event into the main workflow, ` +
        `but it is not trusted. Add \`plugins.<key>.security.allowCustomEvent: true\` ` +
        `under the plugin's declaration key <key> in ngwg.yaml if you trust this plugin.`,
    );
  }
}

export class ReservedStepDenied extends Error {
  constructor(plugin: string, name: string) {
    super(
      `plugin "${plugin}" tried to use the reserved pipeline step name "${name}". ` +
        `Step names (${ALL_STEPS.join(", ")}) are emitted only by the pipeline itself; ` +
        `choose a plugin-specific event name such as "my-plugin:${name.replace(/:/g, "-")}".`,
    );
  }
}

export class EventQueue {
  private handlers = new Map<string, HandlerEntry[]>();
  private queue: QueuedEvent[] = [];
  private draining = false;
  /** set while draining so we can reject re-entrant workflow mutation */
  private current: QueuedEvent | null = null;

  /** Register a handler. `owner` null means a Core handler (kept on reset). */
  on(name: string, handler: Handler, owner: string | null = null): void {
    const list = this.handlers.get(name) ?? [];
    list.push({ fn: handler, owner });
    this.handlers.set(name, list);
  }

  /** Registered handlers for a name (used for plugin-local direct dispatch). */
  handlersFor(name: string): Handler[] {
    return (this.handlers.get(name) ?? []).map((e) => e.fn);
  }

  /** Append an event to the queue and drain until the queue is empty. */
  async emit(name: string, payload?: any, source: string | null = null): Promise<void> {
    this.queue.push({ name, payload, source });
    if (this.draining) return; // will be picked up by the running drain loop
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const evt = this.queue.shift()!;
        this.current = evt;
        for (const h of this.handlers.get(evt.name) ?? []) {
          await h.fn(evt.payload, evt);
        }
        this.current = null;
      }
    } finally {
      this.draining = false;
      this.current = null;
    }
  }

  /**
   * Splice a custom event into the main workflow, to be processed right after
   * the first *pending* occurrence of `afterStep`. If the step is not pending,
   * the event is appended to the end of the queue.
   *
   * This is the dangerous capability: only trusted plugins may call it.
   */
  async injectAfter(plugin: string, afterStep: string, evt: { name: string; payload?: any }): Promise<void> {
    if (!this.trustedPlugins.has(plugin)) {
      throw new EventInjectionDenied(plugin);
    }
    if (isReservedStep(evt.name)) {
      throw new ReservedStepDenied(plugin, evt.name);
    }
    const item: QueuedEvent = { name: evt.name, payload: evt.payload, source: plugin };
    const idx = this.queue.findIndex((q) => q.name === afterStep);
    if (idx >= 0) this.queue.splice(idx + 1, 0, item);
    else this.queue.push(item);
  }

  /** Plugins trusted for custom event injection */
  private trustedPlugins = new Set<string>();

  trustPlugin(plugin: string) {
    this.trustedPlugins.add(plugin);
  }

  /**
   * Drop every plugin-owned handler, the trust set and pending injected
   * events, keeping Core's own step handlers. Called before a full reload
   * reloads plugins so `onLoad` registrations cannot accumulate across runs
   * and a revoked `security.allowCustomEvent` takes effect immediately.
   */
  resetPlugins(): void {
    for (const [name, list] of this.handlers) {
      const kept = list.filter((e) => e.owner === null);
      if (kept.length > 0) this.handlers.set(name, kept);
      else this.handlers.delete(name);
    }
    this.trustedPlugins.clear();
    this.queue.length = 0;
  }
}

// Workflow step names. Plugins can reference these in injectAfter.
export const Steps = {
  START: "build:start",
  CONFIG_CHECK: "config:check",
  CONFIG_LOAD: "config:load",
  CONFIG_VALIDATE: "config:validate",
  THEME_LOAD: "theme:load",
  PLUGINS_LOAD: "plugins:load",
  SOURCES_PARSE: "sources:parse",
  DATA_PROCESS: "data:process",
  SITE_DEPLOY: "site:deploy",
  END: "build:end",
} as const;

export const ALL_STEPS: string[] = Object.values(Steps);

const RESERVED_STEPS = new Set(ALL_STEPS);

/** Whether a name belongs to the canonical pipeline (plugins may not emit it). */
export function isReservedStep(name: string): boolean {
  return RESERVED_STEPS.has(name);
}
