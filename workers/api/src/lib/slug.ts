export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "untitled";
}

export async function uniqueProjectSlug(
  db: D1Database,
  ownerId: number,
  base: string,
): Promise<string> {
  const baseSlug = slugify(base);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? baseSlug : `${baseSlug}-${i + 1}`;
    const taken = await db
      .prepare("SELECT 1 FROM projects WHERE owner_id = ? AND slug = ?")
      .bind(ownerId, candidate)
      .first();
    if (!taken) return candidate;
  }
  return `${baseSlug}-${crypto.randomUUID().slice(0, 6)}`;
}

/**
 * Galleries' `slug` is globally UNIQUE (not per-owner like projects).
 * Mirrors uniqueProjectSlug's collision-suffix loop with a random
 * tail as the bounded fallback.
 */
export async function uniqueGallerySlug(
  db: D1Database,
  base: string,
): Promise<string> {
  const baseSlug = slugify(base);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? baseSlug : `${baseSlug}-${i + 1}`;
    const taken = await db
      .prepare("SELECT 1 FROM galleries WHERE slug = ?")
      .bind(candidate)
      .first();
    if (!taken) return candidate;
  }
  return `${baseSlug}-${crypto.randomUUID().slice(0, 6)}`;
}
