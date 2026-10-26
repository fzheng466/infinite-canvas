import type { CanvasProject } from "../stores/use-canvas-store";

// 稳定序列化：键排序后比较，避免键序差异造成"内容相同却被判为已修改"。
function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value) ?? "undefined";
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(",")}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function sameContent(a: unknown, b: unknown): boolean {
    return stableStringify(a) === stableStringify(b);
}

// 按 id 的三方合并：本地改过→本地赢；本地未动→远端赢；
// 仅本地删除且远端未改→删除；远端已改→保留远端（保数据优先于执行删除）。
function mergeById<T extends { id: string }>(base: T[], local: T[], remote: T[]): T[] {
    const baseById = new Map(base.map((item) => [item.id, item]));
    const localById = new Map(local.map((item) => [item.id, item]));
    const remoteById = new Map(remote.map((item) => [item.id, item]));
    const ids = new Set<string>([...baseById.keys(), ...localById.keys(), ...remoteById.keys()]);
    const result: T[] = [];
    for (const id of ids) {
        const b = baseById.get(id);
        const l = localById.get(id);
        const r = remoteById.get(id);
        if (!b) {
            if (l && !r) result.push(l);
            else if (r) result.push(r);
            continue;
        }
        if (!l) {
            if (r && !sameContent(b, r)) result.push(r);
            continue;
        }
        if (!r) {
            if (!sameContent(b, l)) result.push(l);
            continue;
        }
        result.push(mergeFields(b, l, r));
    }
    return result;
}

// 字段级三方合并：本地只改了进度、远端改了位置时两边都保留，避免整节点覆盖导致位置回跳。
// metadata 内部同样按字段递归合并：只改进度不会盖掉远端改的分组归属或标题。
function mergeFields<T extends { id: string }>(base: T, local: T, remote: T): T {
    const result: Record<string, unknown> = {};
    const b = base as Record<string, unknown>, l = local as Record<string, unknown>, r = remote as Record<string, unknown>;
    for (const key of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
        const bm = b[key], lm = l[key], rm = r[key];
        // 只对 metadata 递归：progress/groupId 等字段相互独立，可安全混取；
        // position 这类坐标必须整体取一边，按 x/y 混合会拼出谁也没放过的位置。
        if (key === "metadata" && isPlainObject(bm) && isPlainObject(lm) && isPlainObject(rm)) {
            result[key] = mergeRecord(bm, lm, rm);
            continue;
        }
        result[key] = sameContent(bm, lm) ? rm : lm;
    }
    return result as T;
}

function mergeRecord(base: Record<string, unknown>, local: Record<string, unknown>, remote: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
        result[key] = sameContent(base[key], local[key]) ? remote[key] : local[key];
    }
    return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// 画布项目三方合并（保存冲突/定期对账共用）：
// - base：本页最后一次与服务器同步的快照；
// - local：当前页面状态（含未保存的本地编辑）；
// - remote：服务器最新版本（其他窗口/设备保存的内容）。
// 视口与面板属于设备本地 UI 状态，始终保留本地值。
export function mergeProjectOnConflict(base: CanvasProject, local: CanvasProject, remote: CanvasProject): CanvasProject {
    return {
        id: local.id,
        title: sameContent(base.title, local.title) ? remote.title : local.title,
        createdAt: remote.createdAt || local.createdAt,
        updatedAt: new Date().toISOString(),
        nodes: mergeById(base.nodes, local.nodes, remote.nodes),
        connections: mergeById(base.connections, local.connections, remote.connections),
        chatSessions: sameContent(base.chatSessions, local.chatSessions) ? remote.chatSessions : local.chatSessions,
        activeChatId: sameContent(base.activeChatId, local.activeChatId) ? remote.activeChatId : local.activeChatId,
        agentConfig: sameContent(base.agentConfig, local.agentConfig) ? remote.agentConfig : local.agentConfig,
        autoTitlePending: sameContent(base.autoTitlePending, local.autoTitlePending) ? remote.autoTitlePending : local.autoTitlePending,
        pendingAgentRequest: sameContent(base.pendingAgentRequest, local.pendingAgentRequest) ? remote.pendingAgentRequest : local.pendingAgentRequest,
        backgroundMode: sameContent(base.backgroundMode, local.backgroundMode) ? remote.backgroundMode : local.backgroundMode,
        showImageInfo: sameContent(base.showImageInfo, local.showImageInfo) ? remote.showImageInfo : local.showImageInfo,
        viewport: local.viewport,
        sidePanel: local.sidePanel,
        agentPanel: local.agentPanel,
    };
}

// 两份项目的可同步内容是否一致（忽略 updatedAt 与视口/面板等设备本地 UI 状态）。
// 对账/冲突合并结果与本地一致时不回填页面，避免多窗口之间"回填→自动保存→对方对账→再回填"的无限乒乓。
export function sameProjectContent(a: CanvasProject, b: CanvasProject): boolean {
    const pick = (project: CanvasProject) => ({
        title: project.title,
        nodes: project.nodes,
        connections: project.connections,
        chatSessions: project.chatSessions,
        activeChatId: project.activeChatId,
        agentConfig: project.agentConfig,
        autoTitlePending: project.autoTitlePending,
        pendingAgentRequest: project.pendingAgentRequest,
        backgroundMode: project.backgroundMode,
        showImageInfo: project.showImageInfo,
    });
    return sameContent(pick(a), pick(b));
}
