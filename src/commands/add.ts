// `ngwg add` — create a new post.
//
// Two modes:
//   interactive (default)  a minimal TUI: title, publish date (pre-filled
//                          with today, editable), tags, categories; ↑↓ to
//                          move between fields, Enter to confirm
//   flags (any of -L/-T/-C/-D)  create without a UI:
//                          ngwg add -L "标题" -T tag1 tag2 -C 分类 -D 2026-05-05
//                          (-D defaults to today; -L is required here)
//
// The post lands in <source_dir>/_posts/<date>-<slug>.md.

import { loadUserConfig, ConfigError } from "../config/loader.ts";
import { slugify } from "../core/tasks.ts";
import { exists, writeText } from "../util/fs.ts";
import { Logger } from "../util/log.ts";
import * as path from "node:path";

export interface AddArgs {
  label?: string;
  tags: string[];
  categories: string[];
  date?: string;
  help: boolean;
  /** true when the caller passed any content flag → non-interactive mode */
  flagsMode: boolean;
}

/** Parse `ngwg add` arguments. -T/-C collect values until the next flag. */
export function parseAddArgs(argv: string[]): AddArgs {
  const out: AddArgs = { tags: [], categories: [], help: false, flagsMode: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const collect = (): string[] => {
      const vals: string[] = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        vals.push(argv[++i]);
      }
      return vals;
    };
    switch (a) {
      case "-L":
      case "--label":
      case "--title":
        out.label = argv[++i];
        break;
      case "-T":
      case "--tags":
        out.tags.push(...collect());
        break;
      case "-C":
      case "--categories":
      case "--category":
        out.categories.push(...collect());
        break;
      case "-D":
      case "--date":
        out.date = argv[++i];
        break;
      case "-h":
      case "--help":
        out.help = true;
        break;
      default:
        if (a.startsWith("-")) {
          throw new Error(`unknown flag '${a}' (supported: -L -T -C -D -h)`);
        }
        throw new Error(
          `unexpected argument '${a}' — use flags (-L -T -C -D) or run \`ngwg add\` without args for the interactive form`,
        );
    }
  }
  out.flagsMode = out.label !== undefined || out.tags.length > 0 || out.categories.length > 0 || out.date !== undefined;
  return out;
}

export const ADD_USAGE = `usage: ngwg add [-L title] [-T tag...] [-C category...] [-D date]

  ngwg add                          interactive form (TUI)
  ngwg add -L "你好 世界"            flags mode; -D defaults to today
  ngwg add -L 标题 -T tag1 tag2 -C 分类 -D 2026-05-05

  -L, --label <title>      post title
  -T, --tags <tag...>      tags (space separated)
  -C, --categories <c...>  categories (space separated)
  -D, --date <YYYY-MM-DD>  publish date (default: today)`;

export function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Quote a scalar for the frontmatter so `:` `#` `"` never break the YAML. */
function yamlScalar(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlList(name: string, values: string[]): string {
  if (values.length === 0) return "";
  return `${name}:\n${values.map((v) => `  - ${yamlScalar(v)}`).join("\n")}\n`;
}

/** The post file content (exported for tests). */
export function buildPostContent(args: { label: string; date: string; tags: string[]; categories: string[] }): string {
  let fm = `---\ntitle: ${yamlScalar(args.label)}\ndate: ${yamlScalar(args.date)}\n`;
  fm += yamlList("tags", args.tags);
  fm += yamlList("categories", args.categories);
  fm += `---\n\n# ${args.label}\n\n从这里开始写。\n`;
  return fm;
}

/** Resolve where the new post goes (exported for tests). */
export async function resolveTarget(
  rootDir: string,
  args: { label: string; date: string; tags: string[]; categories: string[] },
): Promise<{ file: string; content: string }> {
  const config = await loadUserConfig(rootDir).catch((e) => {
    throw new ConfigError(`${(e as Error).message}\n运行 \`ngwg init\` 先创建站点配置。`);
  });
  const postsDir = path.resolve(rootDir, config.source_dir ?? "source", "_posts");
  const file = path.join(postsDir, `${args.date}-${slugify(args.label)}.md`);
  return { file, content: buildPostContent(args) };
}

function validDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(new Date(v).getTime());
}

export async function addCommand(argv: string[], rootDir: string, log: Logger): Promise<void> {
  const args = parseAddArgs(argv);
  if (args.help) {
    console.log(ADD_USAGE);
    return;
  }

  let parsed: { label: string; date: string; tags: string[]; categories: string[] };

  if (!args.flagsMode) {
    if (!process.stdin.isTTY) {
      throw new Error("stdin 不是终端，无法启动交互界面 —— 请使用参数：\n" + ADD_USAGE);
    }
    const form = await runTui(rootDir);
    if (!form) {
      log.info("已取消，未创建任何文件");
      return;
    }
    parsed = form;
  } else {
    if (!args.label || !args.label.trim()) {
      throw new Error("无界面模式需要标题：ngwg add -L \"标题\"（或运行 ngwg add 进入交互界面）\n" + ADD_USAGE);
    }
    const date = args.date ?? today();
    if (!validDate(date)) {
      throw new Error(`日期格式应为 YYYY-MM-DD，收到：${args.date}`);
    }
    parsed = { label: args.label.trim(), date, tags: args.tags, categories: args.categories };
  }

  const { file, content } = await resolveTarget(rootDir, parsed);
  if (await exists(file)) {
    throw new Error(`文件已存在：${file}`);
  }
  await writeText(file, content);
  log.ok(`已创建 ${file}`);
}

// --- minimal TUI -------------------------------------------------------------
// Zero-dependency form on a raw-mode stdin: printable keys edit the active
// field, Backspace deletes, ↑/↓ move between fields, Enter advances/confirms,
// `e` on the confirmation screen resumes editing with the entered values.

interface Field {
  label: string;
  value: string;
  placeholder: string;
}

interface FormResult {
  label: string;
  date: string;
  tags: string[];
  categories: string[];
}

function splitList(v: string): string[] {
  return v
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function readKey(): Promise<string> {
  return new Promise((resolve) => {
    const cb = (data: Buffer) => {
      process.stdin.removeListener("data", cb);
      resolve(data.toString());
    };
    process.stdin.on("data", cb);
  });
}

const CLEAR = "\x1b[2J\x1b[H";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function newFields(): Field[] {
  return [
    { label: "标题", value: "", placeholder: "文章标题（必填）" },
    { label: "日期", value: today(), placeholder: "YYYY-MM-DD" },
    { label: "标签", value: "", placeholder: "逗号分隔，可留空" },
    { label: "分类", value: "", placeholder: "逗号分隔，可留空" },
  ];
}

async function runTui(rootDir: string): Promise<FormResult | null> {
  return runTuiSession(rootDir, newFields());
}

/** The form + confirmation loop (fresh start and "返回编辑" share it). */
async function runTuiSession(rootDir: string, fields: Field[]): Promise<FormResult | null> {
  let active = 0;
  let message = "";

  process.stdin.setRawMode(true);
  try {
    while (true) {
      let out = `${CLEAR}\n  ngwg add — 新文章\n\n`;
      fields.forEach((f, i) => {
        const cur = i === active;
        const text = f.value || (cur ? "" : `${DIM}${f.placeholder}${RESET}`);
        out += `  ${cur ? `${CYAN}▸${RESET}` : " "} ${f.label}  ${cur ? `${CYAN}${f.value}${RESET}` : text}${cur ? "█" : ""}\n`;
      });
      out += `\n  ${DIM}Enter 下一项 / ↑↓ 切换字段 / Ctrl+C 取消${RESET}\n`;
      if (message) out += `  ${YELLOW}${message}${RESET}\n`;
      process.stdout.write(out);
      message = "";

      const key = await readKey();
      if (key === "\x03") return null; // Ctrl+C
      if (key === "\x7f" || key === "\b") {
        fields[active].value = fields[active].value.slice(0, -1);
        continue;
      }
      if (key === "\x1b[A") {
        active = (active + fields.length - 1) % fields.length;
        continue;
      }
      if (key === "\x1b[B") {
        active = (active + 1) % fields.length;
        continue;
      }
      if (key === "\r" || key === "\n") {
        if (active < fields.length - 1) {
          active++;
          continue;
        }
        if (!fields[0].value.trim()) {
          message = "标题不能为空";
          active = 0;
          continue;
        }
        if (!validDate(fields[1].value.trim())) {
          message = `日期格式应为 YYYY-MM-DD，收到：${fields[1].value.trim() || "(空)"}`;
          active = 1;
          continue;
        }
        break; // move to confirmation
      }
      const printable = key.replace(/[\x00-\x1f\x7f]/g, "");
      if (printable) fields[active].value += printable;
    }

    const parsed: FormResult = {
      label: fields[0].value.trim(),
      date: fields[1].value.trim(),
      tags: splitList(fields[2].value),
      categories: splitList(fields[3].value),
    };

    // ---- confirmation loop ----
    while (true) {
      const target = await resolveTarget(rootDir, parsed).catch((e: Error) => ({
        file: `（配置错误：${e.message.split("\n")[0]}）`,
        content: "",
      }));
      process.stdout.write(
        `${CLEAR}\n  即将创建：\n\n    ${target.file}\n\n` +
          DIM +
          target.content
            .split("\n")
            .map((l) => `    ${l}`)
            .join("\n") +
          RESET +
          `\n\n  ${CYAN}Y${RESET} 创建 · ${CYAN}e${RESET} 返回编辑 · ${CYAN}q${RESET} 取消\n`,
      );
      const key = (await readKey()).toLowerCase();
      if (key === "y" || key === "\r" || key === "\n") return parsed;
      if (key === "e" || key === "\x1b[A" || key === "\x1b[B") {
        active = 0;
        return await runTuiSession(rootDir, fields); // resume editing, values kept
      }
      if (key === "q" || key === "\x03") return null;
    }
  } finally {
    process.stdin.setRawMode(false);
  }
}
