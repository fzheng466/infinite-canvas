import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";

import { GUEST_ACCOUNT_SCOPE, getAccountScope, scopedStorageKey, type AccountScope } from "@/lib/account-scope";

localforage.config({
    name: "infinite-canvas",
    storeName: "app_state",
});

export function localForageStorageForScope(scope: AccountScope): StateStorage {
    return {
        getItem: async (name) => {
            if (typeof window === "undefined") return null;
            const key = scopedStorageKey(name, scope);
            try {
                const value = await localforage.getItem<string>(key);
                if (value || scope !== GUEST_ACCOUNT_SCOPE) return value || null;
                return (await localforage.getItem<string>(name)) || null;
            } catch {
                return window.localStorage.getItem(key) || (scope === GUEST_ACCOUNT_SCOPE ? window.localStorage.getItem(name) : null);
            }
        },
        setItem: async (name, value) => {
            if (typeof window === "undefined") return;
            const key = scopedStorageKey(name, scope);
            try {
                await localforage.setItem(key, value);
            } catch {
                window.localStorage.setItem(key, value);
            }
        },
        removeItem: async (name) => {
            if (typeof window === "undefined") return;
            const key = scopedStorageKey(name, scope);
            try {
                await localforage.removeItem(key);
            } catch {
                window.localStorage.removeItem(key);
            }
        },
    };
}

// 兼容旧调用点：每次读写解析当前账号 scope。
export const localForageStorage: StateStorage = {
    getItem: async (name) => localForageStorageForScope(getAccountScope()).getItem(name),
    setItem: async (name, value) => localForageStorageForScope(getAccountScope()).setItem(name, value),
    removeItem: async (name) => localForageStorageForScope(getAccountScope()).removeItem(name),
};
