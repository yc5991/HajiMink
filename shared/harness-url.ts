export function withHarness(url: string, harness: string) {
  return `${url}${url.includes('?') ? '&' : '?'}harness=${encodeURIComponent(harness)}`;
}
