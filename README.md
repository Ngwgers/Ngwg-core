# Ngwg-core

Ngwg 的核心库：事件队列、九步构建管线、dev server daemon、插件协议与加载器、
Fish 插件管理脚本。

## 提供什么

- `build(rootDir)` — 一次性构建（管线步骤 1-9）
- `startDevServer({ rootDir, port })` — dev daemon：静态服务 public/、监听配置/主题/源文件/插件变化、WebSocket live-reload
- 插件协议 `ngwg-parser-v1` / `ngwg-deployer-v1` / `ngwg-helper-v1` 的类型与运行时校验（`src/plugin/protocol.ts`）
- `EventQueue` — 工作流事件队列，受信插件可注入自定义事件
- 零依赖 YAML 子集解析器（配置、frontmatter 共用，也通过 `ctx.yaml` 提供给插件）

## 命令行

Core 不直接提供 CLI（见 Ngwg-cli），但插件管理脚本在这里：

```fish
fish scripts/ngwg-plugins.fish install <name> <url> [root]
fish scripts/ngwg-plugins.fish install-all [root]
fish scripts/ngwg-plugins.fish update <name> [root]
fish scripts/ngwg-plugins.fish update-all [root]
fish scripts/ngwg-plugins.fish list [root]
fish scripts/ngwg-plugins.fish remove <name> [root]
fish scripts/ngwg-plugins.fish path [root]
```

Core 在构建时发现插件缺失会自动调用该脚本抓取安装。

文档：[Ngwg-docs](../Ngwg-docs/core-development.md)。

## 许可证 / License

本项目基于 [GNU General Public License v3.0 (GPL-3.0)](LICENSE) 发布。
This project is licensed under the [GNU General Public License v3.0 (GPL-3.0)](LICENSE).

---

## English

# Ngwg-core

The core library of Ngwg: event queue, nine-step build pipeline, dev server daemon, plugin protocol and loader, and Fish plugin management scripts.

## What It Provides

- `build(rootDir)` — one-shot build (pipeline steps 1-9)
- `startDevServer({ rootDir, port })` — dev daemon: serves public/ statically, watches config/theme/source/plugin changes, WebSocket live-reload
- Types and runtime validation for the plugin protocols `ngwg-parser-v1` / `ngwg-deployer-v1` / `ngwg-helper-v1` (`src/plugin/protocol.ts`)
- `EventQueue` — workflow event queue; trusted plugins can inject custom events
- Zero-dependency YAML subset parser (shared by configuration and frontmatter, also exposed to plugins via `ctx.yaml`)

## Command Line

Core does not ship a CLI itself (see Ngwg-cli), but the plugin management scripts live here:

```fish
fish scripts/ngwg-plugins.fish install <name> <url> [root]
fish scripts/ngwg-plugins.fish install-all [root]
fish scripts/ngwg-plugins.fish update <name> [root]
fish scripts/ngwg-plugins.fish update-all [root]
fish scripts/ngwg-plugins.fish list [root]
fish scripts/ngwg-plugins.fish remove <name> [root]
fish scripts/ngwg-plugins.fish path [root]
```

When Core finds missing plugins during a build it automatically invokes this script to fetch and install them.

Documentation: [Ngwg-docs](../Ngwg-docs/core-development.md).

## License

This project is licensed under the [GNU General Public License v3.0 (GPL-3.0)](LICENSE).
