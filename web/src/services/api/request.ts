import axios from "axios";

export type ApiParams = Record<string, string | string[] | number | number[] | undefined>;

function csrfToken() {
    if (typeof document === "undefined") return "";
    return document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith("canvas_csrf="))?.slice("canvas_csrf=".length) || "";
}

type ApiResponse<T> = {
    code: number;
    data: T;
    msg: string;
};

// 仅表示请求没能到达服务器（断网、后端未启动）；业务拒绝（401/403/422 等）不会抛这个类型。
export class ApiNetworkError extends Error {
    constructor(message = "接口连接失败，请确认后端服务已启动") {
        super(message);
        this.name = "ApiNetworkError";
    }
}

// 创建类请求的网络失败重试：任务 ID 由前端生成且服务端按 ID 幂等（同 ID 重复创建返回已有任务），
// 因此同一 ID 重发创建请求是安全的。只重试"请求未送达"类失败（fetch TypeError / 超时 / ApiNetworkError），
// 业务拒绝（服务端返回了错误消息）原样抛出，避免掩盖真实原因。
export async function withNetworkRetry<T>(fn: (attempt: number) => Promise<T>, attempts = 3): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await fn(attempt);
        } catch (error) {
            lastError = error;
            if (attempt >= attempts) throw error;
            const networkish =
                error instanceof TypeError ||
                error instanceof ApiNetworkError ||
                (error instanceof DOMException && error.name === "TimeoutError");
            if (!networkish) throw error;
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
    }
    throw lastError;
}

export function compactApiParams(params: ApiParams) {
    return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== "" && value !== undefined && (!Array.isArray(value) || value.length > 0))) as ApiParams;
}

export function serializeApiParams(params?: ApiParams) {
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
        if (value === undefined) continue;
        if (Array.isArray(value)) value.forEach((item) => queryParams.append(key, String(item)));
        else queryParams.set(key, String(value));
    }
    return queryParams;
}

export async function apiGet<T>(url: string, params?: ApiParams, token?: string) {
    return apiRequest<T>({
        url,
        method: "GET",
        params: params || undefined,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
}

export async function apiPost<T>(url: string, body?: unknown, token?: string) {
    const envelope = await apiPostEnvelope<T>(url, body, token);
    if (envelope.code !== 0) {
        throw new Error(envelope.msg || "请求失败");
    }
    return envelope.data;
}

// 与 apiPost 相同，但业务码非 0 时不抛错（例如画布保存冲突 code=409 需要读取 data 里的服务器版本）。
export async function apiPostEnvelope<T>(url: string, body?: unknown, token?: string): Promise<ApiResponse<T>> {
    let response;
    try {
        response = await axios.request<ApiResponse<T>>({
            url,
            method: "POST",
            data: body ?? {},
            headers: {
                "Content-Type": "application/json",
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(csrfToken() ? { "X-CSRF-Token": csrfToken() } : {}),
            },
            validateStatus: () => true,
        });
    } catch {
        throw new ApiNetworkError();
    }

    const result = response.data;
    if (!result || typeof result !== "object") {
        throw new Error(response.status === 404 ? "接口不存在，请确认后端服务已启动" : "接口返回异常，请稍后重试");
    }
    return result;
}

export async function apiDelete<T>(url: string, token?: string) {
    return apiRequest<T>({
        url,
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
}

async function apiRequest<T>(config: { url: string; method: "GET" | "POST" | "DELETE"; params?: ApiParams; data?: unknown; headers?: Record<string, string> }) {
    let response;
    try {
        response = await axios.request<ApiResponse<T>>({
            url: config.url,
            method: config.method,
            params: config.params,
            paramsSerializer: { serialize: (params) => serializeApiParams(params as ApiParams).toString() },
            data: config.data,
            headers: {
                ...(config.headers || {}),
                ...(["POST", "PUT", "PATCH", "DELETE"].includes(config.method) && csrfToken() ? { "X-CSRF-Token": csrfToken() } : {}),
            },
            validateStatus: () => true,
        });
    } catch {
        throw new ApiNetworkError();
    }

    const result = response.data;
    if (!result || typeof result !== "object") {
        throw new Error(response.status === 404 ? "接口不存在，请确认后端服务已启动" : "接口返回异常，请稍后重试");
    }

    const payload = result as ApiResponse<T>;
    if (response.status < 200 || response.status >= 300 || payload.code !== 0) {
        throw new Error(payload.msg || "请求失败");
    }

    return payload.data;
}
