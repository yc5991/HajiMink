// Optional, versioned liveness check for the existing event stream. Older
// gateways do not advertise it; clients must keep their previous behavior.
export const LIVE_HEARTBEAT_PROTOCOL = 'hajimink-ping-v1';
export const LIVE_HEARTBEAT_INTERVAL_MS = 20_000;
export const LIVE_HEARTBEAT_TIMEOUT_MS = 10_000;
export const LIVE_HEARTBEAT_MIN_INTERVAL_MS = 1_000;
export const LIVE_HEARTBEAT_NONCE = /^[0-9a-f]{32}$/;
