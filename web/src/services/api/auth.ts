import { apiGet, apiPost } from "@/services/api/request";

export const AUTH_TOKEN_KEY = "infinite-canvas-auth-token-v1";

export type UserRole = "guest" | "user" | "admin";

export type AuthUser = {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    role: UserRole;
    credits: number;
    createdAt: string;
    updatedAt: string;
};

export type AuthSession = {
    token: string;
    user: AuthUser;
};

export type AuthPayload = {
    username: string;
    password: string;
};

export async function login(payload: AuthPayload) {
    return apiPost<AuthSession>("/api/auth/login", payload);
}

export async function register(payload: AuthPayload) {
    return apiPost<AuthSession>("/api/auth/register", payload);
}

const currentUserRequests = new Map<string, Promise<AuthUser>>();

export async function fetchCurrentUser(token?: string) {
    if (!token) return apiGet<AuthUser>("/api/auth/me");
    const existing = currentUserRequests.get(token);
    if (existing) return existing;
    const request = apiGet<AuthUser>("/api/auth/me", undefined, token);
    currentUserRequests.set(token, request);
    request.then(() => {
        if (currentUserRequests.get(token) === request) currentUserRequests.delete(token);
    }, () => {
        if (currentUserRequests.get(token) === request) currentUserRequests.delete(token);
    });
    return request;
}
