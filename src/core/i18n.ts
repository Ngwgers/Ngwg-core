// Language-tag normalization for the i18n system.
//
// Users may spell the deployment language in ngwg.yaml (`language:`) or the
// $NGWG_LANG environment variable in any common form — "zh-cn", "zh-CN",
// "zh_CN", even a full locale like "zh_CN.UTF-8" copied from the shell. All
// forms are normalized here to the canonical internal tag `lang_REGION`
// (lowercase language, uppercase region, underscore separator), which is also
// the file-naming convention for theme i18n files (i18n/zh_CN.yaml).

/**
 * Normalize a raw language tag to `lang_REGION` (e.g. "zh_CN", "en_US") or
 * a bare language ("zh"). Returns "" for empty/invalid input. Encoding
 * suffixes (".UTF-8") and modifiers ("@pinyin") are stripped, "-" and "_"
 * separators are treated identically, the language part is lowercased and
 * the region part uppercased. Anything beyond lang_REGION is dropped.
 */
export function normalizeLanguage(raw: string | undefined | null): string {
  if (typeof raw !== "string") return "";
  let s = raw.trim();
  if (!s) return "";
  // strip encoding and modifier: "zh_CN.UTF-8" → "zh_CN", "zh@pinyin" → "zh"
  s = s.split(/[.@]/)[0];
  const parts = s.replace(/-/g, "_").split("_").filter(Boolean);
  if (parts.length === 0) return "";
  const lang = parts[0].toLowerCase();
  if (!/^[a-z]+$/i.test(lang)) return "";
  const region = parts[1];
  if (region === undefined) return lang;
  if (!/^[a-z0-9]+$/i.test(region)) return lang;
  return `${lang}_${region.toUpperCase()}`;
}
