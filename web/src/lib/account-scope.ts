export const GUEST_ACCOUNT_SCOPE = "guest";

export type AccountScope = typeof GUEST_ACCOUNT_SCOPE | `user:${string}`;
export type SessionCapture = Readonly<{ scope: AccountScope; epoch: number }>;

type AccountScopeListener = (capture: SessionCapture) => void;

let currentScope: AccountScope = GUEST_ACCOUNT_SCOPE;
let sessionEpoch = 0;
const listeners = new Set<AccountScopeListener>();

export function accountScope(userId?: string | null): AccountScope {
    const id = typeof userId === "string" ? userId.trim() : "";
    return id ? `user:${encodeURIComponent(id)}` : GUEST_ACCOUNT_SCOPE;
}

export function getAccountScope() {
    return currentScope;
}

export function capture(): SessionCapture {
    return { scope: currentScope, epoch: sessionEpoch };
}

export function isCurrent(value: SessionCapture) {
    return value.scope === currentScope && value.epoch === sessionEpoch;
}

export function beginTransition(userId?: string | null): SessionCapture {
    currentScope = accountScope(userId);
    sessionEpoch += 1;
    const next = capture();
    listeners.forEach((listener) => listener(next));
    return next;
}

export function ensureAccountScope(userId?: string | null) {
    const nextScope = accountScope(userId);
    return nextScope === currentScope ? capture() : beginTransition(userId);
}

export function scopedStorageKey(key: string, scope = currentScope) {
    return `${key}:scope:${scope}`;
}

export function scopedRecordKey(key: string, scope = currentScope) {
    return `${scope}:${key}`;
}

export function recordKeyBelongsToScope(key: string, scope = currentScope) {
    return key.startsWith(`${scope}:`);
}

export function unscopedRecordKey(key: string, scope = currentScope) {
    return recordKeyBelongsToScope(key, scope) ? key.slice(scope.length + 1) : null;
}

export function subscribeAccountScope(listener: AccountScopeListener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
