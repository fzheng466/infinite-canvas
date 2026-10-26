"use client";

import { nanoid } from "nanoid";
import { capture, getAccountScope, isCurrent, scopedRecordKey, scopedStorageKey, type AccountScope, type SessionCapture } from "@/lib/account-scope";
import { createScopedLocalForage } from "@/lib/scoped-localforage";
import { readImageMeta } from "@/lib/image-utils";
import { deleteAnonymousStorageFile, uploadAnonymousStorageFile } from "@/services/anonymous-storage";
import { apiGet } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

export type UploadedImage = {
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

type UserStorageProviderBase = {
    enabled: boolean;
    name: string;
    endpoint: string;
};

export type UserS3StorageProvider = UserStorageProviderBase & {
    type: "s3";
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    publicBaseUrl: string;
    pathPrefix: string;
};

export type UserWebDAVStorageProvider = UserStorageProviderBase & {
    type: "webdav";
    pathPrefix: string;
    username: string;
    password: string;
};

export type UserStorageProvider = UserS3StorageProvider | UserWebDAVStorageProvider;

type UploadImageOptions = {
    localOnly?: boolean;
};

export type StorageConfig = {
    mode: string;
    allowUserProvider: boolean;
    allowUserGlobalProvider: boolean;
    autoSyncAllAssets: boolean;
};

const imageStore = (scope: AccountScope) => createScopedLocalForage("image_files", scope);
const runtimeKey = (scope: AccountScope, key: string) => scopedRecordKey(key, scope);
const objectUrls = new Map<string, string>();
const serverUrls = new Map<string, string>();
// img 401 兜底修复缓存：路径 → Bearer 拉取后的本地 blob URL。上限 200，淘汰时 revoke，避免长时间使用内存膨胀。
const REPAIRED_IMAGE_CACHE_LIMIT = 200;
const repairedImageUrls = new Map<string, string>();

function rememberRepairedImage(src: string, url: string) {
    const previous = repairedImageUrls.get(src);
    if (previous && previous !== url) URL.revokeObjectURL(previous);
    if (repairedImageUrls.has(src)) repairedImageUrls.delete(src);
    repairedImageUrls.set(src, url);
    while (repairedImageUrls.size > REPAIRED_IMAGE_CACHE_LIMIT) {
        const oldest = repairedImageUrls.keys().next().value as string | undefined;
        if (!oldest) break;
        const stale = repairedImageUrls.get(oldest);
        repairedImageUrls.delete(oldest);
        if (stale) URL.revokeObjectURL(stale);
    }
}
export const USER_STORAGE_PROVIDER_KEY = "infinite-canvas:user_storage_provider";
export const USER_WEBDAV_STORAGE_PROVIDER_KEY = "infinite-canvas:user_webdav_storage_provider";
let storageConfigPromise: Promise<StorageConfig> | null = null;
export const STORAGE_SYNC_FAILED_EVENT = "infinite-canvas:storage-sync-failed";
const autoSyncRequests = new Map<string | Blob, Promise<{ storageKey: string } | null>>();
const referencePersistenceRequests = new Map<string, Promise<ReferenceImage | null>>();
let autoSyncOwner = "";

export async function autoSyncToCloud<T extends { storageKey: string }>(source: string | Blob, upload: () => Promise<T | null>, session: SessionCapture = capture()): Promise<T | null> {
    const owner = useUserStore.getState().token;
    const config = await loadStorageConfig().catch(() => null);
    if (!isCurrent(session) || useUserStore.getState().token !== owner) return null;
    if (!config?.autoSyncAllAssets || (!canUseGlobalStorage(config) && !(config.allowUserProvider && loadUserStorageProvider(session.scope)))) return null;
    if (autoSyncOwner !== `${session.scope}:${owner}`) {
        autoSyncRequests.clear();
        autoSyncOwner = `${session.scope}:${owner}`;
    }
    const existing = autoSyncRequests.get(source);
    if (existing) return existing as Promise<T | null>;
    const request = upload().catch((error) => {
        reportStorageSyncFailure(error);
        return null;
    });
    autoSyncRequests.set(source, request);
    const result = await request;
    if ((source instanceof Blob || !result) && autoSyncRequests.get(source) === request) autoSyncRequests.delete(source);
    return isCurrent(session) && useUserStore.getState().token === owner ? result : null;
}

export function clearImageRuntimeCache() {
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.clear();
    serverUrls.clear();
    repairedImageUrls.forEach((url) => URL.revokeObjectURL(url));
    repairedImageUrls.clear();
    autoSyncRequests.clear();
    referencePersistenceRequests.clear();
    autoSyncOwner = "";
    storageConfigPromise = null;
}

export function clearAutoSyncCache(storageKey: string) {
    for (const [source, request] of autoSyncRequests) {
        void request.then((result) => {
            if (result?.storageKey === storageKey && autoSyncRequests.get(source) === request) autoSyncRequests.delete(source);
        });
    }
}

export async function autoSyncImage(url: string, resultId: string, storageKey?: string) {
    if (!url || storageKey) return null;
    return autoSyncToCloud(`image:${resultId}`, async () => {
        try {
            return await uploadRemoteImageToServer(url, "image");
        } catch (error) {
            if (!url.startsWith("data:") && !url.startsWith("blob:")) throw error;
            reportStorageSyncFailure(error);
            return uploadImage(url, { localOnly: true });
        }
    });
}

export type PersistedReferenceImage = ReferenceImage & {
    storageKey?: string;
};

function referencePersistenceKey(image: ReferenceImage, session: SessionCapture) {
    return `${session.scope}:${image.storageKey || image.dataUrl || image.url || image.id}`;
}

export async function persistReferenceImage(image: ReferenceImage, session: SessionCapture = capture()): Promise<PersistedReferenceImage> {
    if (!isCurrent(session)) throw new Error("账号已切换，已取消参考图保存");
    if (image.storageKey?.startsWith("server:")) {
        const resolved = await resolveImageUrl(image.storageKey, image.url || image.dataUrl, session);
        return { ...image, dataUrl: resolved || image.dataUrl };
    }
    const requestKey = referencePersistenceKey(image, session);
    const existing = referencePersistenceRequests.get(requestKey);
    if (existing) {
        const result = await existing;
        return result ? { ...image, ...result } : image;
    }
    const request = (async () => {
        let source = image.dataUrl || image.url || "";
        if (image.storageKey?.startsWith("image:")) {
            source = await resolveImageUrl(image.storageKey, source, session);
        }
        if (!source) return null;
        const uploaded = await uploadImage(source, {}, session);
        if (!isCurrent(session)) return null;
        return {
            id: image.id,
            name: image.name,
            type: image.type || uploaded.mimeType,
            dataUrl: uploaded.url,
            storageKey: uploaded.storageKey,
        } satisfies PersistedReferenceImage;
    })().catch((error) => {
        reportStorageSyncFailure(error);
        return null;
    });
    referencePersistenceRequests.set(requestKey, request);
    try {
        const result = await request;
        return result ? { ...image, ...result } : image;
    } finally {
        if (referencePersistenceRequests.get(requestKey) === request) referencePersistenceRequests.delete(requestKey);
    }
}

export async function persistReferenceImages(images: ReferenceImage[], session: SessionCapture = capture()) {
    return Promise.all(images.map((image) => persistReferenceImage(image, session)));
}

function reportStorageSyncFailure(error: unknown) {
    window.dispatchEvent(new CustomEvent(STORAGE_SYNC_FAILED_EVENT, { detail: error instanceof Error ? error.message : "" }));
}

export function canUseGlobalStorage(config: StorageConfig) {
    const { token, user } = useUserStore.getState();
    if (!token || user?.role === "guest") return false;
    return ["server_sqlite_s3", "server_local"].includes(config.mode) && Boolean(user?.role === "admin" || config.allowUserGlobalProvider);
}

function isLocalNetworkHost(hostname: string) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host.endsWith(".local") ||
        host === "host.docker.internal" ||
        host === "::1"
    ) {
        return true;
    }
    if (
        host.includes(":") &&
        (host.startsWith("fc") ||
            host.startsWith("fd") ||
            /^fe[89ab]/.test(host))
    ) {
        return true;
    }
    const parts = host.split(".").map(Number);
    if (
        parts.length !== 4 ||
        parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    ) {
        return false;
    }
    const [a, b] = parts;
    return (
        a === 10 ||
        a === 127 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254)
    );
}

export function getProxyUrl(url: string): string {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
        return url;
    }
    try {
        const parsed = new URL(url);
        if (
            isLocalNetworkHost(parsed.hostname) ||
            (typeof window !== "undefined" &&
                parsed.host === window.location.host)
        ) {
            return url;
        }
    } catch {
        return url;
    }
    return `/api/proxy-image?url=${encodeURIComponent(url)}`;
}

export async function uploadImage(input: string | Blob, options: UploadImageOptions = {}, session: SessionCapture = capture()): Promise<UploadedImage> {
    const url = typeof input === "string" ? getProxyUrl(input) : input;
    let blob: Blob;
    if (typeof url === "string") {
        const response = await fetch(url);
        if (!response.ok) {
            const payload = await response.json().catch(() => null) as { msg?: string } | null;
            throw new Error(payload?.msg || `代理图片拉取失败：${response.status}`);
        }
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
            const payload = await response.json().catch(() => null) as { msg?: string } | null;
            throw new Error(payload?.msg || "代理图片下载失败");
        }
        blob = await response.blob();
    } else {
        blob = url;
    }
    if (!isCurrent(session)) throw new Error("账号已切换，已取消图片保存");
    if (!options.localOnly) {
        const serverUpload = await maybeUploadImageToServer(blob, session);
        if (serverUpload) return serverUpload;
    }
    if (!isCurrent(session)) throw new Error("账号已切换，已取消图片保存");
    const storageKey = `image:${nanoid()}`;
    await imageStore(session.scope).setItem(storageKey, blob);
    if (!isCurrent(session)) {
        await imageStore(session.scope).removeItem(storageKey);
        throw new Error("账号已切换，已取消图片保存");
    }
    const urlObj = URL.createObjectURL(blob);
    objectUrls.set(runtimeKey(session.scope, storageKey), urlObj);
    const meta = await readImageMeta(urlObj);
    return { url: urlObj, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type || meta.mimeType };
}

export async function uploadRemoteImageToServer(url: string, filename: string): Promise<UploadedImage> {
    const response = await fetch(getProxyUrl(url));
    if (!response.ok) {
        const payload = await response.json().catch(() => null) as { msg?: string } | null;
        throw new Error(payload?.msg || "代理图片拉取失败：" + response.status);
    }
    const blob = await response.blob();
    const config = await loadStorageConfig();
    const userProvider = config.allowUserProvider ? loadUserStorageProvider() : null;
    if (!canUseGlobalStorage(config) && !userProvider) throw new Error("服务端对象存储未启用");
    const token = useUserStore.getState().token;
    if (userProvider?.type === "webdav") {
        const directUpload = await uploadWebDAVImageDirect(blob, filename || `image-${nanoid()}.${imageExtension(blob.type)}`, userProvider);
        if (directUpload) return directUpload;
    }
    if (!token) {
        if (!userProvider) throw new Error("服务端存储需要先登录");
        const uploaded = await uploadAnonymousStorageFile<UploadedImage>(blob, filename || "image-" + nanoid() + "." + imageExtension(blob.type), toProviderPayload(userProvider));
        return cacheAnonymousImage(uploaded, blob);
    }
    const formData = new FormData();
    formData.append("file", blob, filename || "image-" + nanoid() + "." + imageExtension(blob.type));
    if (userProvider) formData.append("provider", JSON.stringify(toProviderPayload(userProvider)));
    const uploadResponse = await fetch("/api/v1/files", { method: "POST", headers: { Authorization: "Bearer " + token }, body: formData });
    const payload = (await uploadResponse.json().catch(() => null)) as { code?: number; msg?: string; data?: UploadedImage } | null;
    if (!uploadResponse.ok || payload?.code !== 0 || !payload.data) throw new Error(payload?.msg || "服务端图片上传失败");
    const meta = await readImageMeta(payload.data.url);
    if (payload.data.storageKey?.startsWith("server:")) serverUrls.set(payload.data.storageKey.slice("server:".length), payload.data.url);
    return { ...payload.data, width: payload.data.width || meta.width, height: payload.data.height || meta.height, mimeType: payload.data.mimeType || blob.type || "image/png", bytes: payload.data.bytes || blob.size };
}

export function clearStorageConfigCache() {
    storageConfigPromise = null;
}

export async function resolveImageUrl(storageKey?: string, fallback = "", session: SessionCapture = capture()) {
    if (!storageKey || !isCurrent(session)) return fallback;
    if (storageKey.startsWith("server:webdav:")) {
        const localUrl = await resolveLocalImageUrl(storageKey, session).catch(() => "");
        if (localUrl) return localUrl;
        const provider = loadUserStorageProvider(session.scope);
        if (provider?.type !== "webdav") return fallback;
        const direct = await import("@/services/webdav-direct-storage");
        const blob = await direct.readDirectWebDAV(provider, direct.directWebDAVObjectKey(storageKey));
        return setImageBlob(storageKey, blob);
    }
    if (storageKey.startsWith("server:")) {
        const id = storageKey.slice("server:".length);
        if (fallback && !fallback.startsWith("blob:") && !fallback.includes("direct=1")) return fallback;
        const localUrl = await resolveLocalImageUrl(storageKey, session).catch(() => "");
        if (localUrl) return localUrl;
        const cachedUrl = serverUrls.get(id);
        if (cachedUrl) return cachedUrl;
        const { getStorageObjectInfo } = await import("@/services/api/storage");
        const info = await getStorageObjectInfo(id).catch(() => null);
        if (!info) return fallback;
        const provider = loadUserStorageProvider(session.scope);
        if (info.direct && provider?.type === "webdav") {
            const direct = await import("@/services/webdav-direct-storage");
            try {
                const blob = await direct.readDirectWebDAV(provider, info.objectKey, info.mimeType);
                return setImageBlob(storageKey, blob);
            } catch (error) {
                if (!useUserStore.getState().token || !direct.isWebDAVDirectUnavailable(error)) throw error;
            }
        }
        const url = info.publicUrl || `/api/files/${encodeURIComponent(id)}/content`;
        // 私有图片(带鉴权访问)下载后镜像到本地, 跨设备/再登录时秒出。
        if (!info.publicUrl && (info.mimeType || "image/").startsWith("image/")) {
            const token = useUserStore.getState().token;
            if (token) {
                let pending = serverBlobFetches.get(id);
                if (!pending) {
                    pending = fetchServerImageBlob(url, token, session).finally(() => serverBlobFetches.delete(id));
                    serverBlobFetches.set(id, pending);
                }
                const blob = await pending.catch(() => null);
                if (blob && isCurrent(session)) {
                    serverUrls.delete(id);
                    return await setImageBlob(storageKey, blob, session);
                }
            }
        }
        serverUrls.set(id, url);
        return url;
    }
    return await resolveLocalImageUrl(storageKey, session) || fallback;
}

const serverBlobFetches = new Map<string, Promise<Blob | null>>();

async function fetchServerImageBlob(url: string, token: string, session: SessionCapture): Promise<Blob | null> {
    if (!isCurrent(session)) return null;
    try {
        const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) return null;
        const blob = await response.blob();
        if (!blob.type.startsWith("image/")) return null;
        return blob.size <= 32 * 1024 * 1024 ? blob : null;
    } catch {
        return null;
    }
}

async function resolveLocalImageUrl(storageKey: string, session: SessionCapture = capture()) {
    if (!isCurrent(session)) return "";
    const key = runtimeKey(session.scope, storageKey);
    const cached = objectUrls.get(key);
    if (cached) return cached;
    const blob = await imageStore(session.scope).getItem<Blob>(storageKey);
    if (!blob || !isCurrent(session)) return "";
    const url = URL.createObjectURL(blob);
    if (!isCurrent(session)) {
        URL.revokeObjectURL(url);
        return "";
    }
    objectUrls.set(key, url);
    return url;
}

async function maybeUploadImageToServer(blob: Blob, session: SessionCapture): Promise<UploadedImage | null> {
    const config = await loadStorageConfig().catch(() => null);
    if (!isCurrent(session)) throw new Error("账号已切换，已取消图片上传");
    const userProvider = config?.allowUserProvider ? loadUserStorageProvider(session.scope) : null;
    const canUseGlobalProvider = config ? canUseGlobalStorage(config) : false;
    const useServerStorage = canUseGlobalProvider || Boolean(userProvider);
    if (!config || !useServerStorage) return null;
    const token = useUserStore.getState().token;
    if (userProvider?.type === "webdav") {
        const directUpload = await uploadWebDAVImageDirect(blob, `image-${nanoid()}.${imageExtension(blob.type)}`, userProvider);
        if (directUpload) return directUpload;
    }
    if (!token) {
        if (!userProvider) {
            if (canUseGlobalProvider) throw new Error("服务端存储需要先登录");
            return null;
        }
        try {
            const uploaded = await uploadAnonymousStorageFile<UploadedImage>(blob, `image-${nanoid()}.${imageExtension(blob.type)}`, toProviderPayload(userProvider));
            return cacheAnonymousImage(uploaded, blob);
        } catch {
            return null;
        }
    }
    const formData = new FormData();
    formData.append("file", blob, `image-${nanoid()}.${imageExtension(blob.type)}`);
    if (userProvider) formData.append("provider", JSON.stringify(toProviderPayload(userProvider)));
    const response = await fetch("/api/v1/files", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: formData });
    const payload = (await response.json().catch(() => null)) as { code?: number; msg?: string; data?: UploadedImage } | null;
    if (!response.ok || payload?.code !== 0 || !payload.data) {
        if (!canUseGlobalProvider) return null;
        throw new Error(payload?.msg || "服务端图片上传失败");
    }
    const meta = await readImageMeta(payload.data.url);
    if (payload.data.storageKey?.startsWith("server:")) serverUrls.set(payload.data.storageKey.slice("server:".length), payload.data.url);
    return { ...payload.data, width: payload.data.width || meta.width, height: payload.data.height || meta.height, mimeType: payload.data.mimeType || blob.type || "image/png", bytes: payload.data.bytes || blob.size };
}

async function uploadWebDAVImageDirect(blob: Blob, filename: string, provider: UserWebDAVStorageProvider): Promise<UploadedImage | null> {
    const direct = await import("@/services/webdav-direct-storage");
    const uploaded = await direct.persistDirectWebDAV(provider, blob, filename);
    return uploaded ? cacheAnonymousImage({ ...uploaded, width: 0, height: 0 }, blob) : null;
}

async function cacheAnonymousImage(uploaded: UploadedImage, blob: Blob, session: SessionCapture = capture()) {
    if (!isCurrent(session)) throw new Error("账号已切换，已取消图片缓存");
    await imageStore(session.scope).setItem(uploaded.storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(runtimeKey(session.scope, uploaded.storageKey), url);
    if (uploaded.storageKey.startsWith("server:") && uploaded.url && !uploaded.url.includes("direct=1")) serverUrls.set(uploaded.storageKey.slice("server:".length), uploaded.url);
    const meta = await readImageMeta(url);
    return { ...uploaded, url, width: uploaded.width || meta.width, height: uploaded.height || meta.height, mimeType: uploaded.mimeType || blob.type || meta.mimeType, bytes: uploaded.bytes || blob.size };
}

export async function loadStorageConfig() {
    storageConfigPromise ||= apiGet<StorageConfig>("/api/storage/config");
    return storageConfigPromise;
}

function imageExtension(mimeType: string) {
    if (mimeType === "image/jpeg") return "jpg";
    if (mimeType === "image/webp") return "webp";
    return "png";
}

export async function getImageBlob(storageKey: string, session: SessionCapture = capture()) {
    return imageStore(session.scope).getItem<Blob>(storageKey);
}

export async function setImageBlob(storageKey: string, blob: Blob, session: SessionCapture = capture()) {
    if (!isCurrent(session)) throw new Error("账号已切换，已取消图片保存");
    await imageStore(session.scope).setItem(storageKey, blob);
    if (!isCurrent(session)) throw new Error("账号已切换，已取消图片保存");
    const url = URL.createObjectURL(blob);
    objectUrls.set(runtimeKey(session.scope, storageKey), url);
    return url;
}

// 图片 401 兜底：Cookie 缺失/失效导致 <img> 加载失败时，用 Bearer 拉取并转本地 blob。
// 仅处理本站 /api/files/ 私有对象；成功结果按路径缓存，账号切换时统一释放。
// forbidden=true 表示对象属于其他账号（服务器 403），调用方应显示隔离提示而不是继续重试。
export async function repairImageSource(src: string): Promise<{ url: string; forbidden: boolean }> {
    if (!src || !src.startsWith("/api/files/") || repairedImageUrls.has(src)) return { url: "", forbidden: false };
    const token = useUserStore.getState().token;
    if (!token) return { url: "", forbidden: false };
    try {
        const response = await fetch(src, { headers: { Authorization: `Bearer ${token}` } });
        if (response.status === 403) return { url: "", forbidden: true };
        if (!response.ok) return { url: "", forbidden: false };
        const blob = await response.blob();
        if (!blob.type.startsWith("image/") || blob.size > 32 * 1024 * 1024) return { url: "", forbidden: false };
        const url = URL.createObjectURL(blob);
        rememberRepairedImage(src, url);
        return { url, forbidden: false };
    } catch {
        return { url: "", forbidden: false };
    }
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    const serverObjectId = image.storageKey?.startsWith("server:") ? image.storageKey.slice("server:".length) : "";
    const directGuestObject = image.storageKey?.startsWith("server:webdav:");
    const hasPersistedUrl = [image.dataUrl, image.url].some((url) => Boolean(url && !url.startsWith("blob:")));
    const localUrl = !useUserStore.getState().token && serverObjectId && image.storageKey && !hasPersistedUrl
        ? await resolveLocalImageUrl(image.storageKey).catch(() => "")
        : "";
    const resolvedUrl = image.storageKey
        ? await resolveImageUrl(image.storageKey, image.url || image.dataUrl || "")
        : "";
    const urls = [
        image.dataUrl && !image.dataUrl.startsWith("blob:") ? image.dataUrl : "",
        image.url && !image.url.startsWith("blob:") ? image.url : "",
        localUrl,
        resolvedUrl,
        serverObjectId && !directGuestObject ? `/api/files/${encodeURIComponent(serverObjectId)}/content` : "",
    ].filter((url, index, list): url is string => Boolean(url) && list.indexOf(url) === index);
    if (!urls.length) return "";
    let lastError = "";
    for (const url of urls) {
        if (url.startsWith("data:")) return url;
        try {
            const proxyUrl = getProxyUrl(url);
            const response = await fetch(proxyUrl);
            if (!response.ok) {
                lastError = `读取参考图失败：${response.status}`;
                continue;
            }
            return blobToDataUrl(await response.blob());
        } catch (error) {
            lastError = error instanceof Error ? error.message : "读取参考图失败";
        }
    }
    throw new Error(lastError || "读取参考图失败");
}

export async function deleteStoredImages(keys: Iterable<string>, ownerToken?: string, session: SessionCapture = capture()) {
    if (!isCurrent(session)) return;
    const { useAssetStore } = await import("@/stores/use-asset-store");
    const assetKeys = new Set(
        useAssetStore.getState().assets
            .map((a) => (a.kind !== "text" ? a.data.storageKey : null))
            .filter((k): k is string => Boolean(k))
    );
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            if (!isCurrent(session) || assetKeys.has(key) || (ownerToken !== undefined && useUserStore.getState().token !== ownerToken)) return;
            if (key.startsWith("server:")) {
                await deleteServerImage(key, session);
                return;
            }
            const cacheKey = runtimeKey(session.scope, key);
            const url = objectUrls.get(cacheKey);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(cacheKey);
            await imageStore(session.scope).removeItem(key);
            clearAutoSyncCache(key);
        }),
    );
}

export async function cleanupUnusedImages(usedData: unknown, storageKeys: ReadonlyMap<string, string> = new Map(), ownerToken?: string, session: SessionCapture = capture()) {
    if (!isCurrent(session)) return;
    const usedKeys = collectImageStorageKeys(usedData, new Set(), storageKeys);
    const unused = Array.from(new Set(storageKeys.values())).filter((key) => key.startsWith("server:") && !usedKeys.has(key));
    await imageStore(session.scope).iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    if (isCurrent(session)) await deleteStoredImages(unused, ownerToken, session);
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>(), knownUrls?: ReadonlyMap<string, string>, capturedUrls?: Map<string, string>) {
    if (typeof value === "string") {
        if (value.startsWith("image:") || value.startsWith("server:")) keys.add(value);
        const referencedKey = knownUrls?.get(value);
        if (referencedKey) keys.add(referencedKey);
        return keys;
    }
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && (value.storageKey.startsWith("image:") || value.storageKey.startsWith("server:"))) {
        keys.add(value.storageKey);
        if (capturedUrls) {
            for (const field of ["content", "url", "dataUrl"]) {
                const url = (value as Record<string, unknown>)[field];
                if (typeof url === "string" && url) capturedUrls.set(url, value.storageKey);
            }
        }
    }
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys, knownUrls, capturedUrls)) : collectImageStorageKeys(item, keys, knownUrls, capturedUrls)));
    return keys;
}

export function defaultUserStorageProvider(): UserS3StorageProvider {
    return {
        enabled: false,
        name: "我的 R2",
        type: "s3",
        endpoint: "",
        region: "auto",
        bucket: "",
        accessKeyId: "",
        secretAccessKey: "",
        publicBaseUrl: "",
        pathPrefix: "canvas",
    };
}

export function defaultUserWebDAVStorageProvider(): UserWebDAVStorageProvider {
    return {
        enabled: false,
        name: "我的 WebDAV",
        type: "webdav",
        endpoint: "",
        pathPrefix: "canvas",
        username: "",
        password: "",
    };
}

export function loadUserS3StorageProvider(scope: AccountScope = getAccountScope()) {
    if (typeof window === "undefined") return null;
    try {
        const scopedKey = scopedStorageKey(USER_STORAGE_PROVIDER_KEY, scope);
        let scoped = window.localStorage.getItem(scopedKey);
        if (!scoped && scope === "guest") {
            scoped = window.localStorage.getItem(USER_STORAGE_PROVIDER_KEY);
            if (scoped) window.localStorage.setItem(scopedKey, scoped);
            window.localStorage.removeItem(USER_STORAGE_PROVIDER_KEY);
            window.localStorage.setItem(`${USER_STORAGE_PROVIDER_KEY}:legacy-migrated`, "1");
        }
        const parsed = JSON.parse(scoped || "null") as UserS3StorageProvider | null;
        return parsed ? { ...defaultUserStorageProvider(), ...parsed, type: "s3" as const } : null;
    } catch {
        return null;
    }
}

export function loadUserWebDAVStorageProvider(scope: AccountScope = getAccountScope()) {
    if (typeof window === "undefined") return null;
    try {
        const scopedKey = scopedStorageKey(USER_WEBDAV_STORAGE_PROVIDER_KEY, scope);
        let scoped = window.localStorage.getItem(scopedKey);
        if (!scoped && scope === "guest") {
            scoped = window.localStorage.getItem(USER_WEBDAV_STORAGE_PROVIDER_KEY);
            if (scoped) window.localStorage.setItem(scopedKey, scoped);
            window.localStorage.removeItem(USER_WEBDAV_STORAGE_PROVIDER_KEY);
            window.localStorage.setItem(`${USER_WEBDAV_STORAGE_PROVIDER_KEY}:legacy-migrated`, "1");
        }
        const parsed = JSON.parse(scoped || "null") as UserWebDAVStorageProvider | null;
        return parsed ? { ...defaultUserWebDAVStorageProvider(), ...parsed, type: "webdav" as const } : null;
    } catch {
        return null;
    }
}

export function loadUserStorageProvider(scope: AccountScope = getAccountScope()): UserStorageProvider | null {
    const s3 = loadUserS3StorageProvider(scope);
    const webdav = loadUserWebDAVStorageProvider(scope);
    if (s3?.enabled && webdav?.enabled) return null;
    if (s3?.enabled && validS3Provider(s3)) return s3;
    if (webdav?.enabled && validWebDAVProvider(webdav)) return webdav;
    return null;
}

export function saveUserStorageProvider(provider: UserS3StorageProvider) {
    window.localStorage.setItem(scopedStorageKey(USER_STORAGE_PROVIDER_KEY), JSON.stringify({ ...defaultUserStorageProvider(), ...provider, type: "s3" }));
}

export function saveUserWebDAVStorageProvider(provider: UserWebDAVStorageProvider) {
    window.localStorage.setItem(scopedStorageKey(USER_WEBDAV_STORAGE_PROVIDER_KEY), JSON.stringify({ ...defaultUserWebDAVStorageProvider(), ...provider, type: "webdav" }));
}

function validS3Provider(provider: UserS3StorageProvider) {
    return Boolean(provider.endpoint && provider.bucket && provider.accessKeyId && provider.secretAccessKey);
}

function validWebDAVProvider(provider: UserWebDAVStorageProvider) {
    return Boolean(provider.endpoint && provider.username && provider.password);
}

export function toProviderPayload(provider: UserStorageProvider) {
    if (provider.type === "webdav") {
        return {
            enabled: provider.enabled,
            name: provider.name,
            type: "webdav" as const,
            endpoint: provider.endpoint,
            pathPrefix: provider.pathPrefix,
            username: provider.username,
            password: provider.password,
        };
    }
    return {
        enabled: provider.enabled,
        name: provider.name,
        type: "s3" as const,
        endpoint: provider.endpoint,
        region: provider.region || "auto",
        bucket: provider.bucket,
        accessKeyId: provider.accessKeyId,
        secretAccessKey: provider.secretAccessKey,
        publicBaseUrl: provider.publicBaseUrl,
        pathPrefix: provider.pathPrefix,
    };
}

async function deleteServerImage(storageKey: string, session: SessionCapture) {
    if (!isCurrent(session)) return;
    const id = storageKey.slice("server:".length);
    if (!id) return;
    const token = useUserStore.getState().token;
    serverUrls.delete(id);
    const provider = loadUserStorageProvider(session.scope);
    if (storageKey.startsWith("server:webdav:") && provider?.type !== "webdav") return;
    if (provider?.type === "webdav") {
        const direct = await import("@/services/webdav-direct-storage");
        if (await direct.deletePersistedDirectWebDAV(provider, storageKey)) {
            clearAutoSyncCache(storageKey);
            const cacheKey = runtimeKey(session.scope, storageKey);
            const url = objectUrls.get(cacheKey);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(cacheKey);
            await imageStore(session.scope).removeItem(storageKey);
            return;
        }
    }
    if (!token) {
        if (!provider) return;
        await deleteAnonymousStorageFile(id, toProviderPayload(provider));
        clearAutoSyncCache(storageKey);
        const url = objectUrls.get(storageKey);
        if (url) URL.revokeObjectURL(url);
        objectUrls.delete(storageKey);
        await imageStore(getAccountScope()).removeItem(storageKey);
        return;
    }
    const response = await fetch(`/api/v1/files/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(provider ? { provider: toProviderPayload(provider) } : {}),
    });
    const payload = (await response.json().catch(() => null)) as { code?: number; msg?: string } | null;
    if (!response.ok || payload?.code !== 0) throw new Error(payload?.msg || "删除服务端图片失败");
    clearAutoSyncCache(storageKey);
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(blob);
    });
}
