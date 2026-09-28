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
