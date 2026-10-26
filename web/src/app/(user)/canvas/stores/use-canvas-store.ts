import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { capture, isCurrent, type SessionCapture } from "@/lib/account-scope";
import { localForageStorage, localForageStorageForScope } from "@/lib/localforage-storage";
import { CANVAS_PROJECT_SAVED_EVENT, CANVAS_PROJECT_SAVE_CONFLICT_EVENT, CANVAS_PROJECT_SAVE_REJECTED_EVENT, listCanvasProjects, saveCanvasProject, syncCanvasProjects } from "@/services/api/canvas-tasks";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAgentConfig, CanvasAssistantSession, CanvasConnection, CanvasNodeData, CanvasPendingAgentRequest, ViewportTransform } from "../types";

export type CanvasSidePanelState = {
    open: boolean;
    width: number;
};

export const DEFAULT_CANVAS_SIDE_PANEL: CanvasSidePanelState = { open: true, width: 280 };
export const DEFAULT_CANVAS_AGENT_PANEL: CanvasSidePanelState = { open: false, width: 464 };

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    agentConfig: CanvasAgentConfig | null;
    autoTitlePending: boolean;
    pendingAgentRequest?: CanvasPendingAgentRequest;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
    sidePanel: CanvasSidePanelState;
    agentPanel: CanvasSidePanelState;
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    createProject: (title?: string, options?: { agentConfig?: CanvasAgentConfig; pendingAgentRequest?: CanvasPendingAgentRequest }) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "agentConfig" | "autoTitlePending" | "backgroundMode" | "showImageInfo" | "viewport" | "sidePanel" | "agentPanel" | "pendingAgentRequest">>) => void;
    syncWithRemote: (token: string, syncEnabled: boolean) => Promise<void>;
    pullRemoteProjects: (token: string) => Promise<CanvasProject[] | null>;
    setSyncEnabled: (enabled: boolean) => void;
    resetForAccountTransition: () => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
type PersistedCanvasState = Pick<CanvasStore, "projects">;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let queuedPersistState: PersistedCanvasState | null = null;
let accountCanvasSyncEnabled = false;
let suppressCanvasPersist = false;
const projectSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

const projectSaveInFlight = new Set<string>();
// 保存进行中又来的变更在这里排队（同一画布只保留最新一次），保存结束后立即补发，
// 代替旧逻辑的"保存中直接丢弃、等下一次编辑才重新保存"。
const pendingProjectSaves = new Map<string, { token: string; session: SessionCapture; project: CanvasProject }>();

async function flushProjectSave(id: string) {
    if (projectSaveInFlight.has(id) || projectSaveTimers.has(id)) return;
    const pending = pendingProjectSaves.get(id);
    pendingProjectSaves.delete(id);
    if (!pending || !accountCanvasSyncEnabled || !isCurrent(pending.session) || useUserStore.getState().token !== pending.token) return;
    const { token, session, project } = pending;
    projectSaveInFlight.add(id);
    try {
        const result = await saveCanvasProject(token, project);
        if (!isCurrent(session)) return;
        if (result.rejected) {
            window.dispatchEvent(new CustomEvent(CANVAS_PROJECT_SAVE_REJECTED_EVENT, { detail: { projectId: id, message: result.rejected } }));
            return;
        }
        if (result.conflict && result.remote) {
            // 双开冲突：服务器有更新的版本。交给画布页做节点级合并后重存；
            // 页面未打开时事件无人处理，服务器版本保留（优于旧快照覆盖）。
            window.dispatchEvent(new CustomEvent(CANVAS_PROJECT_SAVE_CONFLICT_EVENT, { detail: { projectId: id, remote: result.remote } }));
            return;
        }
        window.dispatchEvent(new CustomEvent(CANVAS_PROJECT_SAVED_EVENT, { detail: { projectId: id, project } }));
    } catch {
        // 网络类失败静默，但把这一版放回队列 5s 后自动重试：
        // 有了排队机制就不再依赖用户再次编辑才补上这版内容。
        if (!pendingProjectSaves.has(id) && !projectSaveTimers.has(id)) {
            pendingProjectSaves.set(id, { token, session, project });
            projectSaveTimers.set(id, setTimeout(() => {
                projectSaveTimers.delete(id);
                void flushProjectSave(id);
            }, 5000));
        }
    } finally {
        projectSaveInFlight.delete(id);
        // 保存期间排队的新变更立即补发，不再等下一次编辑。
        void flushProjectSave(id);
    }
}

function queueProjectSave(project: CanvasProject) {
    const token = useUserStore.getState().token;
    // 排队时捕获账号代际：定时器触发时再 capture() 会永远是"当前"，挡不住账号切换后的旧保存。
    const session = capture();
    const previous = projectSaveTimers.get(project.id);
    if (previous) {
        clearTimeout(previous);
        projectSaveTimers.delete(project.id);
    }

    if (!token || !accountCanvasSyncEnabled) {
        pendingProjectSaves.delete(project.id);
        return;
    }
    pendingProjectSaves.set(project.id, { token, session, project });
    projectSaveTimers.set(
        project.id,
        setTimeout(() => {
            projectSaveTimers.delete(project.id);
            void flushProjectSave(project.id);
            // 1500ms 防抖：单次 project_data 保存是大 JSON 写入（云端曾因高频大行写入触发
            // SQLite 写锁竞争），拖拽/编辑过程中的中间态不必逐次上送；切换画布/账号时 timer 会被清理或校验失效。
        }, 1500),
    );
}

function cancelProjectSaves(ids: string[]) {
    ids.forEach((id) => {
        const timer = projectSaveTimers.get(id);
        if (!timer) return;
        clearTimeout(timer);
        projectSaveTimers.delete(id);
        pendingProjectSaves.delete(id);
    });
}

async function reconcileCanvasProjects(
    token: string,
    remoteProjects: CanvasProject[],
    localProjects: CanvasProject[],
) {
    const remoteById = new Map(
        remoteProjects.map((project) => [project.id, project]),
    );
    const missingProjects = localProjects.filter(
        (project) => !remoteById.has(project.id),
    );
    const existingLocalProjects = localProjects.filter((project) =>
        remoteById.has(project.id),
    );
    const projects = missingProjects.length
        ? await syncCanvasProjects(token, missingProjects)
            .then((syncedProjects) =>
                mergeCanvasProjects(
                    syncedProjects,
                    existingLocalProjects,
                ),
            )
            .catch(() =>
                mergeCanvasProjects(remoteProjects, localProjects),
            )
        : mergeCanvasProjects(remoteProjects, existingLocalProjects);

    localProjects.forEach((project) => {
        const remote = remoteById.get(project.id);
        if (
            remote &&
            Date.parse(project.updatedAt || "") >
            Date.parse(remote.updatedAt || "")
        ) {
            queueProjectSave(project);
        }
    });

    return projects;
}

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        const session = capture();
        const storage = localForageStorageForScope(session.scope);
        const localValue = await storage.getItem(name);
        if (!isCurrent(session)) return null;
        const localParsed = localValue
            ? (JSON.parse(localValue) as StorageValue<CanvasStore>)
            : null;
        if (!localParsed) return null;
        queuedPersistState = localParsed.state as PersistedCanvasState;
        return localParsed;
    },

    setItem: (name, value) => {
        if (suppressCanvasPersist) return;
        const nextState = value.state as PersistedCanvasState;
        if (
            queuedPersistState &&
            queuedPersistState.projects === nextState.projects
        ) {
            return;
        }
        queuedPersistState = nextState;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            void localForageStorage.setItem(name, JSON.stringify(value));
        }, 400);
    },
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            projects: [],
            createProject: (title = "未命名画布", options) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const project: CanvasProject = {
                    id,
                    title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    agentConfig: options?.agentConfig || null,
                    autoTitlePending: true,
                    pendingAgentRequest: options?.pendingAgentRequest,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: initialViewport,
                    sidePanel: DEFAULT_CANVAS_SIDE_PANEL,
                    agentPanel: options?.pendingAgentRequest ? { ...DEFAULT_CANVAS_AGENT_PANEL, open: true } : DEFAULT_CANVAS_AGENT_PANEL,
                };
                set((state) => ({
                    projects: [project, ...state.projects],
                }));
                queueProjectSave(project);
                return id;
            },
            importProject: (source) => {
                const now = new Date().toISOString();
                const project: CanvasProject = {
                    id: nanoid(),
                    title: source.title || "导入画布",
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: (source.chatSessions || []).map((session) => ({ ...session, codexThreadId: undefined, codexServiceId: undefined })),
                    activeChatId: source.activeChatId || null,
                    agentConfig: source.agentConfig || null,
                    autoTitlePending: false,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                    sidePanel: source.sidePanel || DEFAULT_CANVAS_SIDE_PANEL,
                    agentPanel: source.agentPanel || DEFAULT_CANVAS_AGENT_PANEL,
                };
                set((state) => ({
                    projects: [project, ...state.projects],
                }));
                queueProjectSave(project);
                return project.id;
            },
            openProject: (id) =>
                get().projects.find((item) => item.id === id) || null,
            renameProject: (id, title) => {
                const project = get().projects.find(
                    (item) => item.id === id,
                );
                if (!project) return;
                const nextProject = {
                    ...project,
                    title: title.trim() || project.title,
                    autoTitlePending: false,
                    updatedAt: new Date().toISOString(),
                };
                set((state) => ({
                    projects: state.projects.map((item) =>
                        item.id === id ? nextProject : item,
                    ),
                }));
                queueProjectSave(nextProject);
            },
            deleteProjects: (ids) => {
                cancelProjectSaves(ids);
                set((state) => ({
                    projects: state.projects.filter(
                        (project) => !ids.includes(project.id),
                    ),
                }));
            },
            updateProject: (id, patch) => {
                const project = get().projects.find(
                    (item) => item.id === id,
                );
                if (!project) return;
                const nextProject = {
                    ...project,
                    ...patch,
                    updatedAt: new Date().toISOString(),
                };
                set((state) => ({
                    projects: state.projects.map((item) =>
                        item.id === id ? nextProject : item,
                    ),
                }));
                queueProjectSave(nextProject);
            },
            syncWithRemote: async (token, syncEnabled) => {
                const session = capture();
                accountCanvasSyncEnabled = syncEnabled;
                if (!syncEnabled) return;
                const localProjects = get().projects;
                const remoteProjects = await listCanvasProjects(token).catch(
                    () => null,
                );
                if (!remoteProjects || !isCurrent(session) || useUserStore.getState().token !== token) return;
                const projects = await reconcileCanvasProjects(
                    token,
                    remoteProjects,
                    localProjects,
                );
                if (!isCurrent(session)) return;
                if (saveTimer) {
                    clearTimeout(saveTimer);
                    saveTimer = null;
                }
                const nextState = { projects };
                queuedPersistState = nextState;
                set(nextState);
                await localForageStorage.setItem(
                    CANVAS_STORE_KEY,
                    JSON.stringify({ state: nextState, version: 0 }),
                );
            },
            setSyncEnabled: (enabled) => {
                accountCanvasSyncEnabled = enabled;
            },
            pullRemoteProjects: async (token) => {
                const session = capture();
                const remoteProjects = await listCanvasProjects(token).catch(
                    () => null,
                );
                if (!remoteProjects || !isCurrent(session) || useUserStore.getState().token !== token) return null;
                const merged = mergeCanvasProjects(
                    remoteProjects,
                    get().projects,
                );
                if (saveTimer) {
                    clearTimeout(saveTimer);
                    saveTimer = null;
                }
                const nextState = { projects: merged };
                queuedPersistState = nextState;
                set(nextState);
                await localForageStorage.setItem(
                    CANVAS_STORE_KEY,
                    JSON.stringify({ state: nextState, version: 0 }),
                );
                return remoteProjects;
            },
            resetForAccountTransition: () => {
                accountCanvasSyncEnabled = false;
                if (saveTimer) clearTimeout(saveTimer);
                saveTimer = null;
                queuedPersistState = null;
                projectSaveTimers.forEach((timer) => clearTimeout(timer));
                projectSaveTimers.clear();
                pendingProjectSaves.clear();
                suppressCanvasPersist = true;
                set({ projects: [], hydrated: true });
                suppressCanvasPersist = false;
                void useCanvasStore.persist.rehydrate();
            },
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    projects: state.projects,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => () => {
                useCanvasStore.setState({ hydrated: true });
            },
        },
    ),
);

export function mergeCanvasProjects(
    remoteProjects: CanvasProject[],
    localProjects: CanvasProject[],
): CanvasProject[] {
    const projects = new Map<string, CanvasProject>();
    [...localProjects, ...remoteProjects].forEach((project) => {
        const previous = projects.get(project.id);
        if (
            !previous ||
            Date.parse(project.updatedAt || "") >=
            Date.parse(previous.updatedAt || "")
        ) {
            projects.set(project.id, project);
        }
    });
    return Array.from(projects.values()).sort(
        (a, b) =>
            Date.parse(b.updatedAt || "") -
            Date.parse(a.updatedAt || ""),
    );
}