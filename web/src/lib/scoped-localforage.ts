import localforage from "localforage";

import { GUEST_ACCOUNT_SCOPE, getAccountScope, recordKeyBelongsToScope, scopedRecordKey, unscopedRecordKey, type AccountScope } from "@/lib/account-scope";

// scope 显式传入时长任务严格绑定；未传入时每次方法调用解析当前 scope
// （模块级单例的兼容行为，调用方应尽量显式传 scope）。
export function createScopedLocalForage(storeName: string, scope?: AccountScope) {
    const store = localforage.createInstance({ name: "infinite-canvas", storeName });
    const resolve = () => scope ?? getAccountScope();
    return {
        getItem: async <T>(key: string) => {
            const current = resolve();
            const scoped = await store.getItem<T>(scopedRecordKey(key, current));
            if (scoped !== null || current !== GUEST_ACCOUNT_SCOPE) return scoped;
            return store.getItem<T>(key);
        },
        setItem: <T>(key: string, value: T) => {
            const current = resolve();
            return store.setItem(scopedRecordKey(key, current), value);
        },
        removeItem: async (key: string) => {
            const current = resolve();
            await store.removeItem(scopedRecordKey(key, current));
            if (current === GUEST_ACCOUNT_SCOPE) await store.removeItem(key);
        },
        clear: async () => {
            const current = resolve();
            const keys = await store.keys();
            await Promise.all(keys.filter((key) => recordKeyBelongsToScope(key, current) || (current === GUEST_ACCOUNT_SCOPE && !key.startsWith("user:") && !key.startsWith("guest:"))).map((key) => store.removeItem(key)));
        },
        keys: async () => {
            const current = resolve();
            const keys = await store.keys();
            const scopedKeys = keys.map((key) => unscopedRecordKey(key, current)).filter((key): key is string => key !== null);
            if (current !== GUEST_ACCOUNT_SCOPE) return scopedKeys;
            return Array.from(new Set([...scopedKeys, ...keys.filter((key) => !key.startsWith("user:") && !key.startsWith("guest:"))]));
        },
        iterate: async <T, U>(iterator: (value: T, key: string, iterationNumber: number) => U) => {
            const current = resolve();
            const keys = await store.keys();
            let iteration = 1;
            let result: U | undefined;
            for (const key of keys) {
                const plainKey = unscopedRecordKey(key, current);
                const isLegacyGuest = current === GUEST_ACCOUNT_SCOPE && !key.startsWith("user:") && !key.startsWith("guest:");
                if (plainKey === null && !isLegacyGuest) continue;
                const value = await store.getItem<T>(key);
                if (value === null) continue;
                result = iterator(value, plainKey ?? key, iteration++);
                if (result !== undefined) return result;
            }
            return result;
        },
    };
}
