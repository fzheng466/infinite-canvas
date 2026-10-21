import type { CanvasProject } from "@/app/(user)/canvas/stores/use-canvas-store";
import { apiGet, apiPost, apiPostEnvelope, compactApiParams } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";

// 画布项目同步事件：store 在保存成功/冲突时派发，画布页监听以维护合并基线。
export const CANVAS_PROJECT_SAVED_EVENT = "infinite-canvas:project-saved";
export const CANVAS_PROJECT_SAVE_CONFLICT_EVENT = "infinite-canvas:project-save-conflict";
export const CANVAS_PROJECT_SAVE_REJECTED_EVENT = "infinite-canvas:project-save-rejected";

export async function listCanvasProjects(token: string) {
    return apiGet<CanvasProject[]>("/api/v1/canvas/projects", undefined, token);
}

// 对账接口：仅当服务器版本比 since 新时返回项目数据，否则 data 为 null。
export async function fetchCanvasProjectSince(id: string, since: string, token: string) {
    return apiGet<CanvasProject | null>(`/api/v1/canvas/projects/check/${encodeURIComponent(id)}`, { since }, token);
}

export type CanvasProjectSaveResult = {
    saved: boolean;
    conflict: boolean;
    remote: CanvasProject | null;
    // 服务器拒绝保存的原因（例如画布里新加入了不属于当前账号的素材）；不是网络失败，重试也不会成功。
    rejected?: string;
};

export async function saveCanvasProject(
    token: string,
    project: CanvasProject,
): Promise<CanvasProjectSaveResult> {
    const envelope = await apiPostEnvelope<CanvasProject | null>(
        "/api/v1/canvas/projects",
        { data: project },
        token,
    );
    if (envelope.code === 409 && envelope.data) {
        return { saved: false, conflict: true, remote: envelope.data };
    }
    if (envelope.code === 422) {
        return { saved: false, conflict: false, remote: null, rejected: envelope.msg || "画布包含不属于当前账号的素材，本次未保存" };
    }
    if (envelope.code !== 0) {
        throw new Error(envelope.msg || "画布保存失败");
    }
    return { saved: true, conflict: false, remote: null };
}

export async function syncCanvasProjects(
    token: string,
    projects: CanvasProject[],
) {
    return apiPost<CanvasProject[]>(
        "/api/v1/canvas/projects/sync",
        { projects },
        token,
    );
}

export async function deleteCanvasTasks(sourceId: string, nodeIds: string[] = []) {
    const token = useUserStore.getState().token;
    const source = sourceId.trim();
    if (!token || !source) return;
    return apiPost<{ deleted: boolean }>(
        "/api/v1/canvas/tasks/delete",
        {
            source_id: source,
            node_ids: Array.from(new Set(nodeIds.map((id) => id.trim()).filter(Boolean))),
        },
        token,
    );
}

export async function deleteCanvasProjects(ids: string[]) {
    const token = useUserStore.getState().token;
    const projectIds = Array.from(
        new Set(ids.map((id) => id.trim()).filter(Boolean)),
    );
    if (!token || !projectIds.length) return;
    return apiPost<{ deleted: boolean }>(
        "/api/v1/canvas/projects/delete",
        { ids: projectIds },
        token,
    );
}
