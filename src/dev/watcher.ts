// File watcher for live-reload. Watches (recursively) the project config,
// the theme directory, the source directory and the plugin store, batches
// rapid events, and classifies each change so the dev daemon knows how far
// back to rewind the pipeline.

import { watch, type FSWatcher } from "node:fs";
import * as path from "node:path";

export type ChangeKind = "config" | "theme" | "source" | "plugin" | "other";

export interface FileChange {
  path: string;
  kind: ChangeKind;
}

export interface WatcherRoots {
  configFiles: string[];
  themeRoot: string | null;
  sourceDir: string | null;
  pluginDirs: string[];
}

export interface WatchTarget {
  root: string;
  kind: ChangeKind;
  /** watch a single file instead of the directory tree (config files) */
  file?: boolean;
}

export class Watcher {
  private watchers: FSWatcher[] = [];
  private pending = new Map<string, ChangeKind>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private roots: WatcherRoots,
    private onChange: (changes: FileChange[]) => void,
    private debounceMs = 120,
  ) {}

  updateRoots(roots: WatcherRoots) {
    this.roots = roots;
  }

  start() {
    const targets: WatchTarget[] = [];
    // watch the config *file* itself — watching its directory would also
    // pick up public/ writes and cause rebuild loops
    for (const f of this.roots.configFiles) targets.push({ root: f, kind: "config", file: true });
    if (this.roots.themeRoot) targets.push({ root: this.roots.themeRoot, kind: "theme" });
    if (this.roots.sourceDir) targets.push({ root: this.roots.sourceDir, kind: "source" });
    for (const d of this.roots.pluginDirs) targets.push({ root: d, kind: "plugin" });

    // longest prefix wins when roots overlap (e.g. root == theme root)
    for (const t of targets) {
      try {
        const w = watch(t.root, { recursive: !t.file }, (_event, filename) => {
          if (!filename) return;
          const abs = path.resolve(t.root, filename.toString());
          this.classify(abs);
        });
        this.watchers.push(w);
      } catch {
        // directory may not exist (e.g. no plugin store yet) — ignore
      }
    }
  }

  private classify(abs: string) {
    let kind: ChangeKind = "other";
    let bestLen = -1;
    const candidates: { p: string; kind: ChangeKind }[] = [
      ...this.roots.configFiles.map((f) => ({ p: path.resolve(f), kind: "config" as const })),
      ...(this.roots.themeRoot ? [{ p: this.roots.themeRoot, kind: "theme" as const }] : []),
      ...(this.roots.sourceDir ? [{ p: this.roots.sourceDir, kind: "source" as const }] : []),
      ...this.roots.pluginDirs.map((d) => ({ p: d, kind: "plugin" as const })),
    ];
    for (const c of candidates) {
      if ((abs === c.p || abs.startsWith(c.p + path.sep)) && c.p.length > bestLen) {
        kind = c.kind;
        bestLen = c.p.length;
      }
    }
    this.pending.set(abs, kind);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  private flush() {
    this.timer = null;
    if (this.pending.size === 0) return;
    const changes: FileChange[] = [...this.pending.entries()].map(([p, kind]) => ({ path: p, kind }));
    this.pending.clear();
    this.onChange(changes);
  }

  stop() {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Collapse a batch of changes into the strongest reset level + changed files. */
export function planReload(changes: FileChange[]): { reset: "all" | "theme" | "sources"; changed: string[] } {
  const kinds = new Set(changes.map((c) => c.kind));
  const changed = changes.map((c) => c.path);
  if (kinds.has("config") || kinds.has("plugin")) return { reset: "all", changed };
  if (kinds.has("theme")) {
    // a theme.yaml change may alter plugins/layouts — full run from theme step
    return { reset: "theme", changed };
  }
  return { reset: "sources", changed };
}
