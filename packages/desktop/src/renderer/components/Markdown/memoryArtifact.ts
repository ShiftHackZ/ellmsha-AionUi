/** Typed virtual memory links never resolve to a local filesystem path. */
export function resolveMemoryArtifactPath(href: string): string | undefined {
  try {
    const url = new URL(href);
    if (
      url.protocol !== 'ellmsha-memory:' ||
      url.hostname !== 'artifact' ||
      url.pathname ||
      url.hash ||
      url.username ||
      url.password ||
      url.port
    )
      return undefined;
    if (url.searchParams.size !== 1 || !url.searchParams.has('path')) return undefined;
    const path = url.searchParams.get('path')!;
    if (
      !/^bmad\/[^/]+\/.+\.md$/.test(path) ||
      /[\\\x00-\x1f\x7f]/.test(path) ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      return undefined;
    return path;
  } catch {
    return undefined;
  }
}
