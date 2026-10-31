export interface Project { id: string; name: string; path?: string; hostId: string; }
export interface ThreadSummary { id: string; title: string; projectId: string | null; cwd?: string; status: string; updatedAt: number; pinned?: boolean; }
export interface DisplayItem { id: string; type: 'user' | 'assistant' | 'progress' | 'command' | 'tool' | 'diff' | 'error' | 'notice'; text: string; status?: string; label?: string; output?: string; truncated?: boolean; }
export interface DisplayTurn { id: string; status: string; startedAt: number; items: DisplayItem[]; }
export interface PendingRequest { id: string; turnId: string; kind: 'command' | 'file' | 'permissions' | 'input' | 'elicitation' | 'unsupported'; title: string; detail: string; questions?: { id: string; header?: string; question: string; options?: { label: string; description?: string }[]; isOther?: boolean; isSecret?: boolean; }[]; decisions?: string[]; }
export interface ThreadView { id: string; title: string; cwd?: string; epoch?: string; revision: number; live: boolean; status: string; activeTurnId?: string; model?: string; effort?: string; permissionLabel: string; turns: DisplayTurn[]; totalTurns: number; olderCursor: string | null; requests: PendingRequest[]; error?: string; }
export interface DesktopStatus { connected: boolean; compatible: boolean; version: string | null; supportedVersion: string; accessMode?: 'full' | 'limited' | 'read-only' | 'blocked'; reason?: string; }
export interface ModelOption { id: string; efforts: string[]; }
export interface GatewayEvent { type: 'thread' | 'desktop' | 'catalog'; thread?: ThreadView; desktop?: DesktopStatus; }
export interface HarnessCapabilities { read: boolean; create: boolean; send: boolean; interrupt: boolean; settings: boolean; respond: boolean; }
export interface HarnessInfo { id: string; name: string; state: 'available' | 'planned'; status: DesktopStatus; capabilities: HarnessCapabilities; }
