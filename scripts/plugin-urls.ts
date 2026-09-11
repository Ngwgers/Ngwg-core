// Helper used by scripts/ngwg-plugins.fish (Fish stays the glue; this tiny
// Bun script only extracts plugin declarations from ngwg.yaml + theme.yaml).
//
// Usage: bun scripts/plugin-urls.ts <project-root>
// Prints one line per plugin:  <scope>\t<name>\t<url>
//   scope = user | theme-required | theme-optional

import * as path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parseYaml } from "../src/config/yaml.ts";

const root = process.argv[2];
if (!root) {
  console.error("usage: bun plugin-urls.ts <project-root>");
  process.exit(2);
}

const configPath = [path.join(root, "ngwg.yaml"), path.join(root, "ngwg.yml")].find((p) => existsSync(p));
if (configPath) {
  const cfg = parseYaml(readFileSync(configPath, "utf8"));
  for (const [name, url] of Object.entries(cfg?.plugins ?? {})) {
    if (typeof url === "string" && url.trim()) console.log(`user\t${name}\t${url.trim()}`);
  }
  // theme may be a string or a { <name-or-path>: { overrides } } map
  const theme = typeof cfg?.theme === "object" && cfg?.theme !== null ? Object.keys(cfg.theme)[0] : cfg?.theme;
  // resolve theme.yaml to read its plugin declarations too; the CLI exports
  // NGWG_DEFAULT_THEME (the ensured official default theme) — it only counts
  // when its manifest name actually matches the configured theme
  const candidates: string[] = [];
  if (typeof theme === "string") {
    if (theme.includes("/") || theme.startsWith(".")) candidates.push(path.resolve(root, theme));
    if (process.env.NGWG_THEMES) candidates.push(path.join(process.env.NGWG_THEMES, theme));
    if (process.env.HOME) candidates.push(path.join(process.env.HOME, ".ngwg", "themes", theme));
    const fallback = process.env.NGWG_DEFAULT_THEME;
    if (fallback && existsSync(path.join(fallback, "theme.yaml"))) {
      try {
        const manifest = parseYaml(readFileSync(path.join(fallback, "theme.yaml"), "utf8"));
        if (manifest?.name === theme) candidates.push(fallback);
      } catch {
        /* unreadable manifest — skip the fallback */
      }
    }
  }
  const themeRoot = candidates.find((p) => existsSync(path.join(p, "theme.yaml")));
  if (themeRoot) {
    const tc = parseYaml(readFileSync(path.join(themeRoot, "theme.yaml"), "utf8"));
    for (const [name, url] of Object.entries(tc?.plugins?.required ?? {})) {
      if (typeof url === "string" && url.trim()) console.log(`theme-required\t${name}\t${url.trim()}`);
    }
    for (const [name, url] of Object.entries(tc?.plugins?.optional ?? {})) {
      if (typeof url === "string" && url.trim()) console.log(`theme-optional\t${name}\t${url.trim()}`);
    }
  }
}
