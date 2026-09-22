export function buildCatalogSlug(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}
