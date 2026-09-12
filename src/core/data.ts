// Pipeline step 7 — data processing. Turns a bag of SourceObjects into a
// structured SiteData: sorted posts, tag/category indexes, archive groups and
// prev/next links. Helper plugins can contribute extra data via buildData().

import type { HelperUnitV1 } from "../plugin/protocol.ts";
import type { PluginContext, SiteData, SourceObject, UserConfig } from "../types.ts";
import { slugify } from "./tasks.ts";

export function parseDate(v: any): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(v);
  if (typeof v === "string" && v.trim()) {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

export function postDate(post: SourceObject): Date {
  return parseDate(post.meta.date) ?? post.meta._fileDate ?? new Date(0);
}

function toStringArray(v: any): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map(String).filter((s) => s.trim());
  return String(v)
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function buildSiteData(
  config: UserConfig,
  sources: Map<string, SourceObject>,
  helperPlugins: HelperUnitV1[],
  contexts: Map<string, PluginContext>,
): SiteData {
  const all = [...sources.values()];
  const posts = all
    .filter((s) => s.kind === "post")
    .sort((a, b) => postDate(b).getTime() - postDate(a).getTime());

  // prev (newer) / next (older) links; posts are sorted newest-first
  posts.forEach((post, i) => {
    post.meta._prev = i > 0 ? posts[i - 1] : null;
    post.meta._next = i < posts.length - 1 ? posts[i + 1] : null;
  });

  const pages = all.filter((s) => s.kind === "page");

  const tags: Record<string, SourceObject[]> = {};
  const categories: Record<string, SourceObject[]> = {};
  for (const post of posts) {
    for (const tag of toStringArray(post.meta.tags)) {
      (tags[tag] ??= []).push(post);
    }
    for (const cat of toStringArray(post.meta.categories ?? post.meta.category)) {
      (categories[cat] ??= []).push(post);
    }
  }

  // archive groups by year
  const byYear = new Map<number, SourceObject[]>();
  for (const post of posts) {
    const year = postDate(post).getFullYear();
    (byYear.get(year) ?? byYear.set(year, []).get(year)!).push(post);
  }
  const archives = [...byYear.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, groupPosts]) => ({
      name: String(year),
      url: `/archives/#${slugify(String(year))}`,
      posts: groupPosts,
    }));

  const data: SiteData = {
    title: config.title,
    description: config.description ?? "",
    baseurl: config.baseurl ?? "/",
    posts,
    pages,
    tags,
    categories,
    archives,
    extra: {},
  };

  for (const helper of helperPlugins) {
    if (!helper.buildData) continue;
    const ctx = contexts.get(helper.name);
    try {
      const extra = helper.buildData(ctx!, data, posts);
      Object.assign(data.extra, extra && typeof extra === "object" ? extra : {});
    } catch (e) {
      throw new Error(`helper plugin "${helper.name}" buildData() failed: ${(e as Error).message}`);
    }
  }

  return data;
}
