#!/usr/bin/env fish
# ngwg-plugins.fish — Ngwg plugin management (Fish glue, part of Ngwg-core).
#
# Plugins are declared by URL in ngwg.yaml / theme.yaml. This script fetches
# remote repos, precompiles when needed and installs them into the local
# plugin store (<project>/.ngwg/plugins or $NGWG_PLUGIN_DIR). It never talks
# to npm — the plugin store is just plain directories.
#
# Usage:
#   ngwg-plugins.fish install <name> <url> [project-root]
#   ngwg-plugins.fish install-all [project-root]     # everything in the configs
#   ngwg-plugins.fish list [project-root]
#   ngwg-plugins.fish remove <name> [project-root]
#   ngwg-plugins.fish path [project-root]            # print the plugin store

set -l script_dir (status dirname)

function plugin_store
    if set -q NGWG_PLUGIN_DIR
        echo $NGWG_PLUGIN_DIR
    else
        set -l root $argv[1]
        test -z "$root"; and set root .
        echo (realpath $root)/.ngwg/plugins
    end
end

function fail
    echo "ngwg-plugins: $argv[1]" >&2
    exit 1
end

# fetch_plugin <name> <url> <dest>
function fetch_plugin
    set -l name $argv[1]
    set -l url $argv[2]
    set -l dest $argv[3]

    if test -d "$dest"
        echo "plugin '$name' already installed at $dest"
        return 0
    end

    mkdir -p (dirname $dest)
    set -l tmp (mktemp -d)/$name

    switch $url
        case 'file://*'
            set -l src (string replace 'file://' '' -- $url)
            test -d "$src"; or fail "local plugin '$name' not found: $src"
            cp -r "$src" "$tmp"
        case 'https://*' 'http://*'
            if string match -q '*.tar.gz' $url; or string match -q '*.tgz' $url; or string match -q '*/archive/*' $url
                mkdir -p $tmp
                curl -fsSL "$url" | tar -xz --strip-components=1 -C $tmp
                or fail "could not download $url"
            else if string match -q '*.git' $url; or string match -q 'https://github.com/*' $url; or string match -q 'https://gitlab.com/*' $url; or string match -q 'https://*/*.git/*' $url
                git clone --depth 1 "$url" "$tmp" 2>/dev/null
                or fail "could not clone $url"
            else
                fail "unsupported remote plugin URL: $url (use a .git repo, a tarball, or a local path)"
            end
        case 'git@*'
            git clone --depth 1 "$url" "$tmp" 2>/dev/null
            or fail "could not clone $url"
        case '*/*'
            # local path (relative to CWD)
            test -d "$url"; or fail "local plugin '$name' not found: $url"
            cp -r "$url" "$tmp"
        case '*'
            # 'user/repo' shorthand → GitHub
            git clone --depth 1 "https://github.com/$url" "$tmp" 2>/dev/null
            or fail "could not clone https://github.com/$url"
    end

    precompile "$tmp"
    mkdir -p (dirname $dest)
    rm -rf "$dest"
    mv "$tmp" "$dest"
    rm -rf (dirname $tmp)
    echo "installed plugin '$name' → $dest"
end

# precompile <dir>: run the plugin's build.fish when present, or `bun install`
# when it declares dependencies. Entry .ts files need no build step — Bun runs
# TypeScript directly.
function precompile
    set -l dir $argv[1]
    if test -f "$dir/build.fish"
        echo "precompiling plugin (build.fish)…"
        fish "$dir/build.fish"
        or fail "plugin build.fish failed"
    else if test -f "$dir/package.json"; and grep -q '"dependencies"' "$dir/package.json" 2>/dev/null
        echo "precompiling plugin (bun install)…"
        bun install --cwd "$dir"
        or fail "bun install failed for plugin"
    end
end

function is_installed
    set -l name $argv[1]
    set -l root $argv[2]
    test -f (plugin_store $root)/$name/ngwg-plugin.yaml
end

# resolve plugin declarations from ngwg.yaml + theme.yaml via the TS helper
function read_declarations
    set -l root $argv[1]
    set -l core_root (realpath $script_dir/..)
    bun "$core_root/scripts/plugin-urls.ts" (realpath $root)
    or fail "could not read plugin declarations from $root"
end

set -l cmd $argv[1]
set -l rest $argv[2..]

switch $cmd
    case install
        set -l name $rest[1]
        set -l url $rest[2]
        set -l root $rest[3]
        test -z "$root"; and set root .
        test -n "$name"; or fail "usage: ngwg-plugins.fish install <name> <url> [project-root]"
        fetch_plugin "$name" "$url" (plugin_store $root)/$name

    case install-all
        set -l root $rest[1]
        test -z "$root"; and set root .
        set -l store (plugin_store $root)
        for line in (read_declarations $root)
            set -l parts (string split \t -- $line)
            set -l scope $parts[1]
            set -l name $parts[2]
            set -l url $parts[3]
            switch $scope
                case user theme-required
                    fetch_plugin "$name" "$url" "$store/$name"
                case theme-optional
                    if not is_installed "$name" "$root"
                        echo "安装这些插件可能获得更好体验: '$name' ($url)"
                        echo "  → fish $script_dir/ngwg-plugins.fish install $name \"$url\""
                    end
            end
        end

    case list
        set -l root $rest[1]
        test -z "$root"; and set root .
        set -l store (plugin_store $root)
        if test -d "$store"
            for dir in $store/*/
                set -l manifest $dir/ngwg-plugin.yaml
                if test -f "$manifest"
                    set -l pname (grep -E '^name:' "$manifest" | head -n1 | string replace -r '^name:\s*' '')
                    set -l pver (grep -E '^version:' "$manifest" | head -n1 | string replace -r '^version:\s*' '')
                    echo (basename $dir)"  ($pname $pver)"
                else
                    echo (basename $dir)"  (no manifest)"
                end
            end
        else
            echo "(plugin store is empty: $store)"
        end

    case remove
        set -l name $rest[1]
        set -l root $rest[2]
        test -z "$root"; and set root .
        set -l target (plugin_store $root)/$name
        test -d "$target"; or fail "plugin '$name' is not installed"
        rm -rf "$target"
        echo "removed plugin '$name'"

    case path
        set -l root $rest[1]
        test -z "$root"; and set root .
        plugin_store $root

    case '*'
        echo "usage: ngwg-plugins.fish {install|install-all|list|remove|path} [args]"
        echo "  install <name> <url> [root]   fetch & install one plugin"
        echo "  install-all [root]            install everything declared in ngwg.yaml / theme.yaml"
        echo "  list [root]                   list installed plugins"
        echo "  remove <name> [root]          remove an installed plugin"
        echo "  path [root]                   print the plugin store directory"
        exit 2
end
