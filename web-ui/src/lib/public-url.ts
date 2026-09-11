/** Resolve a public asset below the page's current deployment path. */
export function resolvePublicUrl(path: string, base: string): string {
  return new URL(path, base).href;
}
