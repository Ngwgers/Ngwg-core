// Step 8 preparation: turn SiteData + Theme into a flat list of RenderTasks.
// The deployer plugin is responsible for turning these tasks into files under
// public/ — Core owns the *what* (pages, urls, layout mapping), the deployer
// owns the *how* (template engine, writing).

import * as path from "node:path";
import type { RenderTask, SiteData, SourceObject, ThemeObject } from "../types.ts";
import { themeLayoutMap } from "./theme.ts";

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

export function pageContext(site: SiteData, page: any, helpers: Record<string, any>): Record<string, any> {
  return { site, page, h: helpers, config: site };
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

  // posts — including hidden ones: a hidden post keeps its own page (it must
  // stay reachable at its URL) but appears in no listing built from site.posts
  for (const post of [...site.posts, ...(site.hiddenPosts ?? [])]) {
    addTask({
      outPath: outPath(publicDir, post.url),
      template: post.meta.layout ?? layouts.post,
      context: pageContext(site, post, helpers),
    });
  }

  // regular pages
  for (const page of site.pages) {
    addTask({
      outPath: outPath(publicDir, page.url),
      template: page.meta.layout ?? layouts.page,
      context: pageContext(site, page, helpers),
    });
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
    addTask({
      outPath: outPath(publicDir, n === 1 ? "/" : `/page/${n}/`),
      template: layouts.index,
      context: pageContext(
        { ...site, posts: slice },
        { posts: slice, pagination: { current: pageNum, total: pageCount, prev, next } },
        helpers,
      ),
    });
  }

  // archives: /archives/
  const groups = site.archives.map((g) => ({
    ...g,
    url: `/archives/#${slugify(g.name)}`,
  }));
  addTask({
    outPath: outPath(publicDir, "/archives/"),
    template: layouts.archive,
    context: pageContext({ ...site, archives: groups }, { archives: groups }, helpers),
  });

  // tag pages: /tags/<slug>/ (raw UTF-8 slug — matches template hrefs)
  for (const [tag, posts] of Object.entries(site.tags)) {
    addTask({
      outPath: outPath(publicDir, `/tags/${slugify(tag)}/`),
      template: layouts.tag,
      context: pageContext(site, { tag, posts }, helpers),
    });
  }

  // category pages: /categories/<slug>/
  for (const [cat, posts] of Object.entries(site.categories)) {
    addTask({
      outPath: outPath(publicDir, `/categories/${slugify(cat)}/`),
      template: layouts.category,
      context: pageContext(site, { category: cat, posts }, helpers),
    });
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
