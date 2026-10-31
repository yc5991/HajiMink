// A transport handshake alone does not prove the gateway event stream works.
export function isDesktopGreeting(value: unknown, harnessId: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (event.type !== 'desktop' || (event.harness !== harnessId && !(event.harness === undefined && harnessId === 'codex'))) return false;
  const desktop = event.desktop;
  if (!desktop || typeof desktop !== 'object' || Array.isArray(desktop)) return false;
  const status = desktop as Record<string, unknown>;
  return typeof status.connected === 'boolean' && typeof status.compatible === 'boolean';
}
