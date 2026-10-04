// Export file naming. Names are derived from the Journey name so exports are
// recognisable in a file manager, and never reuse an existing file name.

export const FALLBACK_SLUG = "untitled-journey";
const MAX_SLUG_LENGTH = 60;

export function slugifyJourneyName(name) {
  const slug = String(name ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, "");
  return slug || FALLBACK_SLUG;
}

// Case-insensitive because common desktop file systems are, so `Foo.png`
// already occupies `foo.png`.
export function nextExportName(slug, existingNames = []) {
  const taken = new Set([...existingNames].map((name) => String(name).toLowerCase()));

  for (let suffix = 1; ; suffix += 1) {
    const candidate = suffix === 1 ? `${slug}.png` : `${slug}-${suffix}.png`;

    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}

// A base name free for every extension in the pair, so an image and its
// context file always share one name and neither overwrites anything.
export function nextExportBase(slug, existingNames = [], extensions = [".png", ".json"]) {
  const taken = new Set([...existingNames].map((name) => String(name).toLowerCase()));

  for (let suffix = 1; ; suffix += 1) {
    const base = suffix === 1 ? slug : `${slug}-${suffix}`;

    if (extensions.every((extension) => !taken.has(`${base}${extension}`.toLowerCase()))) {
      return base;
    }
  }
}

// Local date and time for Downloads names, which cannot be checked for
// clashes in advance: `2026-09-29-1530`.
export function exportTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}
