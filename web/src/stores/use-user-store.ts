"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { beginTransition, capture, ensureAccountScope, isCurrent } from "@/lib/account-scope";
import { AUTH_TOKEN_KEY, fetchCurrentUser, login, register, type AuthPayload, type AuthUser } from "@/services/api/auth";

const HYDRATE_RETRY_DELAYS_MS = [3000, 10000, 30000, 60000];
let hydrateRetryTimer: ReturnType<typeof setTimeout> | null = null;
let hydrateRetryAttempt = 0;

function cancelHydrateRetry() {
    if (hydrateRetryTimer) clearTimeout(hydrateRetryTimer);
    hydrateRetryTimer = null;
    hydrateRetryAttempt = 0;
}

function scheduleHydrateRetry(retry: () => void) {
    if (hydrateRetryTimer || typeof window === "undefined") return;
    const delay = HYDRATE_RETRY_DELAYS_MS[Math.min(hydrateRetryAttempt, HYDRATE_RETRY_DELAYS_MS.length - 1)];
    hydrateRetryAttempt += 1;
    hydrateRetryTimer = setTimeout(() => {
        hydrateRetryTimer = null;
        retry();
    }, delay);
}

// 通知服务端清除会话 Cookie；失败静默（Cookie 有会话级生命周期兜底）。
function notifyServerLogout() {
    try {
        void fetch("/api/auth/logout", { method: "POST", keepalive: true }).catch(() => undefined);
    } catch {
        // 忽略网络错误
    }
}

type UserStore = {
    token: string;
    user: AuthUser | null;
    isReady: boolean;
    isLoading: boolean;
    // 账号信息暂时刷新失败（网络/网关故障），正在用最近一次的身份继续工作并自动重试。
    sessionDegraded: boolean;
    // 仅用于网络故障兜底；启动时 user 仍为空，直到服务器确认身份，避免在游客作用域里提前加载账号数据。
    lastKnownUser: AuthUser | null;
    setSession: (token: string, user: AuthUser) => void;
    clearSession: () => void;
    hydrateUser: () => Promise<void>;
    login: (payload: AuthPayload) => Promise<AuthUser>;
    register: (payload: AuthPayload) => Promise<AuthUser>;
};

export const useUserStore = create<UserStore>()(
    persist(
        (set, get) => ({
            token: "",
            user: null,
            isReady: false,
            isLoading: false,
            sessionDegraded: false,
            lastKnownUser: null,
            setSession: (token, user) => {
                cancelHydrateRetry();
                beginTransition(user.id);
                set({ token, user, lastKnownUser: user, isReady: true, sessionDegraded: false });
                void clearAccountRuntime();
            },
            clearSession: () => {
                cancelHydrateRetry();
                beginTransition();
                set({ token: "", user: null, lastKnownUser: null, isReady: true, isLoading: false, sessionDegraded: false });
                notifyServerLogout();
                void clearAccountRuntime();
            },
            hydrateUser: async () => {
                const token = get().token;
                const session = capture();
                if (!token) {
                    set({ user: null, isReady: true, sessionDegraded: false });
                    return;
                }
                // 先用持久化的身份立即建立账号作用域：渠道/画布/素材等本地数据都按账号分区，
                // 若等用户信息网络请求返回后才建立作用域，请求被图片等流量挤占时
                // 配置面板会短暂读到处在访客分区的空数据（渠道"消失又出现"）。
                const knownUser = get().lastKnownUser || get().user;
                if (knownUser?.id) ensureAccountScope(knownUser.id);
                set({ isLoading: true });
                try {
                    const user = await fetchCurrentUser(token);
                    if (!isCurrent(session) || get().token !== token) return;
                    cancelHydrateRetry();
                    if (user.role === "guest") {
                        get().clearSession();
                        return;
                    }
                    ensureAccountScope(user.id);
                    set({ user, lastKnownUser: user, isReady: true, isLoading: false, sessionDegraded: false });
                } catch {
                    if (!isCurrent(session) || get().token !== token) return;
                    // 走到这里的都是网络/网关类故障（失效凭证由服务器返回 guest 身份，走上面的退出分支），
                    // 不能因此退出登录：否则会切到游客作用域，用户看到的是空缓存，误以为画布和工作流丢了。
                    const cached = get().user || get().lastKnownUser;
                    if (cached?.id) {
                        ensureAccountScope(cached.id);
                        set({ user: cached, isReady: true, isLoading: false, sessionDegraded: true });
                    } else {
                        set({ isReady: true, isLoading: false, sessionDegraded: true });
                    }
                    scheduleHydrateRetry(() => void get().hydrateUser());
                }
            },
            login: async (payload) => {
                set({ isLoading: true });
                try {
                    const session = await login(payload);
                    cancelHydrateRetry();
                    beginTransition(session.user.id);
                    set({ token: session.token, user: session.user, lastKnownUser: session.user, isReady: true, isLoading: false, sessionDegraded: false });
                    void clearAccountRuntime();
                    return session.user;
                } catch (error) {
                    set({ isLoading: false });
                    throw error;
                }
            },
            register: async (payload) => {
                set({ isLoading: true });
                try {
                    const session = await register(payload);
                    cancelHydrateRetry();
                    beginTransition(session.user.id);
                    set({ token: session.token, user: session.user, lastKnownUser: session.user, isReady: true, isLoading: false, sessionDegraded: false });
                    void clearAccountRuntime();
                    return session.user;
                } catch (error) {
                    set({ isLoading: false });
                    throw error;
                }
            },
        }),
        {
            name: AUTH_TOKEN_KEY,
            partialize: (state) => ({ token: state.token, lastKnownUser: state.lastKnownUser }),
            onRehydrateStorage: () => (state) => {
                if (state) state.isReady = false;
            },
        },
    ),
);

// 水合完成（同步）后立即按持久化身份建立账号作用域：
// 渠道/画布/素材等按账号分区的本地数据必须在整个应用挂载前就读到正确分区，
// 否则页面首帧会短暂读到访客空分区，等用户信息请求返回才"恢复"。
const __initialToken = useUserStore.getState().token;
const __initialUser = useUserStore.getState().lastKnownUser;
if (__initialToken && __initialUser?.id) ensureAccountScope(__initialUser.id);

async function clearAccountRuntime() {
    const session = capture();
    const [{ useAssetStore }, { useCanvasStore }, { useConfigStore }, { resetAgentSkillStoreForScopeTransition }, imageStorage, fileStorage] = await Promise.all([
        import("@/stores/use-asset-store"),
        import("@/app/(user)/canvas/stores/use-canvas-store"),
        import("@/stores/use-config-store"),
        import("@/stores/use-agent-skill-store"),
        import("@/services/image-storage"),
        import("@/services/file-storage"),
    ]);
    if (!isCurrent(session)) return;
    useAssetStore.getState().stopAccountAssetSync();
    useAssetStore.getState().resetForAccountTransition();
    useCanvasStore.getState().resetForAccountTransition();
    useConfigStore.getState().resetForAccountTransition();
    resetAgentSkillStoreForScopeTransition();
    imageStorage.clearImageRuntimeCache();
    fileStorage.clearMediaRuntimeCache();
}
