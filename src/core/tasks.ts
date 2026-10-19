// Step 8 preparation: turn SiteData + Theme into a flat list of RenderTasks.
// The deployer plugin is responsible for turning these tasks into files under
// public/ — Core owns the *what* (pages, urls, layout mapping), the deployer
// owns the *how* (template engine, writing).

import * as path from "node:path";
import type { RenderTask, SiteData, SourceObject, ThemeObject } from "../types.ts";
import { themeLayoutExt, themeLayoutMap } from "./theme.ts";

export function slugify(s: string): string {
  return (
    s
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "untitled"
  );
}

function outPath(publicDir: string, url: string): string {
  return path.join(publicDir, url.replace(/^\//, ""), "index.html");
}

/**
 * Root render context for a page task.
 *
 * `theme` is the merged theme config (theme.yaml + declaration options + the
 * user's `theme.<name>` overrides) — themes read their own settings from it
 * (`theme.profile.name`, `theme.banner.title`, …) without Core knowing any of
 * those keys. `config` is kept as an alias of the site data for older themes.
 */
export function pageContext(
  site: SiteData,
  page: any,
  helpers: Record<string, any>,
  themeConfig: Record<string, any> = {},
): Record<string, any> {
  return { site, page, h: helpers, config: site, theme: themeConfig };
}

export function buildRenderTasks(
  site: SiteData,
  theme: ThemeObject,
  sourceAssets: SourceObject[],
  publicDir: string,
  helpers: Record<string, any>,
): RenderTask[] {
  const tasks: RenderTask[] = [];
  const claimed = new Set<string>();
  const addTask = (task: RenderTask) => {
    // explicit posts/pages win over generated pages (index pagination,
    // archive/tag/category listings) when they target the same URL
    if (claimed.has(task.outPath)) return;
    claimed.add(task.outPath);
    tasks.push(task);
  };
  const layouts = themeLayoutMap(theme);
  const perPage = Math.max(1, theme.config.per_page ?? 10);

  // page task: carries the layout's source extension so deployers can be
  // dispatched by suffix (an .ejs layout → the EJS deployer, …)
  const pageTask = (url: string, templateName: string, context: Record<string, any>): RenderTask => ({
    outPath: outPath(publicDir, url),
    template: templateName,
    templateExt: themeLayoutExt(theme, templateName),
    context,
  });

  // posts — including hidden ones: a hidden post keeps its own page (it must
  // stay reachable at its URL) but appears in no listing built from site.posts
  for (const post of [...site.posts, ...(site.hiddenPosts ?? [])]) {
    addTask(pageTask(post.url, post.meta.layout ?? layouts.post, pageContext(site, post, helpers, theme.config as Record<string, any>)));
  }

  // regular pages
  for (const page of site.pages) {
    addTask(pageTask(page.url, page.meta.layout ?? layouts.page, pageContext(site, page, helpers, theme.config as Record<string, any>)));
  }

  // index with pagination: /, /page/2/, ... (page 1 yields to an explicit
  // source page that claimed "/")
  const pageCount = Math.max(1, Math.ceil(site.posts.length / perPage));
  for (let n = 1; n <= pageCount; n++) {
    const slice = site.posts.slice((n - 1) * perPage, n * perPage);
    const pageNum = n;
    // next = older posts, prev = newer posts
    const prev = n > 1 ? (n - 1 === 1 ? "/" : `/page/${n - 1}/`) : null;
    const next = n < pageCount ? `/page/${n + 1}/` : null;
    addTask(
      pageTask(
        n === 1 ? "/" : `/page/${n}/`,
        layouts.index,
        pageContext(
          { ...site, posts: slice },
          { posts: slice, pagination: { current: pageNum, total: pageCount, prev, next } },
          helpers,
          theme.config as Record<string, any>,
        ),
      ),
    );
  }

  // archives: /archives/
  const groups = site.archives.map((g) => ({
    ...g,
    url: `/archives/#${slugify(g.name)}`,
  }));
  addTask(pageTask("/archives/", layouts.archive, pageContext({ ...site, archives: groups }, { archives: groups }, helpers, theme.config as Record<string, any>)));

  // tag pages: /tags/<slug>/ (raw UTF-8 slug — matches template hrefs)
  for (const [tag, posts] of Object.entries(site.tags)) {
    addTask(pageTask(`/tags/${slugify(tag)}/`, layouts.tag, pageContext(site, { tag, posts }, helpers, theme.config as Record<string, any>)));
  }

  // category pages: /categories/<slug>/
  for (const [cat, posts] of Object.entries(site.categories)) {
    addTask(pageTask(`/categories/${slugify(cat)}/`, layouts.category, pageContext(site, { category: cat, posts }, helpers, theme.config as Record<string, any>)));
  }

  // theme assets
  for (const asset of theme.assets) {
    tasks.push({
      outPath: path.join(publicDir, asset.relPath),
      copy: { content: asset.content },
    });
  }

  // source assets (any non-parsed file, e.g. images, robots.txt, extra css).
  // Objects with a url (e.g. images a parser extracted into a unified
  // location) deploy there; plain assets mirror the source tree.
  for (const asset of sourceAssets) {
    tasks.push({
      outPath: path.join(publicDir, asset.url || asset.relPath),
      copy: { content: asset.raw ?? new Uint8Array() },
    });
  }

  return tasks;
}
