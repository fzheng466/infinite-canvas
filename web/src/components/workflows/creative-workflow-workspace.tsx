"use client";

import { Alert, App, Button, Checkbox, Empty, Image, Input, Modal, Select, Space, Switch, Tag, Typography } from "antd";
import { AlertCircle, ArrowDown, ArrowUp, Bot, CheckCircle2, ChevronLeft, ChevronRight, Copy, Download, Edit3, FilePlus2, Globe2, Layers3, LoaderCircle, LockKeyhole, Play, Plus, Sparkles, Trash2, WandSparkles } from "lucide-react";
import { nanoid } from "nanoid";
import { saveAs } from "file-saver";
import { useEffect, useMemo, useRef, useState } from "react";

import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { ModelPicker, listModelOptions } from "@/components/model-picker";
import { AssetPickerModal, type InsertAssetPayload } from "@/app/(user)/canvas/components/asset-picker-modal";
import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import { formatBytes, formatDuration, getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { capture, getAccountScope, isCurrent, type AccountScope, type SessionCapture } from "@/lib/account-scope";
import { createScopedLocalForage } from "@/lib/scoped-localforage";
import { createCanvasImageTask, requestEdit, requestGeneration, requestImageQuestion, type CanvasImageTask } from "@/services/api/image";
import { saveImageGenerationLogs } from "@/services/api/generation-logs";
import { ApiNetworkError } from "@/services/api/request";
import { deleteUserWorkflow, draftUserWorkflow, fetchUserConfig, fetchUserWorkflows, saveUserWorkflow, type CreativeWorkflowRecord } from "@/services/api/user-config";
import { deleteStoredImages, imageToDataUrl, uploadImage } from "@/services/image-storage";
import { channelProtocolForConfig, defaultConfig, localChannelForActiveModel, normalizeLocalChannels, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

type WorkflowVariableType = "text" | "textarea" | "number" | "select" | "boolean";
type WorkflowMode = "single_image" | "multi_image_series";
type WorkflowLoadStatus = "loading" | "remote" | "cache" | "local" | "error";

type WorkflowVariable = {
    id: string;
    key: string;
    label: string;
    type: WorkflowVariableType;
    required: boolean;
    defaultValue: string;
    options: string[];
    placeholder?: string;
};

export type WorkflowGenerationConfig = Pick<
    AiConfig,
    "model" | "imageModel" | "imageChannelId" | "quality" | "size" | "resolution" | "count" | "apiMode" | "timeout" | "streamImages" | "streamPartialImages" | "responseFormatB64Json" | "codexCli"
> & {
    systemPrompt: string;
    promptTemplate: string;
    negativePrompt: string;
};

type WorkflowSeriesConfig = {
    targetCount: string;
    promptModel: string;
    promptChannelId: string;
    promptInstruction: string;
    reviewRequired: boolean;
    concurrency: string;
};

type CreativeWorkflow = {
    id: string;
    ownerUserId?: string;
    scope: "private" | "public";
    editable?: boolean;
    preset?: "product_multi_angle_try_on" | "model_action_base";
    mode: WorkflowMode;
    name: string;
    category: string;
    description: string;
    variables: WorkflowVariable[];
    config: WorkflowGenerationConfig;
    seriesConfig: WorkflowSeriesConfig;
    createdAt: number;
    updatedAt: number;
    lastRunAt?: number;
};

type SeriesPromptDraft = {
    id: string;
    title: string;
    prompt: string;
    status: "draft" | "running" | "success" | "failed";
    error?: string;
    resultIds?: string[];
    // model_action_base：本条任务绑定的姿势参考图 id（2 参考图模式：底图 + 该姿势图）
    referenceId?: string;
};

export type WorkflowRunResult = {
    id: string;
    workflowId: string;
    workflowName: string;
    prompt: string;
    imageUrl: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
    durationMs: number;
    createdAt: number;
};

export type WorkflowExternalTaskStart = {
    taskId: string;
    workflowId: string;
    workflowName: string;
    prompt: string;
    inputs: Record<string, string>;
    references: ReferenceImage[];
    model: string;
    apiMode: AiConfig["apiMode"];
    config: WorkflowGenerationConfig;
    count: number;
    startedAt: number;
};

export type WorkflowExternalTaskSuccess = {
    taskId: string;
    images: WorkflowRunResult[];
    durationMs: number;
    endedAt: number;
};

export type WorkflowExternalTaskFailure = {
    taskId: string;
    error: string;
    durationMs: number;
    endedAt: number;
};

type WorkflowTask = {
    id: string;
    status: "running" | "success" | "failed";
    workflowId: string;
    workflowName: string;
    prompt: string;
    inputs: Record<string, string>;
    references: ReferenceImage[];
    model: string;
    apiMode: AiConfig["apiMode"];
    config: WorkflowGenerationConfig;
    count: number;
    startedAt: number;
    endedAt?: number;
    durationMs?: number;
    images: WorkflowRunResult[];
    error?: string;
    seriesTitle?: string;
    seriesIndex?: number;
};

type ImageHistoryLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: WorkflowGenerationConfig & Partial<Pick<AiConfig, "channelMode" | "activeChannelId">>;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    imageCount: number;
    size: string;
    quality: string;
    status: "生成中" | "成功" | "失败";
    images: Array<{
        id: string;
        dataUrl: string;
        storageKey: string;
        durationMs: number;
        width: number;
        height: number;
        bytes: number;
        mimeType: string;
    }>;
    thumbnails: string[];
    errors: string[];
    categoryIds: string[];
    workflowId: string;
    workflowName: string;
    workflowInputs: Record<string, unknown>;
    task?: CanvasImageTask;
    lastPolledAt?: number;
};

type GenerationCategory = { id: string; name: string; createdAt: number };

const WORKFLOW_STORE_KEY = "infinite-canvas:creative-workflows";
const SERIES_DRAFT_STORE_PREFIX = "infinite-canvas:series-drafts:";
const CATEGORY_STORE_KEY = "infinite-canvas:image_generation_categories";

// 分组参考图：每个预设工作流定义自己的参考图分组（数量上限/是否可排序/说明）
type WorkflowReferenceGroupDef = { key: string; label: string; uploadLabel: string; description: string; min: number; max: number; sortable: boolean };

function workflowRefGroupDefs(workflow: CreativeWorkflow | null | undefined): WorkflowReferenceGroupDef[] {
    if (workflow?.preset === "model_action_base") {
        return [
            { key: "base", label: "场景底图", uploadLabel: "上传底图", description: "固定 1 张：锁定人物、服装、镜头、光线和背景，生成时保持不变；人物身份以这张图为准", min: 1, max: 1, sortable: false },
            { key: "pose", label: "姿势参考图", uploadLabel: "上传姿势图", description: "每张对应一个独立任务（生成时只带底图+该姿势图两张参考）；◀ ▶ 可调整顺序，顺序即生成顺序", min: 1, max: 10, sortable: true },
        ];
    }
    if (workflow?.preset === "product_multi_angle_try_on") {
        return [
            { key: "base", label: "动作底图", uploadLabel: "上传动作底图", description: "每张对应一个独立换装任务（来自「模特动作底图」工作流的产出）；◀ ▶ 可调整顺序，顺序即视角顺序", min: 1, max: 10, sortable: true },
            { key: "product", label: "商品参考图", uploadLabel: "上传商品图", description: "同一商品的参考图 1~3 张（多角度：如正面/侧面/背面，单张也可以），用于还原服装；◀ ▶ 可调整角度顺序", min: 1, max: 3, sortable: true },
        ];
    }
    return [{ key: "default", label: "参考图", uploadLabel: "上传", description: "", min: 0, max: 10, sortable: false }];
}

function isFixedDraftPreset(workflow: CreativeWorkflow | null | undefined) {
    return workflow?.preset === "model_action_base" || workflow?.preset === "product_multi_angle_try_on";
}
// 每次操作捕获当前账号 scope，避免长任务跨账号写入。
const workflowStore = (scope = getAccountScope()) => createScopedLocalForage("creative_workflows", scope);
const imageLogStore = (scope = getAccountScope()) => createScopedLocalForage("image_generation_logs", scope);
const categoryStore = (scope = getAccountScope()) => createScopedLocalForage("image_generation_categories", scope);

const variableTypeOptions: Array<{ value: WorkflowVariableType; label: string }> = [
    { value: "text", label: "短文本" },
    { value: "textarea", label: "长文本" },
    { value: "number", label: "数字" },
    { value: "select", label: "选项" },
    { value: "boolean", label: "开关" },
];

const workflowModeOptions: Array<{ value: WorkflowMode; label: string }> = [
    { value: "single_image", label: "单图生成" },
    { value: "multi_image_series", label: "多图生成" },
];

export function CreativeWorkflowWorkspace({
    embedded = false,
    hideTaskList = false,
    onGenerationLogSaved,
    onWorkflowTaskStarted,
    onWorkflowTaskSuccess,
    onWorkflowTaskFailure,
}: {
    embedded?: boolean;
    hideTaskList?: boolean;
    onGenerationLogSaved?: () => void;
    onWorkflowTaskStarted?: (task: WorkflowExternalTaskStart) => void;
    onWorkflowTaskSuccess?: (task: WorkflowExternalTaskSuccess) => void;
    onWorkflowTaskFailure?: (task: WorkflowExternalTaskFailure) => void;
} = {}) {
    const { message, modal } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const token = useUserStore((state) => state.token);
    const isUserReady = useUserStore((state) => state.isReady);
    const [workflows, setWorkflows] = useState<CreativeWorkflow[]>([]);
    const [editingWorkflow, setEditingWorkflow] = useState<CreativeWorkflow | null>(null);
    const [runningWorkflow, setRunningWorkflow] = useState<CreativeWorkflow | null>(null);
    const [inputValues, setInputValues] = useState<Record<string, string>>({});
    const [workflowRefGroups, setWorkflowRefGroups] = useState<Record<string, ReferenceImage[]>>({});
    const [workflowUploadTarget, setWorkflowUploadTarget] = useState<string>("default");
    const workflowReferenceInputRef = useRef<HTMLInputElement>(null);
    const [workflowAssetPickerOpen, setWorkflowAssetPickerOpen] = useState(false);
    const [runResults, setRunResults] = useState<WorkflowRunResult[]>([]);
    const [workflowTasks, setWorkflowTasks] = useState<WorkflowTask[]>([]);
    const [seriesDrafts, setSeriesDrafts] = useState<SeriesPromptDraft[]>([]);
    const [seriesDraftLoading, setSeriesDraftLoading] = useState(false);
    const [seriesBatchAppend, setSeriesBatchAppend] = useState("");
    const [now, setNow] = useState(Date.now());
    const [query, setQuery] = useState("");
    const [workflowCategory, setWorkflowCategory] = useState("all");
    const [agentOpen, setAgentOpen] = useState(false);
    const [agentPrompt, setAgentPrompt] = useState("");
    const [agentScope, setAgentScope] = useState<"private" | "public">("private");
    const [agentTextModel, setAgentTextModel] = useState("");
    const [agentTextChannelId, setAgentTextChannelId] = useState("");
    const [agentLoading, setAgentLoading] = useState(false);
    const [agentDraft, setAgentDraft] = useState<CreativeWorkflow | null>(null);
    const [agentWarnings, setAgentWarnings] = useState<string[]>([]);
    const [agentReferences, setAgentReferences] = useState<ReferenceImage[]>([]);
    const agentReferenceInputRef = useRef<HTMLInputElement>(null);
    const [agentAssetPickerOpen, setAgentAssetPickerOpen] = useState(false);
    const workflowSyncEnabledRef = useRef(false);
    const seriesDraftsLoadedRef = useRef(false);
    const [loadStatus, setLoadStatus] = useState<WorkflowLoadStatus>("loading");
    const [loadError, setLoadError] = useState("");
    const [pendingLocalWorkflows, setPendingLocalWorkflows] = useState<CreativeWorkflow[]>([]);

    const filteredWorkflows = useMemo(() => {
        const text = query.trim().toLowerCase();
        return workflows.filter((workflow) => {
            if (workflowCategory !== "all" && (workflow.category || "未分类") !== workflowCategory) return false;
            if (!text) return true;
            return [workflow.name, workflow.category, workflow.description].some((value) => value.toLowerCase().includes(text));
        });
    }, [query, workflowCategory, workflows]);

    const workflowCategories = useMemo(() => Array.from(new Set(workflows.map((workflow) => workflow.category || "未分类"))).sort((a, b) => a.localeCompare(b, "zh-CN")), [workflows]);

    const renderedPrompt = useMemo(() => {
        if (!runningWorkflow) return "";
        // 两个预设工作流都改为按参考图分组动态生成提示词，历史存储的旧模板不再使用
        if (runningWorkflow.preset === "model_action_base") {
            const negativePrompt = runningWorkflow.config.negativePrompt.trim();
            return [MODEL_ACTION_BASE_POSE_PROMPT, negativePrompt ? `避免：${negativePrompt}` : ""].filter(Boolean).join("\n\n");
        }
        if (runningWorkflow.preset === "product_multi_angle_try_on") {
            return createTryOnTaskPrompt(runningWorkflow, inputValues, Math.max(1, workflowRefGroups.product?.length || 1));
        }
        return renderWorkflowPrompt(runningWorkflow, inputValues);
    }, [inputValues, runningWorkflow, workflowRefGroups]);
    const imageModelOptions = useMemo(() => Array.from(new Set(listModelOptions(effectiveConfig, "image").map((option) => option.model))), [effectiveConfig]);
    const runningTaskCount = workflowTasks.filter((task) => task.status === "running").length;
    const activeSeriesDrafts = seriesDrafts.filter((item) => item.status !== "success");
    const agentModel = agentTextModel || effectiveConfig.textModel || "";
    const agentChannelId = agentTextChannelId || effectiveConfig.textChannelId;
    const agentModelInfo = useMemo(() => describeModelSelection(effectiveConfig, agentModel, agentChannelId), [agentChannelId, agentModel, effectiveConfig]);

    useEffect(() => {
        if (!isUserReady) return;
        resetAccountState();
        void refreshWorkflows();
    }, [isUserReady, token]);

    // 账号连接从"网络异常"恢复后重新拉一次云端工作流（不清空页面，正在运行的任务保持不动）。
    const sessionDegraded = useUserStore((state) => state.sessionDegraded);
    const wasSessionDegradedRef = useRef(sessionDegraded);
    useEffect(() => {
        if (wasSessionDegradedRef.current && !sessionDegraded && isUserReady) void refreshWorkflows();
        wasSessionDegradedRef.current = sessionDegraded;
    }, [isUserReady, sessionDegraded]);

    useEffect(() => {
        if (!agentTextModel && effectiveConfig.textModel) setAgentTextModel(effectiveConfig.textModel);
        if (!agentTextChannelId && effectiveConfig.textChannelId) setAgentTextChannelId(effectiveConfig.textChannelId);
    }, [agentTextChannelId, agentTextModel, effectiveConfig.model, effectiveConfig.textChannelId, effectiveConfig.textModel]);

    useEffect(() => {
        if (!runningTaskCount) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [runningTaskCount]);

    useEffect(() => {
        if (!runningWorkflow || runningWorkflow.mode !== "multi_image_series" || !seriesDraftsLoadedRef.current) return;
        void workflowStore().setItem(seriesDraftStorageKey(runningWorkflow.id), seriesDrafts);
    }, [runningWorkflow?.id, runningWorkflow?.mode, seriesDrafts]);

    // 切换账号时先清空上一账号的列表、编辑器、运行结果，避免新账号加载完成前看到旧数据。
    const resetAccountState = () => {
        setWorkflows([]);
        setEditingWorkflow(null);
        setRunningWorkflow(null);
        setInputValues({});
        setWorkflowRefGroups({});
        setRunResults([]);
        setWorkflowTasks([]);
        setSeriesDrafts([]);
        setSeriesBatchAppend("");
        setAgentDraft(null);
        setAgentPrompt("");
        setAgentWarnings([]);
        setAgentReferences([]);
        setPendingLocalWorkflows([]);
        setLoadError("");
        setLoadStatus("loading");
        workflowSyncEnabledRef.current = false;
        seriesDraftsLoadedRef.current = false;
    };

    // 服务器快照是登录用户的唯一权威来源：加载失败必须可见，本机缓存只作带提示的兜底，
    // 服务器为空时也不再把本机缓存自动回灌（会复活其他设备已删除的数据）。
    const refreshWorkflows = async () => {
        const session = capture();
        const store = workflowStore(session.scope);
        const ownerToken = token;
        const stillCurrent = () => isCurrent(session) && useUserStore.getState().token === ownerToken;
        const readCache = async () => ((await store.getItem<CreativeWorkflow[]>(WORKFLOW_STORE_KEY).catch(() => null)) || []).map(normalizeWorkflow);

        if (!ownerToken) {
            workflowSyncEnabledRef.current = false;
            const cached = await readCache();
            if (!stillCurrent()) return;
            const items = cached.length ? await ensureStarterTemplates(cached, effectiveConfig, session.scope) : createStarterWorkflows(effectiveConfig);
            if (!stillCurrent()) return;
            setWorkflows(sortWorkflows(items));
            if (!cached.length) await store.setItem(WORKFLOW_STORE_KEY, items).catch(() => undefined);
            setLoadStatus("local");
            return;
        }

        setLoadStatus("loading");
        setLoadError("");
        try {
            const config = await fetchUserConfig(ownerToken);
            if (!stillCurrent()) return;
            workflowSyncEnabledRef.current = config.syncCapabilities?.workflows === true;
            if (!workflowSyncEnabledRef.current) throw new Error("服务器未开启工作流同步");
            const remote = (await fetchUserWorkflows<CreativeWorkflow>(ownerToken)).map(recordToWorkflow);
            if (!stillCurrent()) return;
            const cached = await readCache();
            if (!stillCurrent()) return;
            let items: CreativeWorkflow[];
            if (remote.length) {
                items = await ensureStarterTemplates(remote, effectiveConfig, session.scope);
                setPendingLocalWorkflows([]);
            } else {
                const seed = await ensureStarterTemplates([], effectiveConfig, session.scope);
                const saved = await Promise.all(seed.map((workflow) => saveUserWorkflow(ownerToken, workflowToRecord(workflow))));
                items = saved.map(recordToWorkflow);
                const starterNames = new Set(createStarterWorkflows(effectiveConfig).map((workflow) => workflow.name));
                setPendingLocalWorkflows(cached.filter((workflow) => !starterNames.has(workflow.name) && workflow.editable !== false));
            }
            if (!stillCurrent()) return;
            setWorkflows(sortWorkflows(items));
            await store.setItem(WORKFLOW_STORE_KEY, items).catch(() => undefined);
            setLoadStatus("remote");
        } catch (error) {
            if (!stillCurrent()) return;
            const cached = await readCache();
            if (!stillCurrent()) return;
            setLoadError(error instanceof Error ? error.message : "云端工作流加载失败");
            setWorkflows(sortWorkflows(cached));
            setLoadStatus(cached.length ? "cache" : "error");
        }
    };

    const uploadPendingLocalWorkflows = async () => {
        if (!token || !pendingLocalWorkflows.length) return;
        try {
            await Promise.all(pendingLocalWorkflows.map((workflow) => saveUserWorkflow(token, workflowToRecord(normalizeWorkflow({ ...workflow, scope: "private", ownerUserId: undefined })))));
            setPendingLocalWorkflows([]);
            message.success("本机工作流已上传到云端");
            await refreshWorkflows();
        } catch (error) {
            message.error(error instanceof Error ? `上传失败：${error.message}` : "上传失败");
        }
    };

    const saveWorkflows = async (items: CreativeWorkflow[]) => {
        const sorted = [...items].sort((a, b) => b.updatedAt - a.updatedAt);
        setWorkflows(sorted);
        await workflowStore().setItem(WORKFLOW_STORE_KEY, sorted);
    };

    const openRunner = (workflow: CreativeWorkflow) => {
        seriesDraftsLoadedRef.current = false;
        setRunningWorkflow(workflow);
        const values = createDefaultInputValues(workflow);
        setInputValues(values);
        setWorkflowRefGroups({});
        setSeriesDrafts([]);
        if (isFixedDraftPreset(workflow)) {
            // 两个预设都改为按参考图分组生成草稿，打开时先不预建
            setSeriesDrafts([]);
            seriesDraftsLoadedRef.current = true;
            return;
        }
        if (workflow.mode === "multi_image_series") {
            const session = capture();
            void workflowStore(session.scope).getItem<SeriesPromptDraft[]>(seriesDraftStorageKey(workflow.id)).then((drafts) => {
                if (!isCurrent(session)) return;
                setSeriesDrafts((drafts || []).map(normalizeSeriesDraft));
                seriesDraftsLoadedRef.current = true;
            });
        } else {
            seriesDraftsLoadedRef.current = true;
        }
    };

    const closeRunner = () => {
        setRunningWorkflow(null);
        setSeriesDrafts([]);
        setSeriesBatchAppend("");
        seriesDraftsLoadedRef.current = false;
    };

    const workflowGroupImages = (key: string) => workflowRefGroups[key] || [];

    const addWorkflowReferences = async (files?: FileList | null, groupKey = "default") => {
        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        const next = await Promise.all(
            imageFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey, source: "upload" as const, temporary: true };
            }),
        );
        setWorkflowRefGroups((value) => ({ ...value, [groupKey]: [...(value[groupKey] || []), ...next] }));
    };

    const removeWorkflowReference = async (id: string, groupKey = "default") => {
        const reference = workflowGroupImages(groupKey).find((item) => item.id === id);
        setWorkflowRefGroups((value) => ({ ...value, [groupKey]: (value[groupKey] || []).filter((item) => item.id !== id) }));
        if (reference?.storageKey && isDisposableReferenceFile(reference) && !referenceUsedByWorkflowTask(reference, workflowTasks)) {
            try {
                await deleteStoredImages([reference.storageKey]);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "参考图文件删除失败");
            }
        }
    };

    // 调整组内参考图顺序（如姿势图顺序、商品图角度顺序）
    const moveWorkflowReference = (id: string, direction: -1 | 1, groupKey = "default") => {
        setWorkflowRefGroups((value) => {
            const images = value[groupKey] || [];
            const index = images.findIndex((item) => item.id === id);
            const target = index + direction;
            if (index < 0 || target < 0 || target >= images.length) return value;
            const next = [...images];
            [next[index], next[target]] = [next[target], next[index]];
            return { ...value, [groupKey]: next };
        });
    };

    const addAgentReferences = async (files?: FileList | null) => {
        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        const next = await Promise.all(
            imageFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey, source: "upload" as const, temporary: true };
            }),
        );
        setAgentReferences((value) => [...value, ...next]);
    };

    const removeAgentReference = async (id: string) => {
        const reference = agentReferences.find((item) => item.id === id);
        setAgentReferences((value) => value.filter((item) => item.id !== id));
        if (reference?.storageKey && isDisposableReferenceFile(reference)) {
            try {
                await deleteStoredImages([reference.storageKey]);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "参考图文件删除失败");
            }
        }
    };

    const cleanupAgentReferences = async () => {
        const keys = agentReferences.filter(isDisposableReferenceFile).map((item) => item.storageKey).filter((key): key is string => Boolean(key));
        setAgentReferences([]);
        if (keys.length) await deleteStoredImages(keys).catch((error) => message.error(error instanceof Error ? error.message : "参考图文件删除失败"));
    };

    const insertWorkflowAsset = (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            const text = payload.content.trim();
            if (text) setInputValues((value) => ({ ...value, [runningWorkflow?.variables[0]?.key || "asset_text"]: text }));
            setWorkflowAssetPickerOpen(false);
            return;
        }
        if (payload.kind !== "image") {
            message.warning("视频素材不能作为工作流参考图");
            return;
        }
        setWorkflowRefGroups((value) => ({
            ...value,
            [workflowUploadTarget]: [
                ...(value[workflowUploadTarget] || []),
                {
                    id: nanoid(),
                    name: payload.title,
                    type: payload.mimeType || "image/png",
                    dataUrl: payload.dataUrl,
                    storageKey: payload.storageKey,
                    source: payload.source === "asset" ? "asset" : "library",
                    assetId: payload.assetId,
                    temporary: false,
                },
            ],
        }));
        setWorkflowAssetPickerOpen(false);
    };

    const insertAgentAsset = (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            const text = payload.content.trim();
            if (text) setAgentPrompt((value) => (value.trim() ? `${value.trim()}\n\n${text}` : text));
            setAgentAssetPickerOpen(false);
            return;
        }
        if (payload.kind !== "image") {
            message.warning("视频素材不能作为工作流 Agent 参考图");
            return;
        }
        setAgentReferences((value) => [
            ...value,
            {
                id: nanoid(),
                name: payload.title,
                type: payload.mimeType || "image/png",
                dataUrl: payload.dataUrl,
                storageKey: payload.storageKey,
                source: payload.source === "asset" ? "asset" : "library",
                assetId: payload.assetId,
                temporary: false,
            },
        ]);
        setAgentAssetPickerOpen(false);
    };

    const saveWorkflow = async (workflow: CreativeWorkflow) => {
        if (!workflow.name.trim()) {
            message.error("请输入工作流名称");
            return;
        }
        if (!workflow.config.promptTemplate.trim()) {
            message.error("请输入提示词模板");
            return;
        }
        const now = Date.now();
        let normalized = normalizeWorkflow({ ...workflow, name: workflow.name.trim(), category: workflow.category.trim(), updatedAt: now, createdAt: workflow.createdAt || now });
        let savedLocallyOnly = false;
        try {
            if (token) {
                normalized = recordToWorkflow(await saveUserWorkflow(token, workflowToRecord(normalized)));
                await refreshWorkflows();
            } else {
                await saveWorkflows([normalized, ...workflows.filter((item) => item.id !== normalized.id)]);
            }
        } catch (error) {
            // 只有"没连上服务器"才暂存本机；权限/校验被拒绝时不能在本地伪造保存成功。
            if (!(error instanceof ApiNetworkError)) {
                message.error(error instanceof Error ? `保存失败：${error.message}` : "工作流保存失败");
                return;
            }
            await saveWorkflows([normalized, ...workflows.filter((item) => item.id !== normalized.id)]);
            savedLocallyOnly = true;
        }
        if (agentDraft?.id === workflow.id) {
            await cleanupAgentReferences();
            setAgentDraft(null);
        }
        setEditingWorkflow(null);
        if (savedLocallyOnly) message.warning("网络异常，工作流已暂存到本机，网络恢复后请重新保存以同步到云端");
        else message.success("工作流已保存");
    };

    const duplicateWorkflow = async (workflow: CreativeWorkflow) => {
        const now = Date.now();
        const copy = normalizeWorkflow({ ...workflow, id: nanoid(), ownerUserId: undefined, editable: true, scope: "private", name: `${workflow.name} 副本`, createdAt: now, updatedAt: now, lastRunAt: undefined });
        try {
            if (token) {
                await saveUserWorkflow(token, workflowToRecord(copy));
                await refreshWorkflows();
            } else {
                await saveWorkflows([copy, ...workflows]);
            }
        } catch (error) {
            if (!(error instanceof ApiNetworkError)) {
                message.error(error instanceof Error ? `复制失败：${error.message}` : "工作流复制失败");
                return;
            }
            await saveWorkflows([copy, ...workflows]);
            message.warning("网络异常，副本已暂存到本机，网络恢复后请重新保存以同步到云端");
        }
    };

    const deleteWorkflow = (workflow: CreativeWorkflow) => {
        modal.confirm({
            title: "删除工作流",
            content: `确定删除「${workflow.name}」吗？本地模板会被移除，已生成的图片历史不受影响。`,
            okText: "删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: async () => {
                try {
                    if (token) {
                        await deleteUserWorkflow(token, workflow.id);
                        await rememberDismissedStarter(workflow.name);
                        await refreshWorkflows();
                    } else {
                        await rememberDismissedStarter(workflow.name);
                        await saveWorkflows(workflows.filter((item) => item.id !== workflow.id));
                    }
                } catch (error) {
                    // 删除失败时保留原项：本地先删会在下次同步时被服务器版本"复活"，看起来像删除失效。
                    message.error(error instanceof ApiNetworkError ? "网络异常，删除未完成，请稍后重试" : error instanceof Error ? `删除失败：${error.message}` : "工作流删除失败");
                    return;
                }
                if (runningWorkflow?.id === workflow.id) setRunningWorkflow(null);
            },
        });
    };

    const runWorkflowAgent = async () => {
        const text = agentPrompt.trim();
        if (!text) {
            message.error("请输入工作流需求");
            return;
        }
        if (!token) {
            message.warning("请先登录后使用工作流创建 Agent");
            return;
        }
        setAgentLoading(true);
        try {
            const textModel = agentTextModel || effectiveConfig.textModel || effectiveConfig.model;
            const textChannelId = agentTextChannelId || effectiveConfig.textChannelId;
            const textConfig = { ...effectiveConfig, model: textModel, textModel, textChannelId, activeChannelId: textChannelId };
            if (!isAiConfigReady(textConfig, textModel)) {
                openConfigDialog(true);
                return;
            }
            const localChannel = effectiveConfig.channelMode === "local" ? localChannelForActiveModel(textConfig) : null;
            const referenceDataUrls = await Promise.all(agentReferences.map((image) => imageToDataUrl(image)));
            const result = await draftUserWorkflow<Partial<CreativeWorkflow>>(token, {
                prompt: text,
                scope: agentScope,
                model: textModel,
                channelId: textChannelId,
                channelMode: effectiveConfig.channelMode,
                protocol: channelProtocolForConfig(textConfig),
                baseUrl: localChannel?.baseUrl,
                apiKey: localChannel?.apiKey,
                references: referenceDataUrls.filter(Boolean),
            });
            setAgentDraft(normalizeAgentDraft(result.draft, effectiveConfig, agentScope));
            setAgentWarnings(result.warnings || []);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "工作流 Agent 生成失败");
        } finally {
            setAgentLoading(false);
        }
    };

    const applyAgentDraft = () => {
        if (!agentDraft) return;
        setEditingWorkflow(agentDraft);
        setAgentOpen(false);
    };

    const runWorkflow = async () => {
        if (!runningWorkflow) return;
        const missing = runningWorkflow.variables.find((item) => item.required && !String(inputValues[item.key] || "").trim());
        if (missing) {
            message.error(`请填写 ${missing.label}`);
            return;
        }
        if (runningWorkflow.mode === "multi_image_series") {
            await generateSeriesPromptDrafts();
            return;
        }
        // 变量里选了模型(key 约定为 model)时,本次运行切到该模型出图
        const selectedModel = runningWorkflow.variables.find((item) => item.key === "model" && item.type === "select") ? String(inputValues.model || "").trim() : "";
        const workflowForRun = selectedModel ? { ...runningWorkflow, config: { ...runningWorkflow.config, model: selectedModel, imageModel: selectedModel } } : runningWorkflow;
        void startWorkflowImageTask(workflowForRun, renderedPrompt, { ...inputValues }, [...workflowGroupImages("default")]);
    };

    const generateSeriesPromptDrafts = async () => {
        if (!runningWorkflow) return;
        if (isFixedDraftPreset(runningWorkflow)) {
            if (runningWorkflow.preset === "model_action_base") {
                const bases = workflowGroupImages("base");
                const poses = workflowGroupImages("pose");
                if (bases.length !== 1 || poses.length < 1) {
                    message.error("请先上传 1 张场景底图和至少 1 张姿势参考图");
                    return;
                }
                setSeriesDrafts(createModelActionBaseDrafts(runningWorkflow, inputValues, poses));
                message.success(`已按 ${poses.length} 张姿势参考图生成任务草稿，请审核后生成图片`);
                return;
            }
            if (runningWorkflow.preset === "product_multi_angle_try_on") {
                const bases = workflowGroupImages("base");
                const products = workflowGroupImages("product");
                if (bases.length < 1 || products.length < 1) {
                    message.error("请先上传至少 1 张动作底图和 1 张商品参考图");
                    return;
                }
                setSeriesDrafts(createProductMultiAngleTryOnDrafts(runningWorkflow, inputValues, bases, products));
                message.success(`已按 ${bases.length} 张动作底图生成换装任务草稿，请审核后生成图片`);
                return;
            }
        }
        const promptModel = runningWorkflow.seriesConfig.promptModel || effectiveConfig.textModel || effectiveConfig.model;
        const promptChannelId = runningWorkflow.seriesConfig.promptChannelId || effectiveConfig.textChannelId;
        const textConfig = { ...effectiveConfig, model: promptModel, textModel: promptModel, textChannelId: promptChannelId, activeChannelId: promptChannelId, systemPrompt: effectiveConfig.systemPrompts.workflow || effectiveConfig.systemPrompt };
        if (!isAiConfigReady(textConfig, promptModel)) {
            message.warning("请先完成文本模型配置");
            openConfigDialog(true);
            return;
        }
        setSeriesDraftLoading(true);
        try {
            const count = Math.max(1, Math.min(20, Number(runningWorkflow.seriesConfig.targetCount) || Number(runningWorkflow.config.count) || 4));
            const answer = await requestImageQuestion(textConfig, [{ role: "user", content: buildSeriesPromptDraftRequest(runningWorkflow, renderedPrompt, count, inputValues) }], () => {});
            const drafts = parseSeriesPromptDrafts(answer, count, renderedPrompt);
            setSeriesDrafts(drafts);
            message.success("多图提示词已生成，请审核后生成图片");
            if (runningWorkflow.seriesConfig.reviewRequired === false) {
                window.setTimeout(() => {
                    drafts.forEach((draft, index) => void runSeriesDraft(draft, index));
                }, 0);
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "多图提示词生成失败");
        } finally {
            setSeriesDraftLoading(false);
        }
    };

    const updateSeriesDraft = (id: string, patch: Partial<SeriesPromptDraft>) => {
        setSeriesDrafts((value) => value.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    };

    const moveSeriesDraft = (id: string, direction: -1 | 1) => {
        setSeriesDrafts((value) => {
            const index = value.findIndex((item) => item.id === id);
            const target = index + direction;
            if (index < 0 || target < 0 || target >= value.length) return value;
            const next = [...value];
            [next[index], next[target]] = [next[target], next[index]];
            return next;
        });
    };

    const deleteSeriesDraft = (id: string) => {
        setSeriesDrafts((value) => value.filter((item) => item.id !== id));
    };

    const applySeriesBatchAppend = () => {
        const text = seriesBatchAppend.trim();
        if (!text) {
            message.warning("请输入要追加的批量要求");
            return;
        }
        setSeriesDrafts((value) => value.map((item) => ({ ...item, prompt: `${item.prompt.trim()}\n${text}`.trim(), status: item.status === "success" ? "draft" : item.status })));
        setSeriesBatchAppend("");
    };

    const runSeriesDraft = (draft: SeriesPromptDraft, index: number) => {
        if (!runningWorkflow || draft.status === "running" || !draft.prompt.trim()) return Promise.resolve();
        if (runningWorkflow.preset === "model_action_base") {
            // 两参考图模式：场景底图 + 本条绑定的姿势图
            const base = workflowGroupImages("base")[0];
            const pose = workflowGroupImages("pose").find((item) => item.id === draft.referenceId);
            if (!base || !pose) {
                updateSeriesDraft(draft.id, { status: "failed", error: "场景底图或姿势参考图已被删除，请重新生成草稿" });
                return Promise.resolve();
            }
            updateSeriesDraft(draft.id, { status: "running", error: undefined });
            return startWorkflowImageTask(runningWorkflow, draft.prompt.trim(), { ...inputValues }, [base, pose], 1, draft.id, draft.title || `姿势图 ${index + 1}`, index + 1);
        }
        if (runningWorkflow.preset === "product_multi_angle_try_on") {
            // 换装模式：本条绑定的动作底图 + 全部商品参考图（1~3 张）
            const base = workflowGroupImages("base").find((item) => item.id === draft.referenceId);
            const products = workflowGroupImages("product");
            if (!base || !products.length) {
                updateSeriesDraft(draft.id, { status: "failed", error: "动作底图或商品参考图已被删除，请重新生成草稿" });
                return Promise.resolve();
            }
            updateSeriesDraft(draft.id, { status: "running", error: undefined });
            return startWorkflowImageTask(runningWorkflow, draft.prompt.trim(), { ...inputValues }, [base, ...products], 1, draft.id, draft.title || `视角 ${index + 1}`, index + 1);
        }
        updateSeriesDraft(draft.id, { status: "running", error: undefined });
        return startWorkflowImageTask(runningWorkflow, draft.prompt.trim(), { ...inputValues }, [...workflowGroupImages("default")], 1, draft.id, draft.title || `第 ${index + 1} 张`, index + 1);
    };

    const runAllSeriesDrafts = async () => {
        if (!runningWorkflow) return;
        const missingGroup = workflowRefGroupDefs(runningWorkflow).find((def) => def.min > 0 && workflowGroupImages(def.key).length < def.min);
        if (missingGroup) {
            message.error(`${missingGroup.label}至少需要 ${missingGroup.min} 张，请先上传`);
            return;
        }
        const drafts = activeSeriesDrafts.filter((item) => item.prompt.trim() && item.status !== "running");
        if (!drafts.length) {
            message.warning("没有可生成的提示词");
            return;
        }
        const concurrency = Math.max(1, Math.min(6, Number(runningWorkflow.seriesConfig.concurrency) || 3));
        for (let index = 0; index < drafts.length; index += concurrency) {
            const batch = drafts.slice(index, index + concurrency);
            await Promise.all(batch.map((draft) => runSeriesDraft(draft, Math.max(0, seriesDrafts.findIndex((item) => item.id === draft.id)))));
        }
    };

    const startWorkflowImageTask = (workflow: CreativeWorkflow, promptSnapshot: string, inputSnapshot: Record<string, string>, referencesSnapshot: ReferenceImage[], countOverride?: number, seriesDraftId?: string, seriesTitle?: string, seriesIndex?: number) => {
        const runtime = resolveWorkflowRuntime(workflow, effectiveConfig);
        const model = runtime.model;
        const runConfig = buildRunConfig(effectiveConfig, workflow.config, runtime);
        if (!isAiConfigReady(runConfig, model)) {
            message.warning("请先完成 API 配置");
            openConfigDialog(true);
            return;
        }

        const startedAt = Date.now();
        const performanceStartedAt = performance.now();
        const count = Math.max(1, Math.min(10, countOverride || Number(runConfig.count) || 1));
        const taskId = nanoid();
        const session = capture();
        const taskConfig = { ...workflow.config, model, imageModel: model, imageChannelId: runtime.channelId, apiMode: runtime.apiMode, count: String(count) };
        onWorkflowTaskStarted?.({
            taskId,
            workflowId: workflow.id,
            workflowName: workflow.name,
            prompt: promptSnapshot,
            inputs: inputSnapshot,
            references: referencesSnapshot,
            model,
            apiMode: runtime.apiMode,
            config: taskConfig,
            count,
            startedAt,
        });
        setWorkflowTasks((value) => [
            {
                id: taskId,
                status: "running",
                workflowId: workflow.id,
                workflowName: workflow.name,
                prompt: promptSnapshot,
                inputs: inputSnapshot,
                references: referencesSnapshot,
                model,
                apiMode: runtime.apiMode,
                config: taskConfig,
                count,
                startedAt,
                images: [],
                seriesTitle,
                seriesIndex,
            },
            ...value,
        ]);
        message.success(seriesTitle ? `${seriesTitle} 已开始生成` : "工作流任务已开始");
        if (runConfig.channelMode === "remote" || (runConfig.channelMode === "local" && token)) {
            return createWorkflowImageTasks({ taskId, workflow, prompt: promptSnapshot, inputSnapshot, references: referencesSnapshot, runConfig, taskConfig, model, count, startedAt, seriesDraftId, seriesTitle, seriesIndex, session, ownerToken: token });
        }
        return executeWorkflowTask({ taskId, workflow, prompt: promptSnapshot, inputSnapshot, references: referencesSnapshot, runConfig, taskConfig, model, count, startedAt, performanceStartedAt, seriesDraftId, seriesTitle, seriesIndex, session, ownerToken: token });
    };

    // 生图记录写入发起任务时的账号：任务跑完前用户可能已切换账号，不能写进新账号的本机库。
    const saveWorkflowTaskLog = async (log: ImageHistoryLog, session: SessionCapture, ownerToken: string | null) => {
        await imageLogStore(session.scope).setItem(log.id, serializeHistoryLog(log));
        if (ownerToken) await saveImageGenerationLogs(ownerToken, [serializeHistoryLog(log)]).catch(() => undefined);
    };

    const createWorkflowImageTasks = async ({
        taskId,
        workflow,
        prompt,
        inputSnapshot,
        references,
        runConfig,
        taskConfig,
        model,
        count,
        startedAt,
        seriesDraftId,
        seriesTitle,
        seriesIndex,
        session,
        ownerToken,
    }: {
        taskId: string;
        workflow: CreativeWorkflow;
        prompt: string;
        inputSnapshot: Record<string, string>;
        references: ReferenceImage[];
        runConfig: AiConfig;
        taskConfig: WorkflowGenerationConfig;
        model: string;
        count: number;
        startedAt: number;
        seriesDraftId?: string;
        seriesTitle?: string;
        seriesIndex?: number;
        session: SessionCapture;
        ownerToken: string | null;
    }) => {
        const category = await ensureWorkflowCategory(workflow.name, session.scope);
        const taskLogs = Array.from({ length: count }, (_, index) => {
            const id = nanoid();
            const clientTaskId = `client_workflow_image_task_${taskId}_${index}`;
            return buildImageHistoryLog({
                id,
                workflow,
                prompt,
                config: { ...taskConfig, channelMode: runConfig.channelMode, activeChannelId: runConfig.activeChannelId },
                model,
                images: [],
                durationMs: 0,
                inputs: inputSnapshot,
                references,
                categoryIds: category ? [category.id] : [],
                seriesTitle,
                seriesIndex,
                status: "生成中",
                task: { id: clientTaskId, status: "queued", progress: 0, source: "workflow", source_id: id, createdAt: startedAt.toString(), created_at: startedAt.toString() },
            });
        });
        const settled = await Promise.allSettled(
            taskLogs.map(async (log, index) => {
                try {
                    const task = await createCanvasImageTask({ ...runConfig, seedIndex: index, seedCount: count, count: "1" }, prompt, references, { source: "workflow", sourceId: log.id, clientTaskId: log.task?.id || `${taskId}:${index}` });
                    await saveWorkflowTaskLog({ ...log, task, lastPolledAt: Date.now() }, session, ownerToken);
                } catch (error) {
                    const messageText = error instanceof Error ? error.message : "工作流图片任务创建失败";
                    await saveWorkflowTaskLog({ ...log, status: "失败", durationMs: Date.now() - startedAt, failCount: 1, errors: [messageText], lastPolledAt: Date.now() }, session, ownerToken);
                    throw error;
                }
            }),
        );
        if (!isCurrent(session)) return;
        onGenerationLogSaved?.();
        const createdCount = settled.filter((item) => item.status === "fulfilled").length;
        if (!createdCount) {
            const messageText = "工作流图片任务创建失败";
            if (seriesDraftId) updateSeriesDraft(seriesDraftId, { status: "failed", error: messageText });
            setWorkflowTasks((value) => value.map((task) => (task.id === taskId ? { ...task, status: "failed", endedAt: Date.now(), durationMs: Date.now() - startedAt, error: messageText } : task)));
            onWorkflowTaskFailure?.({ taskId, error: messageText, durationMs: Date.now() - startedAt, endedAt: Date.now() });
            message.error(messageText);
            return;
        }
        message.success(`已创建 ${createdCount} 个工作流图片任务`);
    };

    const executeWorkflowTask = async ({
        taskId,
        workflow,
        prompt,
        inputSnapshot,
        references,
        runConfig,
        taskConfig,
        model,
        count,
        startedAt,
        performanceStartedAt,
        seriesDraftId,
        seriesTitle,
        seriesIndex,
        session,
        ownerToken,
    }: {
        taskId: string;
        workflow: CreativeWorkflow;
        prompt: string;
        inputSnapshot: Record<string, string>;
        references: ReferenceImage[];
        runConfig: AiConfig;
        taskConfig: WorkflowGenerationConfig;
        model: string;
        count: number;
        startedAt: number;
        performanceStartedAt: number;
        seriesDraftId?: string;
        seriesTitle?: string;
        seriesIndex?: number;
        session: SessionCapture;
        ownerToken: string | null;
    }) => {
        try {
            const images = await Promise.all(Array.from({ length: count }, () => (references.length ? requestEdit({ ...runConfig, count: "1" }, prompt, references) : requestGeneration({ ...runConfig, count: "1" }, prompt))));
            const flattened = images.flat();
            if (!flattened.length) throw new Error("接口没有返回图片");
            const durationMs = performance.now() - performanceStartedAt;
            const storedImages = await Promise.all(
                flattened.map(async (image) => {
                    const meta = image.width && image.height && image.mimeType ? { width: image.width, height: image.height, mimeType: image.mimeType } : await readImageMeta(image.dataUrl);
                    return {
                        id: image.id,
                        dataUrl: image.dataUrl,
                        displayUrl: image.dataUrl,
                        storageKey: image.storageKey || "",
                        durationMs,
                        width: meta.width,
                        height: meta.height,
                        bytes: image.bytes || getDataUrlByteSize(image.dataUrl),
                        mimeType: image.mimeType || meta.mimeType,
                    };
                }),
            );
            const category = await ensureWorkflowCategory(workflow.name, session.scope);
            const log = buildImageHistoryLog({
                workflow,
                prompt,
                config: taskConfig,
                model,
                images: storedImages,
                durationMs,
                inputs: inputSnapshot,
                references,
                categoryIds: category ? [category.id] : [],
                seriesTitle,
                seriesIndex,
            });
            await imageLogStore(session.scope).setItem(log.id, serializeHistoryLog(log));
            const finishedAt = Date.now();
            if (ownerToken && workflow.editable !== false) void saveUserWorkflow(ownerToken, workflowToRecord({ ...workflow, lastRunAt: finishedAt, updatedAt: finishedAt })).catch(() => {});
            if (!isCurrent(session)) return;
            onGenerationLogSaved?.();
            setWorkflows((value) => {
                const next = value.map((item) => (item.id === workflow.id ? { ...item, lastRunAt: finishedAt, updatedAt: finishedAt } : item)).sort((a, b) => b.updatedAt - a.updatedAt);
                void workflowStore(session.scope).setItem(WORKFLOW_STORE_KEY, next);
                return next;
            });
            setRunningWorkflow((value) => (value?.id === workflow.id ? { ...value, lastRunAt: finishedAt, updatedAt: finishedAt } : value));
            const nextResults = storedImages.map((image) => ({
                id: image.id,
                workflowId: workflow.id,
                workflowName: workflow.name,
                prompt,
                imageUrl: image.displayUrl,
                storageKey: image.storageKey,
                width: image.width,
                height: image.height,
                bytes: image.bytes,
                mimeType: image.mimeType,
                durationMs,
                createdAt: finishedAt,
            }));
            if (seriesDraftId) {
                updateSeriesDraft(seriesDraftId, { status: "success", resultIds: nextResults.map((image) => image.id) });
            }
            setWorkflowTasks((value) =>
                value.map((task) =>
                    task.id === taskId
                        ? {
                              ...task,
                              status: "success",
                              endedAt: finishedAt,
                              durationMs,
                              images: nextResults,
                          }
                        : task,
                ),
            );
            setRunResults((value) => [...nextResults, ...value]);
            onWorkflowTaskSuccess?.({ taskId, images: nextResults, durationMs, endedAt: finishedAt });
            message.success("工作流运行完成，结果已写入生图历史");
        } catch (error) {
            if (!isCurrent(session)) return;
            const finishedAt = Date.now();
            const messageText = error instanceof Error ? error.message : "工作流运行失败";
            if (seriesDraftId) {
                updateSeriesDraft(seriesDraftId, { status: "failed", error: messageText });
            }
            setWorkflowTasks((value) =>
                value.map((task) =>
                    task.id === taskId
                        ? {
                              ...task,
                              status: "failed",
                              endedAt: finishedAt,
                              durationMs: finishedAt - startedAt,
                              error: messageText,
                          }
                        : task,
                ),
            );
            onWorkflowTaskFailure?.({ taskId, error: messageText, durationMs: finishedAt - startedAt, endedAt: finishedAt });
            message.error(messageText);
        }
    };

    return (
        <main className={`${embedded ? "h-full" : "h-full overflow-y-auto bg-stone-50 p-4 dark:bg-stone-950"} text-stone-950 dark:text-stone-50`}>
            <div className={`${embedded ? "h-full overflow-y-auto p-4" : "mx-auto max-w-7xl"} flex flex-col gap-4`}>
                <section
                    className={`${embedded ? "border-b border-stone-200 pb-4 dark:border-stone-800" : "rounded-lg border border-stone-200 bg-white/80 p-4 shadow-sm backdrop-blur dark:border-stone-800 dark:bg-stone-900/70"} flex flex-wrap items-center justify-between gap-3`}
                >
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 text-lg font-semibold">
                            <WandSparkles className="size-5" />
                            创作工作流
                        </div>
                        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{embedded ? "选择模板并启动任务，结果会写入生图历史。" : "把固定提示词和参数沉淀成模板，每次只填写变量即可批量复用。"}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Select
                            className="w-36"
                            value={workflowCategory}
                            options={[{ value: "all", label: "全部分类" }, ...workflowCategories.map((category) => ({ value: category, label: category }))]}
                            onChange={setWorkflowCategory}
                        />
                        <Input.Search allowClear placeholder="搜索名称、分类、描述" className="w-72 max-w-full" value={query} onChange={(event) => setQuery(event.target.value)} />
                        <Button icon={<Bot className="size-4" />} onClick={() => setAgentOpen(true)}>
                            AI 创建
                        </Button>
                        <Button icon={<Layers3 className="size-4" />} onClick={() => setEditingWorkflow(createBlankWorkflow(effectiveConfig, "multi_image_series"))}>
                            新建多图
                        </Button>
                        <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setEditingWorkflow(createBlankWorkflow(effectiveConfig))}>
                            新建工作流
                        </Button>
                    </div>
                </section>

                {loadStatus === "cache" ? (
                    <Alert
                        type="warning"
                        showIcon
                        message="云端工作流加载失败，当前显示本机缓存（可能不是最新）"
                        description={loadError || undefined}
                        action={<Button size="small" onClick={() => void refreshWorkflows()}>重试</Button>}
                    />
                ) : null}
                {loadStatus === "error" ? (
                    <Alert
                        type="error"
                        showIcon
                        message="云端工作流加载失败"
                        description={loadError || "请检查网络后重试"}
                        action={<Button size="small" onClick={() => void refreshWorkflows()}>重试</Button>}
                    />
                ) : null}
                {pendingLocalWorkflows.length ? (
                    <Alert
                        type="info"
                        showIcon
                        message={`本机有 ${pendingLocalWorkflows.length} 个工作流尚未同步到云端`}
                        description="它们只保存在这个浏览器里，上传后会作为你的个人工作流保存到账号。"
                        action={
                            <Space>
                                <Button size="small" type="primary" onClick={() => void uploadPendingLocalWorkflows()}>上传到云端</Button>
                                <Button size="small" onClick={() => setPendingLocalWorkflows([])}>忽略</Button>
                            </Space>
                        }
                    />
                ) : null}

                <section className={`${embedded ? "grid-cols-1 md:grid-cols-2 xl:grid-cols-3" : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3"} grid gap-3`}>
                    {filteredWorkflows.map((workflow) => (
                        <WorkflowCard key={workflow.id} workflow={workflow} onRun={() => openRunner(workflow)} onEdit={() => setEditingWorkflow(workflow)} onCopy={() => void duplicateWorkflow(workflow)} onDelete={() => deleteWorkflow(workflow)} />
                    ))}
                    {!filteredWorkflows.length ? (
                        <div className="col-span-full rounded-lg border border-dashed border-stone-300 bg-white/70 py-14 dark:border-stone-800 dark:bg-stone-900/60">
                            {loadStatus === "loading" ? (
                                <div className="flex items-center justify-center gap-2 text-sm text-stone-500">
                                    <LoaderCircle className="size-4 animate-spin" />
                                    正在加载云端工作流…
                                </div>
                            ) : (
                                <Empty description={loadStatus === "error" ? "工作流加载失败，请点击上方重试" : workflows.length ? "没有符合筛选条件的工作流" : "暂无工作流"} />
                            )}
                        </div>
                    ) : null}
                </section>

                {!hideTaskList && workflowTasks.length ? (
                    <section className="space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2 text-base font-semibold">
                                <LoaderCircle className={`size-4 ${runningTaskCount ? "animate-spin" : ""}`} />
                                工作流任务
                                <Tag className="m-0">{workflowTasks.length} 个</Tag>
                                {runningTaskCount ? (
                                    <Tag className="m-0" color="processing">
                                        {runningTaskCount} 运行中
                                    </Tag>
                                ) : null}
                            </div>
                            <Button size="small" onClick={() => setWorkflowTasks((value) => value.filter((task) => task.status === "running"))}>
                                清理已完成
                            </Button>
                        </div>
                        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                            {workflowTasks.map((task) => (
                                <WorkflowTaskCard key={task.id} task={task} now={now} onCopyPrompt={() => void navigator.clipboard.writeText(task.prompt)} onDownload={(image, index) => saveAs(image.imageUrl, `workflow-task-${index + 1}.png`)} />
                            ))}
                        </div>
                    </section>
                ) : null}

                {!hideTaskList && runResults.length ? (
                    <section className="space-y-3">
                        <div className="flex items-center gap-2 text-base font-semibold">
                            <Sparkles className="size-4" />
                            最近运行结果
                            <Tag className="m-0">{runResults.length} 张</Tag>
                        </div>
                        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
                            {runResults.map((result, index) => (
                                <div key={result.id} className="overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
                                    <Image src={result.imageUrl} alt={result.workflowName} className="aspect-[4/3] object-cover" />
                                    <div className="space-y-1 p-2 text-xs">
                                        <div className="line-clamp-1 font-medium">{result.workflowName}</div>
                                        <div className="flex flex-wrap gap-1 text-stone-500">
                                            <Tag className="m-0 text-[10px]">
                                                {result.width}x{result.height}
                                            </Tag>
                                            <Tag className="m-0 text-[10px]">{formatBytes(result.bytes)}</Tag>
                                            <Tag className="m-0 text-[10px]">{formatDuration(result.durationMs)}</Tag>
                                        </div>
                                        <div className="flex justify-end gap-1">
                                            <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => void navigator.clipboard.writeText(result.prompt)} />
                                            <Button size="small" icon={<Download className="size-3.5" />} onClick={() => saveAs(result.imageUrl, `workflow-${index + 1}.png`)} />
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>
                ) : null}
            </div>

            <WorkflowEditorModal
                open={Boolean(editingWorkflow)}
                workflow={editingWorkflow}
                modelConfig={effectiveConfig}
                theme={theme}
                onChange={setEditingWorkflow}
                onCancel={() => setEditingWorkflow(null)}
                onSave={(workflow) => void saveWorkflow(workflow)}
            />
            <Modal title="AI 创建工作流" open={agentOpen} width={980} onCancel={() => setAgentOpen(false)} footer={null} destroyOnHidden>
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
                    <div className="space-y-3">
                        <div className="flex items-center justify-between gap-3">
                            <div className="text-sm font-medium">描述你要沉淀的创作流程</div>
                            <div className="flex min-w-0 items-center gap-2">
                                <div className="hidden min-w-[220px] max-w-[360px] sm:block">
                                    <ModelPicker
                                        config={effectiveConfig}
                                        fullWidth
                                        capability="text"
                                        value={agentModel}
                                        channelId={agentChannelId}
                                        placeholder="选择 Agent 文本模型"
                                        onChange={(model, channelId) => {
                                            setAgentTextModel(model);
                                            setAgentTextChannelId(channelId || "");
                                        }}
                                        onMissingConfig={() => openConfigDialog(true)}
                                    />
                                </div>
                                <div className="hidden min-w-0 max-w-[220px] truncate rounded-md border border-stone-300 px-2 py-1 text-xs text-stone-600 dark:border-stone-700 dark:text-stone-300 lg:block" title={`${agentModelInfo.channelName} · ${agentModelInfo.modelName}`}>
                                    {agentModelInfo.channelName}
                                </div>
                                <div className="inline-flex rounded-md border border-stone-300 p-0.5 dark:border-stone-700">
                                    <button type="button" title="个人工作流" className={`inline-flex size-8 items-center justify-center rounded ${agentScope === "private" ? "border border-stone-400 text-stone-950 dark:border-stone-500 dark:text-stone-50" : "text-stone-500"}`} onClick={() => setAgentScope("private")}>
                                        <LockKeyhole className="size-4" />
                                    </button>
                                    <button type="button" title="公开工作流" className={`inline-flex size-8 items-center justify-center rounded ${agentScope === "public" ? "border border-stone-400 text-stone-950 dark:border-stone-500 dark:text-stone-50" : "text-stone-500"}`} onClick={() => setAgentScope("public")}>
                                        <Globe2 className="size-4" />
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div className="sm:hidden">
                            <ModelPicker
                                config={effectiveConfig}
                                fullWidth
                                capability="text"
                                value={agentModel}
                                channelId={agentChannelId}
                                placeholder="选择 Agent 文本模型"
                                onChange={(model, channelId) => {
                                    setAgentTextModel(model);
                                    setAgentTextChannelId(channelId || "");
                                }}
                                onMissingConfig={() => openConfigDialog(true)}
                            />
                        </div>
                        <Input.TextArea value={agentPrompt} autoSize={{ minRows: 14, maxRows: 22 }} placeholder="例如：创建一个电商海报工作流，只需要输入产品名称、核心卖点、活动信息，固定商业摄影质感和营销文案结构。" onChange={(event) => setAgentPrompt(event.target.value)} />
                        <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <div className="text-sm font-medium">参考图</div>
                                    <div className="mt-1 text-xs text-stone-500">可上传样例图，作为创建工作流的视觉参考。</div>
                                </div>
                                <div className="flex gap-2">
                                    <Button size="small" onClick={() => setAgentAssetPickerOpen(true)}>
                                        我的素材
                                    </Button>
                                    <Button size="small" onClick={() => agentReferenceInputRef.current?.click()}>
                                        上传
                                    </Button>
                                </div>
                            </div>
                            <input
                                ref={agentReferenceInputRef}
                                type="file"
                                accept="image/*"
                                multiple
                                className="hidden"
                                onChange={(event) => {
                                    const input = event.currentTarget;
                                    void addAgentReferences(input.files).finally(() => {
                                        input.value = "";
                                    });
                                }}
                            />
                            {agentReferences.length ? (
                                <div className="mt-3 grid grid-cols-5 gap-2">
                                    {agentReferences.map((image) => (
                                        <div key={image.id} className="group relative overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                                            <img src={image.dataUrl} alt={image.name} className="aspect-square w-full object-cover" />
                                            <button
                                                type="button"
                                                className="absolute right-1 top-1 grid size-6 place-items-center rounded bg-black/65 text-white opacity-0 transition group-hover:opacity-100"
                                                onClick={() => void removeAgentReference(image.id)}
                                                aria-label="删除参考图"
                                            >
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            ) : null}
                        </div>
                        <Button block type="primary" loading={agentLoading} icon={<Sparkles className="size-4" />} onClick={() => void runWorkflowAgent()}>
                            生成工作流草稿
                        </Button>
                    </div>
                    <aside className="space-y-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="text-sm font-medium">草稿预览</div>
                        {agentDraft ? (
                            <>
                                <div>
                                    <div className="text-base font-semibold">{agentDraft.name}</div>
                                    <div className="mt-1 flex flex-wrap gap-1">
                                        <Tag className="m-0">{agentDraft.category || "未分类"}</Tag>
                                        <Tag className="m-0">{agentDraft.variables.length} 个变量</Tag>
                                        <Tag className="m-0">{agentDraft.scope === "public" ? "公开" : "个人"}</Tag>
                                    </div>
                                </div>
                                <p className="text-sm text-stone-500 dark:text-stone-400">{agentDraft.description || "暂无描述"}</p>
                                <div className="max-h-60 overflow-y-auto rounded-md bg-stone-100 p-3 text-xs dark:bg-stone-950">
                                    <div className="whitespace-pre-wrap">{agentDraft.config.promptTemplate}</div>
                                </div>
                                {agentWarnings.length ? (
                                    <div className="space-y-1 text-xs text-amber-600 dark:text-amber-300">
                                        {agentWarnings.map((item) => (
                                            <div key={item}>{item}</div>
                                        ))}
                                    </div>
                                ) : null}
                                <Button block type="primary" onClick={applyAgentDraft}>
                                    应用到编辑器
                                </Button>
                            </>
                        ) : (
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="生成后在这里预览草稿" />
                        )}
                    </aside>
                </div>
            </Modal>
            <Modal title={runningWorkflow?.name || "运行工作流"} open={Boolean(runningWorkflow)} width={980} onCancel={closeRunner} footer={null} destroyOnHidden>
                {runningWorkflow ? (
                    <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
                        <div className="space-y-3">
                            <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                <div className="text-sm font-medium">变量输入</div>
                                <div className="mt-3 space-y-3">
                                    {runningWorkflow.variables.map((variable) => (
                                        <WorkflowVariableInput key={variable.id} variable={variable} value={inputValues[variable.key] || ""} dynamicOptions={imageModelOptions} onChange={(value) => setInputValues((current) => ({ ...current, [variable.key]: value }))} />
                                    ))}
                                    {!runningWorkflow.variables.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="此工作流没有变量" /> : null}
                                </div>
                            </div>
                            <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                <input
                                    ref={workflowReferenceInputRef}
                                    type="file"
                                    accept="image/*"
                                    multiple
                                    className="hidden"
                                    onChange={(event) => {
                                        const input = event.currentTarget;
                                        void addWorkflowReferences(input.files, workflowUploadTarget).finally(() => {
                                            input.value = "";
                                        });
                                    }}
                                />
                                {workflowRefGroupDefs(runningWorkflow).map((def) => {
                                    const images = workflowGroupImages(def.key);
                                    return (
                                        <div key={def.key} className={def.key === "default" ? "" : "mt-3 first:mt-0"}>
                                            <div className="flex items-center justify-between gap-3">
                                                <div className="text-sm font-medium">
                                                    {def.label}
                                                    {def.max > 1 ? <span className="ml-2 text-xs text-stone-400">{images.length}/{def.max}</span> : null}
                                                </div>
                                                <div className="flex gap-2">
                                                    <Button size="small" onClick={() => { setWorkflowUploadTarget(def.key); setWorkflowAssetPickerOpen(true); }}>
                                                        我的素材
                                                    </Button>
                                                    <Button size="small" onClick={() => { setWorkflowUploadTarget(def.key); workflowReferenceInputRef.current?.click(); }}>
                                                        {def.uploadLabel}
                                                    </Button>
                                                </div>
                                            </div>
                                            {def.description ? <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">{def.description}</div> : null}
                                            {images.length ? (
                                                <div className="mt-2 grid grid-cols-4 gap-2">
                                                    {images.map((image, index) => (
                                                        <div key={image.id} className="group relative overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                                                            <img src={image.dataUrl} alt={image.name} className="aspect-square w-full object-cover" />
                                                            {isFixedDraftPreset(runningWorkflow) ? <Tag className="absolute left-1 top-1 m-0 bg-black/65 !text-white">{workflowGroupReferenceLabel(def, index)}</Tag> : null}
                                                            {def.sortable ? (
                                                                <div className="absolute bottom-1 left-1 flex gap-1">
                                                                    <button
                                                                        type="button"
                                                                        className="grid size-6 place-items-center rounded bg-black/65 text-white transition hover:bg-black/85 disabled:opacity-35"
                                                                        onClick={() => moveWorkflowReference(image.id, -1, def.key)}
                                                                        disabled={index === 0}
                                                                        aria-label="前移"
                                                                    >
                                                                        <ChevronLeft className="size-3.5" />
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        className="grid size-6 place-items-center rounded bg-black/65 text-white transition hover:bg-black/85 disabled:opacity-35"
                                                                        onClick={() => moveWorkflowReference(image.id, 1, def.key)}
                                                                        disabled={index >= images.length - 1}
                                                                        aria-label="后移"
                                                                    >
                                                                        <ChevronRight className="size-3.5" />
                                                                    </button>
                                                                </div>
                                                            ) : null}
                                                            <button
                                                                type="button"
                                                                className="absolute right-1 top-1 grid size-6 place-items-center rounded bg-black/65 text-white opacity-0 transition group-hover:opacity-100"
                                                                onClick={() => void removeWorkflowReference(image.id, def.key)}
                                                                aria-label="删除参考图"
                                                            >
                                                                <Trash2 className="size-3.5" />
                                                            </button>
                                                        </div>
                                                    ))}
                                                </div>
                                            ) : (
                                                <div className="mt-2 rounded-md border border-dashed border-stone-300 py-4 text-center text-xs text-stone-500 dark:border-stone-800">未添加{def.label}</div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                            <Button block type="primary" size="large" loading={seriesDraftLoading} icon={runningWorkflow.mode === "multi_image_series" ? <Layers3 className="size-4" /> : <Play className="size-4" />} onClick={() => void runWorkflow()}>
                                {runningWorkflow.mode === "multi_image_series" ? "生成提示词" : "启动任务"}
                            </Button>
                        </div>
                        <div className="space-y-3">
                            <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                <div className="mb-2 flex items-center justify-between">
                                    <span className="text-sm font-medium">生成提示词预览</span>
                                    <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => void navigator.clipboard.writeText(renderedPrompt)}>
                                        复制
                                    </Button>
                                </div>
                                <Typography.Paragraph className="!mb-0 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md bg-stone-100 p-3 text-sm dark:bg-stone-950">{renderedPrompt || "填写变量后会在这里预览最终提示词"}</Typography.Paragraph>
                            </div>
                            <div className="grid grid-cols-2 gap-2 text-xs text-stone-500 dark:text-stone-400">
                                <InfoPill label="模型" value={resolveWorkflowRuntime(runningWorkflow, effectiveConfig).model} />
                                <InfoPill label="接口" value={resolveWorkflowRuntime(runningWorkflow, effectiveConfig).apiMode === "chat" ? "Chat" : resolveWorkflowRuntime(runningWorkflow, effectiveConfig).apiMode === "responses" ? "Responses" : "Images"} />
                                <InfoPill label="尺寸" value={runningWorkflow.config.size || effectiveConfig.size} />
                                <InfoPill label={runningWorkflow.mode === "multi_image_series" ? "草稿数量" : "数量"} value={`${runningWorkflow.mode === "multi_image_series" ? runningWorkflow.seriesConfig.targetCount || "4" : runningWorkflow.config.count || "1"} 张`} />
                            </div>
                            {runningWorkflow.mode === "multi_image_series" ? (
                                <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                                        <div className="flex items-center gap-2 text-sm font-medium">
                                            <Layers3 className="size-4" />
                                            多图提示词
                                            <Tag className="m-0">{seriesDrafts.length} 条</Tag>
                                        </div>
                                        <div className="flex gap-2">
                                            <Button size="small" loading={seriesDraftLoading} onClick={() => void generateSeriesPromptDrafts()}>
                                                重新生成
                                            </Button>
                                            <Button size="small" type="primary" disabled={!activeSeriesDrafts.length} onClick={() => void runAllSeriesDrafts()}>
                                                全部生成
                                            </Button>
                                        </div>
                                    </div>
                                    {seriesDrafts.length ? (
                                        <>
                                            <div className="mb-3 flex gap-2">
                                                <Input value={seriesBatchAppend} placeholder="批量追加要求，例如：统一使用同一套品牌色和字体风格" onChange={(event) => setSeriesBatchAppend(event.target.value)} />
                                                <Button onClick={applySeriesBatchAppend}>批量追加</Button>
                                            </div>
                                            <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
                                                {seriesDrafts.map((draft, index) => (
                                                    <SeriesPromptDraftCard
                                                        key={draft.id}
                                                        draft={draft}
                                                        index={index}
                                                        isFirst={index === 0}
                                                        isLast={index === seriesDrafts.length - 1}
                                                        onChange={(patch) => updateSeriesDraft(draft.id, patch)}
                                                        onGenerate={() => void runSeriesDraft(draft, index)}
                                                        onCopy={() => void navigator.clipboard.writeText(draft.prompt)}
                                                        onMoveUp={() => moveSeriesDraft(draft.id, -1)}
                                                        onMoveDown={() => moveSeriesDraft(draft.id, 1)}
                                                        onDelete={() => deleteSeriesDraft(draft.id)}
                                                    />
                                                ))}
                                            </div>
                                        </>
                                    ) : (
                                        <div className="rounded-md border border-dashed border-stone-300 py-10 text-center text-sm text-stone-500 dark:border-stone-800">点击“生成提示词”后在这里审核每张图的提示词</div>
                                    )}
                                </div>
                            ) : null}
                        </div>
                    </div>
                ) : null}
            </Modal>
            <AssetPickerModal open={agentAssetPickerOpen} defaultTab="my-assets" onInsert={insertAgentAsset} onClose={() => setAgentAssetPickerOpen(false)} />
            <AssetPickerModal open={workflowAssetPickerOpen} defaultTab="my-assets" onInsert={insertWorkflowAsset} onClose={() => setWorkflowAssetPickerOpen(false)} />
        </main>
    );
}

function WorkflowCard({ workflow, onRun, onEdit, onCopy, onDelete }: { workflow: CreativeWorkflow; onRun: () => void; onEdit: () => void; onCopy: () => void; onDelete: () => void }) {
    const editable = workflow.editable !== false;
    return (
        <article className="group flex min-h-[220px] flex-col overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:border-stone-300 hover:shadow-xl dark:border-stone-800 dark:bg-stone-900 dark:hover:border-stone-700">
            <div className="h-1 bg-gradient-to-r from-stone-900 via-stone-500 to-stone-300 opacity-80 dark:from-stone-100 dark:via-stone-500 dark:to-stone-800" />
            <div className="flex flex-1 flex-col p-3.5">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="line-clamp-1 text-base font-semibold">{workflow.name}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                        <Tag className="m-0">{workflow.category || "未分类"}</Tag>
                        <Tag className="m-0" color={workflow.mode === "multi_image_series" ? "purple" : undefined}>
                            {workflow.mode === "multi_image_series" ? "多图" : "单图"}
                        </Tag>
                        <Tag className="m-0">{workflow.variables.length} 个变量</Tag>
                        <Tag className="m-0" color={workflow.scope === "public" ? "blue" : undefined}>
                            {workflow.scope === "public" ? "公开" : "个人"}
                        </Tag>
                    </div>
                </div>
                <Button type="primary" size="small" icon={<Play className="size-3.5" />} onClick={onRun}>
                    运行
                </Button>
            </div>
            <p className="mt-3 line-clamp-2 min-h-10 text-sm text-stone-500 dark:text-stone-400">{workflow.description || "暂无描述"}</p>
            <div className="mt-3 rounded-md bg-stone-100/80 p-3 text-xs text-stone-600 dark:bg-stone-950/80 dark:text-stone-300">
                <div className="line-clamp-5 whitespace-pre-wrap">{workflow.config.promptTemplate}</div>
            </div>
            <div className="mt-auto flex items-center justify-between gap-2 pt-4 text-xs text-stone-500">
                <span>{workflow.lastRunAt ? `最近运行 ${formatDate(workflow.lastRunAt)}` : `创建于 ${formatDate(workflow.createdAt)}`}</span>
                <div className="flex gap-1">
                    <Button size="small" disabled={!editable} icon={<Edit3 className="size-3.5" />} onClick={onEdit} />
                    <Button size="small" icon={<FilePlus2 className="size-3.5" />} onClick={onCopy} />
                    <Button size="small" disabled={!editable} danger icon={<Trash2 className="size-3.5" />} onClick={onDelete} />
                </div>
            </div>
            </div>
        </article>
    );
}

function WorkflowTaskCard({ task, now, onCopyPrompt, onDownload }: { task: WorkflowTask; now: number; onCopyPrompt: () => void; onDownload: (image: WorkflowRunResult, index: number) => void }) {
    const elapsedMs = task.status === "running" ? now - task.startedAt : task.durationMs || (task.endedAt || task.startedAt) - task.startedAt;
    const statusView = {
        running: { label: "运行中", color: "processing", icon: <LoaderCircle className="size-4 animate-spin" /> },
        success: { label: "成功", color: "success", icon: <CheckCircle2 className="size-4" /> },
        failed: { label: "失败", color: "error", icon: <AlertCircle className="size-4" /> },
    }[task.status];

    return (
        <article className="overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
            <div className="flex items-start justify-between gap-3 border-b border-stone-200 p-3 dark:border-stone-800">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="shrink-0 text-stone-500 dark:text-stone-400">{statusView.icon}</span>
                        <div className="truncate font-medium">{task.workflowName}</div>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                        <Tag className="m-0" color={statusView.color}>
                            {statusView.label}
                        </Tag>
                        <Tag className="m-0">{formatDuration(elapsedMs)}</Tag>
                        <Tag className="m-0">{formatDate(task.startedAt)}</Tag>
                    </div>
                </div>
                <Button size="small" icon={<Copy className="size-3.5" />} onClick={onCopyPrompt}>
                    复制提示词
                </Button>
            </div>
            <div className="space-y-3 p-3">
                <div className="line-clamp-2 whitespace-pre-wrap text-sm text-stone-600 dark:text-stone-300">{task.prompt}</div>
                <div className="flex flex-wrap gap-1">
                    <Tag className="m-0 text-[10px]">{task.model}</Tag>
                    <Tag className="m-0 text-[10px]">{task.apiMode === "chat" ? "Chat" : task.apiMode === "responses" ? "Responses" : "Images"}</Tag>
                    <Tag className="m-0 text-[10px]">{task.config.size || "auto"}</Tag>
                    <Tag className="m-0 text-[10px]">{task.config.quality || "auto"}</Tag>
                    <Tag className="m-0 text-[10px]">{task.count} 张</Tag>
                    {task.apiMode !== "chat" && task.config.streamImages ? <Tag className="m-0 text-[10px]">流式 {task.config.streamPartialImages || "1"}</Tag> : null}
                </div>
                {Object.keys(task.inputs).length ? (
                    <div className="flex flex-wrap gap-1">
                        {Object.entries(task.inputs)
                            .filter(([, value]) => String(value).trim())
                            .slice(0, 6)
                            .map(([key, value]) => (
                                <Tag key={key} className="m-0 max-w-full text-[10px]">
                                    <span className="font-medium">{key}</span>: <span className="inline-block max-w-48 truncate align-bottom">{String(value)}</span>
                                </Tag>
                            ))}
                    </div>
                ) : null}
                {task.error ? <div className="rounded-md bg-red-100 px-2.5 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-300">{task.error}</div> : null}
                {task.images.length ? (
                    <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                        {task.images.map((image, index) => (
                            <div key={image.id} className="overflow-hidden rounded-md border border-stone-200 bg-stone-100 dark:border-stone-800 dark:bg-stone-950">
                                <Image src={image.imageUrl} alt={`${task.workflowName} ${index + 1}`} className="aspect-[4/3] object-cover" />
                                <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-[10px] text-stone-500">
                                    <span className="truncate">
                                        {image.width}x{image.height} · {formatBytes(image.bytes)}
                                    </span>
                                    <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(image, index)} />
                                </div>
                            </div>
                        ))}
                    </div>
                ) : task.status === "running" ? (
                    <div className="flex h-28 items-center justify-center rounded-md border border-dashed border-stone-300 text-sm text-stone-500 dark:border-stone-800">生成中 {formatDuration(elapsedMs)}</div>
                ) : null}
            </div>
        </article>
    );
}

function SeriesPromptDraftCard({
    draft,
    index,
    isFirst,
    isLast,
    onChange,
    onGenerate,
    onCopy,
    onMoveUp,
    onMoveDown,
    onDelete,
}: {
    draft: SeriesPromptDraft;
    index: number;
    isFirst: boolean;
    isLast: boolean;
    onChange: (patch: Partial<SeriesPromptDraft>) => void;
    onGenerate: () => void;
    onCopy: () => void;
    onMoveUp: () => void;
    onMoveDown: () => void;
    onDelete: () => void;
}) {
    const statusView = {
        draft: { label: "待生成", color: undefined },
        running: { label: "生成中", color: "processing" },
        success: { label: "已完成", color: "success" },
        failed: { label: "失败", color: "error" },
    }[draft.status];
    return (
        <article className="rounded-lg border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-950">
            <div className="mb-2 flex items-center justify-between gap-2">
                <Input value={draft.title} className="max-w-[280px]" placeholder={`第 ${index + 1} 张标题`} onChange={(event) => onChange({ title: event.target.value })} />
                <div className="flex shrink-0 items-center gap-1">
                    <Tag className="m-0" color={statusView.color}>{statusView.label}</Tag>
                    <Button size="small" icon={<Copy className="size-3.5" />} onClick={onCopy} />
                    <Button size="small" disabled={isFirst} icon={<ArrowUp className="size-3.5" />} onClick={onMoveUp} />
                    <Button size="small" disabled={isLast} icon={<ArrowDown className="size-3.5" />} onClick={onMoveDown} />
                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={onDelete} />
                    <Button size="small" type="primary" loading={draft.status === "running"} disabled={draft.status === "success"} icon={<Play className="size-3.5" />} onClick={onGenerate}>
                        生成
                    </Button>
                </div>
            </div>
            <Input.TextArea value={draft.prompt} autoSize={{ minRows: 3, maxRows: 7 }} onChange={(event) => onChange({ prompt: event.target.value, status: draft.status === "success" ? "draft" : draft.status })} />
            {draft.error ? <div className="mt-2 rounded-md bg-red-100 px-2.5 py-1.5 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-300">{draft.error}</div> : null}
        </article>
    );
}

function WorkflowEditorModal({
    open,
    workflow,
    modelConfig,
    theme,
    onChange,
    onCancel,
    onSave,
}: {
    open: boolean;
    workflow: CreativeWorkflow | null;
    modelConfig: AiConfig;
    theme: CanvasTheme;
    onChange: (workflow: CreativeWorkflow | null) => void;
    onCancel: () => void;
    onSave: (workflow: CreativeWorkflow) => void;
}) {
    if (!workflow) return null;
    const patch = (next: Partial<CreativeWorkflow>) => onChange({ ...workflow, ...next });
    const patchConfig = (next: Partial<WorkflowGenerationConfig>) => patch({ config: { ...workflow.config, ...next } });
    const patchSeriesConfig = (next: Partial<WorkflowSeriesConfig>) => patch({ seriesConfig: { ...workflow.seriesConfig, ...next } });
    const patchVariable = (id: string, next: Partial<WorkflowVariable>) => patch({ variables: workflow.variables.map((item) => (item.id === id ? normalizeVariable({ ...item, ...next }) : item)) });
    const removeVariable = (id: string) => patch({ variables: workflow.variables.filter((item) => item.id !== id) });

    return (
        <Modal title={workflow.createdAt ? "编辑工作流" : "新建工作流"} open={open} width={1080} onCancel={onCancel} onOk={() => onSave(workflow)} okText="保存" cancelText="取消" destroyOnHidden>
            <div className="grid max-h-[72vh] gap-4 overflow-y-auto pr-1 lg:grid-cols-[minmax(0,1fr)_360px]">
                <div className="space-y-4">
                    <section className="space-y-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="flex items-center justify-between gap-3">
                            <div className="text-sm font-medium">基础信息</div>
                            <div className="inline-flex rounded-md border border-stone-300 bg-transparent p-0.5 dark:border-stone-700">
                                <button type="button" title="个人工作流" className={`inline-flex size-8 items-center justify-center rounded transition ${workflow.scope !== "public" ? "border border-stone-400 text-stone-950 dark:border-stone-500 dark:text-stone-50" : "text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"}`} onClick={() => patch({ scope: "private" })}>
                                    <LockKeyhole className="size-4" />
                                </button>
                                <button type="button" title="公开工作流" className={`inline-flex size-8 items-center justify-center rounded transition ${workflow.scope === "public" ? "border border-stone-400 text-stone-950 dark:border-stone-500 dark:text-stone-50" : "text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"}`} onClick={() => patch({ scope: "public" })}>
                                    <Globe2 className="size-4" />
                                </button>
                            </div>
                        </div>
                        <Input value={workflow.name} placeholder="工作流名称" onChange={(event) => patch({ name: event.target.value })} />
                        <Input value={workflow.category} placeholder="分类，例如 电商海报" onChange={(event) => patch({ category: event.target.value })} />
                        <Select value={workflow.mode} options={workflowModeOptions} onChange={(mode) => patch({ mode })} />
                        <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} value={workflow.description} placeholder="适用场景说明" onChange={(event) => patch({ description: event.target.value })} />
                    </section>
                    <section className="space-y-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="flex items-center justify-between">
                            <span className="text-sm font-medium">输入变量</span>
                            <Button size="small" icon={<Plus className="size-3.5" />} onClick={() => patch({ variables: [...workflow.variables, createVariable()] })}>
                                添加变量
                            </Button>
                        </div>
                        <div className="space-y-2">
                            {workflow.variables.map((variable) => (
                                <div key={variable.id} className="grid gap-2 rounded-md bg-stone-100 p-2 dark:bg-stone-950 lg:grid-cols-[1fr_1fr_120px_auto]">
                                    <Input value={variable.key} placeholder="变量名 product_name" onChange={(event) => patchVariable(variable.id, { key: event.target.value })} />
                                    <Input value={variable.label} placeholder="显示名称" onChange={(event) => patchVariable(variable.id, { label: event.target.value })} />
                                    <Select
                                        value={variable.type}
                                        options={variableTypeOptions}
                                        onChange={(value) => {
                                            const inferredOptions = inferVariableOptions(variable);
                                            patchVariable(variable.id, { type: value, options: value === "select" && !variable.options.length ? inferredOptions : variable.options });
                                        }}
                                    />
                                    <div className="flex items-center gap-2">
                                        <Checkbox checked={variable.required} onChange={(event) => patchVariable(variable.id, { required: event.target.checked })}>
                                            必填
                                        </Checkbox>
                                        <Button danger size="small" icon={<Trash2 className="size-3.5" />} onClick={() => removeVariable(variable.id)} />
                                    </div>
                                    <div className="lg:col-span-4">
                                        <VariableEditorValueControls variable={variable} onChange={(next) => patchVariable(variable.id, next)} />
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>
                    <section className="space-y-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="text-sm font-medium">提示词模板</div>
                        <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} value={workflow.config.systemPrompt} placeholder="系统提示词，可选" onChange={(event) => patchConfig({ systemPrompt: event.target.value })} />
                        <Input.TextArea autoSize={{ minRows: 7, maxRows: 14 }} value={workflow.config.promptTemplate} placeholder="用户提示词模板，使用 {{变量名}} 插入变量" onChange={(event) => patchConfig({ promptTemplate: event.target.value })} />
                        <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} value={workflow.config.negativePrompt} placeholder="负面约束，可选" onChange={(event) => patchConfig({ negativePrompt: event.target.value })} />
                    </section>
                </div>
                <aside className="space-y-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                    <div className="text-sm font-medium">生成配置</div>
                    <ModelPicker config={modelConfig} fullWidth capability="image" value={workflow.config.imageModel || workflow.config.model} channelId={workflow.config.imageChannelId || modelConfig.imageChannelId} onChange={(value, channelId) => patchConfig({ imageModel: value, model: value, ...(channelId ? { imageChannelId: channelId } : {}) })} />
                    {workflow.mode === "multi_image_series" ? (
                        <div className="space-y-3 rounded-md bg-stone-100 p-3 text-sm dark:bg-stone-950">
                            <div className="flex items-center gap-2 font-medium">
                                <Layers3 className="size-4" />
                                多图提示词规划
                            </div>
                            <ModelPicker
                                config={modelConfig}
                                fullWidth
                                capability="text"
                                value={workflow.seriesConfig.promptModel || modelConfig.textModel || ""}
                                channelId={workflow.seriesConfig.promptChannelId || modelConfig.textChannelId}
                                placeholder="选择提示词文本模型"
                                onChange={(model, channelId) => patchSeriesConfig({ promptModel: model, promptChannelId: channelId || "" })}
                            />
                            <div className="grid grid-cols-2 gap-2">
                                <Space.Compact className="w-full">
                                    <span className="inline-flex h-8 shrink-0 items-center rounded-l-md border border-r-0 border-stone-300 bg-stone-50 px-2 text-xs text-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400">张数</span>
                                    <Input value={workflow.seriesConfig.targetCount} onChange={(event) => patchSeriesConfig({ targetCount: event.target.value })} />
                                </Space.Compact>
                                <Space.Compact className="w-full">
                                    <span className="inline-flex h-8 shrink-0 items-center rounded-l-md border border-r-0 border-stone-300 bg-stone-50 px-2 text-xs text-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400">并发</span>
                                    <Input value={workflow.seriesConfig.concurrency} onChange={(event) => patchSeriesConfig({ concurrency: event.target.value })} />
                                </Space.Compact>
                            </div>
                            <Input.TextArea autoSize={{ minRows: 3, maxRows: 6 }} value={workflow.seriesConfig.promptInstruction} placeholder="系列拆分说明，例如：按封面、痛点、功能、场景、对比、总结拆成 6 张图。" onChange={(event) => patchSeriesConfig({ promptInstruction: event.target.value })} />
                            <ToggleRow label="先审核提示词" checked={workflow.seriesConfig.reviewRequired !== false} onChange={(checked) => patchSeriesConfig({ reviewRequired: checked })} />
                        </div>
                    ) : null}
                    <Select
                        className="w-full"
                        value={workflow.config.apiMode}
                        options={[
                            { value: "images", label: "Images API" },
                            { value: "responses", label: "Responses API" },
                            { value: "chat", label: "Chat Completions" },
                        ]}
                        onChange={(value) => patchConfig({ apiMode: value })}
                    />
                    <ImageSettingsPanel
                        config={{ ...defaultConfig, ...workflow.config, model: workflow.config.model || defaultConfig.model, imageModel: workflow.config.imageModel || workflow.config.model || defaultConfig.imageModel }}
                        onConfigChange={(key, value) => patchConfig({ [key]: value } as Partial<WorkflowGenerationConfig>)}
                        theme={theme}
                        showTitle={false}
                        className="space-y-4"
                        maxCount={10}
                        quickCount={6}
                    />
                    <div className="space-y-2 rounded-md bg-stone-100 p-3 text-sm dark:bg-stone-950">
                        <ToggleRow label="流式传输" checked={Boolean(workflow.config.streamImages)} onChange={(checked) => patchConfig({ streamImages: checked ? "1" : "" })} />
                        <ToggleRow label="返回 Base64" checked={Boolean(workflow.config.responseFormatB64Json)} onChange={(checked) => patchConfig({ responseFormatB64Json: checked ? "1" : "" })} />
                        <ToggleRow label="Codex CLI 兼容" checked={Boolean(workflow.config.codexCli)} onChange={(checked) => patchConfig({ codexCli: checked ? "1" : "" })} />
                        <Space.Compact className="w-full">
                            <span className="inline-flex h-8 shrink-0 items-center rounded-l-md border border-r-0 border-stone-300 bg-stone-50 px-3 text-xs text-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400">超时(秒)</span>
                            <Input value={workflow.config.timeout} onChange={(event) => patchConfig({ timeout: event.target.value })} />
                        </Space.Compact>
                    </div>
                </aside>
            </div>
        </Modal>
    );
}

function WorkflowVariableInput({ variable, value, onChange, dynamicOptions }: { variable: WorkflowVariable; value: string; onChange: (value: string) => void; dynamicOptions?: string[] }) {
    const selectOptions = (variable.key === "model" && dynamicOptions?.length ? dynamicOptions : variable.options).map((item) => ({ value: item, label: item }));
    return (
        <label className="block space-y-1.5 text-sm">
            <span className="flex items-center gap-1 font-medium">
                {variable.label || variable.key}
                {variable.required ? <span className="text-red-500">*</span> : null}
            </span>
            {variable.type === "textarea" ? (
                <Input.TextArea autoSize={{ minRows: 3, maxRows: 6 }} value={value} placeholder={variable.placeholder || variable.defaultValue} onChange={(event) => onChange(event.target.value)} />
            ) : variable.type === "select" ? (
                <Select className="w-full" value={value || undefined} placeholder={variable.placeholder || "请选择"} options={selectOptions} onChange={onChange} />
            ) : variable.type === "boolean" ? (
                <Switch checked={value === "true"} onChange={(checked) => onChange(String(checked))} />
            ) : (
                <Input type={variable.type === "number" ? "number" : "text"} value={value} placeholder={variable.placeholder || variable.defaultValue} onChange={(event) => onChange(event.target.value)} />
            )}
        </label>
    );
}

function VariableEditorValueControls({ variable, onChange }: { variable: WorkflowVariable; onChange: (next: Partial<WorkflowVariable>) => void }) {
    const [optionDraft, setOptionDraft] = useState(variable.options.join(" / "));
    useEffect(() => {
        if (variable.type === "select") setOptionDraft(variable.options.join(" / "));
    }, [variable.id, variable.type]);

    if (variable.type === "boolean") {
        return (
            <div className="flex items-center gap-3 rounded-md border border-stone-200 px-3 py-2 dark:border-stone-800">
                <span className="text-xs text-stone-500">默认开关</span>
                <Switch size="small" checked={variable.defaultValue === "true"} onChange={(checked) => onChange({ defaultValue: String(checked) })} />
            </div>
        );
    }
    if (variable.type === "select") {
        return (
            <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_220px]">
                <Input
                    value={optionDraft}
                    placeholder="选项，例如 自动 / 清冷私房 / 极简韩系"
                    onChange={(event) => {
                        const text = event.target.value;
                        setOptionDraft(text);
                        const options = parseVariableOptions(text);
                        onChange({ options, defaultValue: options.includes(variable.defaultValue) ? variable.defaultValue : options[0] || "" });
                    }}
                />
                <Select className="w-full" value={variable.defaultValue || undefined} placeholder="默认选项" options={variable.options.map((item) => ({ value: item, label: item }))} onChange={(value) => onChange({ defaultValue: value })} />
            </div>
        );
    }
    if (variable.type === "textarea") {
        return <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} value={variable.defaultValue} placeholder="默认长文本" onChange={(event) => onChange({ defaultValue: event.target.value })} />;
    }
    return <Input type={variable.type === "number" ? "number" : "text"} value={variable.defaultValue} placeholder={variable.type === "number" ? "默认数字" : "默认值"} onChange={(event) => onChange({ defaultValue: event.target.value })} />;
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
    return (
        <div className="flex items-center justify-between gap-2">
            <span>{label}</span>
            <Switch size="small" checked={checked} onChange={onChange} />
        </div>
    );
}

function InfoPill({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-md bg-stone-100 px-3 py-2 dark:bg-stone-950">
            <div>{label}</div>
            <div className="mt-1 truncate text-stone-900 dark:text-stone-100">{value}</div>
        </div>
    );
}

function createBlankWorkflow(config: AiConfig, mode: WorkflowMode = "single_image"): CreativeWorkflow {
    const now = Date.now();
    const series = mode === "multi_image_series";
    return normalizeWorkflow({
        id: nanoid(),
        scope: "private",
        editable: true,
        name: series ? "多图系列生成" : "",
        category: series ? "多图创作" : "",
        description: series ? "根据主题生成一组连贯图片提示词，审核后批量生成图片。" : "",
        mode,
        variables: series ? [createVariable("topic", "主题", "textarea"), createVariable("style", "统一风格"), createVariable("platform", "发布平台")] : [createVariable("product_name", "产品名称"), createVariable("selling_points", "产品卖点", "textarea")],
        config: { ...createWorkflowConfig(config), ...(series ? { count: "1", promptTemplate: "围绕 {{topic}} 生成一组适合 {{platform}} 发布的连贯配图。\n统一风格：{{style}}\n要求：主题一致、画面重点各不相同、适合连续发布。" } : {}) },
        seriesConfig: createWorkflowSeriesConfig(config),
        createdAt: now,
        updatedAt: now,
    });
}

function createStarterWorkflows(config: AiConfig) {
    return [createStarterWorkflow(config), createStarterSeriesWorkflow(config), createModelActionBaseWorkflow(config), createProductMultiAngleTryOnWorkflow(config), createModelCompareWorkflow(config)];
}

// 老用户补种新内置模板；用户手动删除过的模板名按账号记录，不再重复补，也不影响同一浏览器的其他账号。
const DISMISSED_WORKFLOW_KEY = "dismissed-starter-workflows";
const STARTER_SCHEMA_VERSION = "v3-2026-09-16-prompt-fix";
const STARTER_SCHEMA_KEY = "infinite-canvas:starter-workflows-schema";

async function ensureStarterTemplates(workflows: CreativeWorkflow[], config: AiConfig, scope: AccountScope = getAccountScope()): Promise<CreativeWorkflow[]> {
    const store = workflowStore(scope);
    // 内置模板升级：schema 版本变化时清掉旧版内置模板(保留用户自建)与 dismiss 记录，重新补齐。
    const schema = await store.getItem<string>(STARTER_SCHEMA_KEY).catch(() => null);
    let stored = workflows;
    if (schema !== STARTER_SCHEMA_VERSION) {
        stored = workflows.filter((item) => !item.preset);
        await store.setItem(STARTER_SCHEMA_KEY, STARTER_SCHEMA_VERSION).catch(() => undefined);
        await store.setItem(DISMISSED_WORKFLOW_KEY, []).catch(() => undefined);
    }
    const existing = new Set(stored.map((item) => item.name));
    const dismissed = await store.getItem<string[]>(DISMISSED_WORKFLOW_KEY).catch(() => null);
    const dismissedSet = new Set(dismissed || []);
    const additions = createStarterWorkflows(config).filter((item) => !existing.has(item.name) && !dismissedSet.has(item.name));
    return additions.length ? [...stored, ...additions] : stored;
}

async function rememberDismissedStarter(name: string, scope: AccountScope = getAccountScope()) {
    const store = workflowStore(scope);
    const dismissed = await store.getItem<string[]>(DISMISSED_WORKFLOW_KEY).catch(() => null);
    await store.setItem(DISMISSED_WORKFLOW_KEY, Array.from(new Set([...(dismissed || []), name]))).catch(() => undefined);
}

function sortWorkflows(items: CreativeWorkflow[]) {
    return [...items].sort((a, b) => b.updatedAt - a.updatedAt);
}

function createModelCompareWorkflow(config: AiConfig): CreativeWorkflow {
    const now = Date.now();
    return normalizeWorkflow({
        id: nanoid(),
        scope: "private",
        editable: true,
        name: "多模型对比出图",
        category: "对比测试",
        description: "同一段提示词,在下拉里逐个切换模型运行,结果都进生图历史,直观比较画质、风格与耗时。",
        mode: "single_image",
        variables: [createVariable("model", "对比模型", "select"), createVariable("prompt", "生图提示词", "textarea"), createVariable("style", "风格要求")],
        config: {
            ...createWorkflowConfig(config),
            promptTemplate: "{{prompt}}\n风格要求:{{style}}",
        },
        seriesConfig: createWorkflowSeriesConfig(config),
        createdAt: now,
        updatedAt: now,
    });
}

function createStarterWorkflow(config: AiConfig): CreativeWorkflow {
    const now = Date.now();
    return normalizeWorkflow({
        id: nanoid(),
        scope: "private",
        editable: true,
        name: "电商海报生成",
        category: "电商海报",
        description: "固定海报构图、商业摄影质感和营销文案结构，只替换产品与卖点。",
        mode: "single_image",
        variables: [createVariable("product_name", "产品名称"), createVariable("selling_points", "核心卖点", "textarea"), createVariable("campaign", "活动信息")],
        config: {
            ...createWorkflowConfig(config),
            promptTemplate: "为 {{product_name}} 生成一张高端电商海报。\n核心卖点：{{selling_points}}\n活动信息：{{campaign}}\n要求：主体清晰、构图高级、商品有强烈质感，画面适合社交媒体和电商首图。",
        },
        seriesConfig: createWorkflowSeriesConfig(config),
        createdAt: now,
        updatedAt: now,
    });
}

function createStarterSeriesWorkflow(config: AiConfig): CreativeWorkflow {
    const now = Date.now();
    return normalizeWorkflow({
        id: nanoid(),
        scope: "private",
        editable: true,
        name: "小红书文章配图组",
        category: "多图创作",
        description: "根据文章主题和内容生成多张风格统一的封面、步骤、要点和总结配图。",
        mode: "multi_image_series",
        variables: [createVariable("article_topic", "文章主题"), createVariable("article_content", "文章内容", "textarea"), createVariable("visual_style", "视觉风格")],
        config: {
            ...createWorkflowConfig(config),
            count: "1",
            promptTemplate: "为小红书/公众号文章《{{article_topic}}》生成系列配图。\n文章内容：{{article_content}}\n视觉风格：{{visual_style}}\n要求：画面适合移动端阅读，主题连贯，每张图表达一个清晰信息点。",
        },
        seriesConfig: {
            ...createWorkflowSeriesConfig(config),
            targetCount: "6",
            promptInstruction: "拆成封面图、问题/痛点图、核心步骤图、细节说明图、对比/案例图和总结图；每张图都需要独立完整的图片提示词。",
            concurrency: "3",
        },
        createdAt: now,
        updatedAt: now,
    });
}

function createModelActionBaseWorkflow(config: AiConfig): CreativeWorkflow {
    const now = Date.now();
    const defaultRunConfig = createWorkflowConfig(config);
    return normalizeWorkflow({
        id: nanoid(),
        scope: "private",
        editable: true,
        preset: "model_action_base",
        name: "模特动作底图",
        category: "电商换装",
        description: "上传 1 张固定场景底图和 N 张姿势参考图，每张姿势图独立生成一个任务（底图+该姿势图两张参考）：把底图中人物的姿势替换为姿势图中的姿势，人物与背景保持不变。",
        mode: "multi_image_series",
        variables: [
            { ...createVariable("model_name", "模特/系列名称"), placeholder: "例如：秋季新品女模特" },
        ],
        config: {
            ...defaultRunConfig,
            model: config.model || defaultRunConfig.model,
            imageModel: config.model || defaultRunConfig.model,
            count: "1",
            size: "1:1",
            promptTemplate: MODEL_ACTION_BASE_POSE_PROMPT,
            negativePrompt: "换脸，模特身份漂移，五官变化，脸型变化，肤色变化，发型变化，背景替换，背景增删，背景结构变形，空间关系改变，机位变化，构图漂移，镜头变化，服装变化，姿势错配，动作僵硬，手指错误，多余肢体，肢体畸形，脸部瑕疵，重复人物，文字，水印，拼图，低清晰度，明显AI生成痕迹",
        },
        seriesConfig: {
            ...createWorkflowSeriesConfig(config),
            targetCount: "6",
            concurrency: "2",
            promptInstruction: "按姿势参考图逐张生成动作底图；每张任务只带场景底图和对应姿势图两张参考，由前端预设生成，不要让文本模型重新拆分或改写参考图槽位。",
        },
        createdAt: now,
        updatedAt: now,
    });
}

// model_action_base 两参考图模式的统一姿势替换指令
const MODEL_ACTION_BASE_POSE_PROMPT = [
    "图片1是唯一的场景、构图、镜头、景别、人物比例、服装、光线、色调和背景基准，必须保持背景中的物体、空间关系和机位完全不变；人物身份（脸型、五官、眉眼、肤色、发型和可识别特征）以图片1为准。",
    "图片2是姿势参考：只借鉴其动作、肢体方向和姿态，不得带入其中的人物、脸部、服装、背景、镜头或光线。",
    "请将图片1中人物的姿势替换为图片2中人物的姿势，其他一切保持图片1原样。",
    "输出一张自然真实的全身电商模特动作底图，单张画面，不要拼图、文字、水印或额外人物。",
].join("\n\n");

function createModelActionBaseDrafts(workflow: CreativeWorkflow, values: Record<string, string>, poseRefs: ReferenceImage[]): SeriesPromptDraft[] {
    const negativePrompt = workflow.config.negativePrompt.trim();
    return poseRefs.map((reference, index) => ({
        id: nanoid(),
        title: `姿势图${index + 1}`,
        status: "draft" as const,
        referenceId: reference.id,
        prompt: [MODEL_ACTION_BASE_POSE_PROMPT, negativePrompt ? `避免：${negativePrompt}` : ""].filter(Boolean).join("\n\n"),
    }));
}

// 换装模式：按商品图张数自适应参考描述（1 张=单参考；多张=多角度综合还原）
function productRefsSentence(productCount: number) {
    if (productCount <= 1) return "图片2 是该商品的参考图，用于准确还原服装的款式、颜色、版型、面料纹理和结构细节。";
    return `图片2-${productCount + 1} 是同一商品的多角度参考图（按上传顺序，如正面、侧面、背面），请综合各角度信息，在当前视角下准确还原服装的款式、颜色、版型、面料纹理、领口、袖口、纽扣、拉链、Logo和其他结构细节。`;
}

function createTryOnTaskPrompt(workflow: CreativeWorkflow, values: Record<string, string>, productCount: number) {
    const prompt = [
        `为 ${values.product_name || "商品"} 执行服装区域局部换装。商品必须保留的细节：${values.product_details || "按商品参考图还原全部细节"}。拍摄风格：${values.shooting_style || "干净电商棚拍，全身竖幅，真实服装质感"}。`,
        "图片1是本视角的动作底图，作为唯一的构图、姿势、人物、镜头、光线、空间关系和背景基准，保持完全不变。",
        productRefsSentence(productCount),
        "只修改原图服装区域，将商品准确替换到模特身上；脸部、头发、手部、身体姿态、肤色、背景、光线和所有非服装区域保持底图原样。",
        "输出单张自然真实的全身电商商品图。",
        workflow.config.negativePrompt.trim() ? `避免：${workflow.config.negativePrompt.trim()}` : "",
    ].filter(Boolean).join("\n\n");
    return prompt;
}

function createProductMultiAngleTryOnDrafts(workflow: CreativeWorkflow, values: Record<string, string>, baseRefs: ReferenceImage[], productRefs: ReferenceImage[]): SeriesPromptDraft[] {
    return baseRefs.map((reference, index) => ({
        id: nanoid(),
        title: `视角${index + 1}`,
        status: "draft" as const,
        referenceId: reference.id,
        prompt: createTryOnTaskPrompt(workflow, values, productRefs.length),
    }));
}

function createProductMultiAngleTryOnWorkflow(config: AiConfig): CreativeWorkflow {
    const now = Date.now();
    const defaultRunConfig = createWorkflowConfig(config);
    return normalizeWorkflow({
        id: nanoid(),
        scope: "private",
        editable: true,
        preset: "product_multi_angle_try_on",
        name: "商品多视角换装",
        category: "电商换装",
        description: "上传 N 张动作底图（每张一个视角）和 1~3 张商品参考图（多角度更佳），每张底图独立生成一个换装任务：只替换服装区域，人物、姿势和背景保持不变。",
        mode: "multi_image_series",
        variables: [
            { ...createVariable("product_name", "商品名称"), placeholder: "例如：羊毛圆领针织衫" },
            { ...createVariable("product_details", "商品细节", "textarea"), placeholder: "面料、版型、颜色、花纹、纽扣或辅料等必须保留的细节" },
            { ...createVariable("shooting_style", "拍摄风格"), defaultValue: "干净电商棚拍，全身竖幅，真实服装质感" },
        ],
        config: {
            ...defaultRunConfig,
            model: config.model || defaultRunConfig.model,
            imageModel: config.model || defaultRunConfig.model,
            count: "1",
            size: "2:3",
            promptTemplate: "为 {{product_name}} 执行服装区域局部换装。商品必须保留的细节：{{product_details}}。拍摄风格：{{shooting_style}}。图片1是本视角的动作底图（构图、姿势、人物、镜头、光线、背景基准）；商品参考图用于还原服装。只修改原图服装区域，脸部、姿势和背景保持底图原样。输出单张自然真实的全身电商商品图。",
            negativePrompt: "整图重绘，非服装区域重绘，换脸，模特身份漂移，脸型或五官变化，头发变化，手部变化，姿势变化，人物比例变化，镜头变化，背景替换，背景增删，背景漂移，光线变化，服装款式错误，颜色错误，版型变形，面料纹理丢失，领口错误，袖口错误，纽扣缺失，拉链缺失，Logo变形，服装边缘溢出，衣服与身体错位，额外配饰，额外商品，多余肢体，手指错误，文字，水印，拼图，低清晰度",
        },
        seriesConfig: {
            ...createWorkflowSeriesConfig(config),
            targetCount: "6",
            concurrency: "2",
            promptInstruction: "按动作底图逐张生成换装商品图；每张任务只带对应动作底图和商品参考图，不要让文本模型重新拆分或改写视角。",
        },
        createdAt: now,
        updatedAt: now,
    });
}

function createWorkflowConfig(config: AiConfig): WorkflowGenerationConfig {
    return {
        model: config.model || defaultConfig.model,
        imageModel: config.imageModel || config.model || defaultConfig.imageModel,
        imageChannelId: config.imageChannelId || "",
        quality: config.quality || defaultConfig.quality,
        size: config.size || defaultConfig.size,
        resolution: config.resolution || defaultConfig.resolution,
        count: config.count || "1",
        apiMode: config.apiMode || "images",
        timeout: config.timeout || "600",
        streamImages: config.streamImages || "",
        streamPartialImages: config.streamPartialImages || "1",
        responseFormatB64Json: config.responseFormatB64Json || "",
        codexCli: config.codexCli || "",
        systemPrompt: config.systemPrompts.workflow || config.systemPrompt || "",
        promptTemplate: "",
        negativePrompt: "",
    };
}

function createWorkflowSeriesConfig(config: AiConfig): WorkflowSeriesConfig {
    return {
        targetCount: "4",
        promptModel: config.textModel || config.model || defaultConfig.textModel,
        promptChannelId: config.textChannelId || "",
        promptInstruction: "围绕同一主题拆分成封面图、核心信息图、场景图和总结图；每张图需要画面重点不同但视觉风格一致。",
        reviewRequired: true,
        concurrency: "3",
    };
}

function describeModelSelection(config: AiConfig, modelName: string, channelId: string) {
    const selectedModel = modelName || "未选择模型";
    if (config.channelMode === "local") {
        const channel = localChannelForActiveModel({ ...config, model: selectedModel, activeChannelId: channelId });
        return { channelName: channel?.name || "本地直连", modelName: selectedModel };
    }
    const channel =
        config.publicChannels.find((item) => item.id === channelId && item.models?.includes(selectedModel)) ||
        config.publicChannels.find((item) => item.models?.includes(selectedModel)) ||
        config.publicChannels.find((item) => item.id === channelId) ||
        config.publicChannels[0];
    return { channelName: channel?.name || "云端渠道", modelName: selectedModel };
}

function createVariable(key = "", label = "", type: WorkflowVariableType = "text"): WorkflowVariable {
    return normalizeVariable({ id: nanoid(), key, label, type, required: true, defaultValue: "", options: [] });
}

function normalizeAgentDraft(draft: Partial<CreativeWorkflow>, config: AiConfig, scope: "private" | "public"): CreativeWorkflow {
    const now = Date.now();
    return normalizeWorkflow({
        id: nanoid(),
        scope: draft.scope === "public" ? "public" : scope,
        editable: true,
        name: draft.name || "AI 创建工作流",
        category: draft.category || "",
        description: draft.description || "",
        mode: draft.mode === "multi_image_series" ? "multi_image_series" : "single_image",
        variables: (draft.variables || []).map((variable) => ({ ...createVariable(), ...variable, id: variable.id || nanoid() })),
        config: { ...createWorkflowConfig(config), ...(draft.config || {}) },
        seriesConfig: { ...createWorkflowSeriesConfig(config), ...(draft.seriesConfig || {}) },
        createdAt: now,
        updatedAt: now,
    });
}

function normalizeVariable(variable: WorkflowVariable): WorkflowVariable {
    const key = variable.key.replace(/[^\w.-]/g, "_");
    return { ...variable, key, label: variable.label || key, defaultValue: variable.defaultValue == null ? "" : String(variable.defaultValue), options: Array.isArray(variable.options) ? variable.options : parseVariableOptions(String(variable.options || "")) };
}

function normalizeWorkflow(workflow: CreativeWorkflow): CreativeWorkflow {
    return {
        ...workflow,
        scope: workflow.scope === "public" ? "public" : "private",
        editable: workflow.editable !== false,
        mode: workflow.mode === "multi_image_series" ? "multi_image_series" : "single_image",
        variables: (workflow.variables || []).map(normalizeVariable),
        config: { ...createWorkflowConfig(defaultConfig), ...(workflow.config || {}) },
        seriesConfig: { ...createWorkflowSeriesConfig(defaultConfig), ...(workflow.seriesConfig || {}) },
        createdAt: workflow.createdAt || Date.now(),
        updatedAt: workflow.updatedAt || Date.now(),
    };
}

function createDefaultInputValues(workflow: CreativeWorkflow) {
    return Object.fromEntries(workflow.variables.map((variable) => [variable.key, variable.defaultValue || (variable.type === "boolean" ? "false" : "")]));
}

function renderPromptTemplate(template: string, values: Record<string, string>) {
    return template.replace(/{{\s*([\w.-]+)\s*}}/g, (_match, key: string) => values[key] || "");
}

function renderWorkflowPrompt(workflow: CreativeWorkflow, values: Record<string, string>) {
    const formattedValues = Object.fromEntries(workflow.variables.map((variable) => [variable.key, formatWorkflowVariableValue(variable, values[variable.key])]));
    const prompt = renderPromptTemplate(workflow.config.promptTemplate, formattedValues).trim();
    const negativePrompt = workflow.config.negativePrompt.trim();
    return negativePrompt ? `${prompt}\n\n避免：${negativePrompt}` : prompt;
}

function workflowGroupReferenceLabel(def: WorkflowReferenceGroupDef, index: number) {
    return def.max === 1 ? def.label : `${def.label}${index + 1}`;
}

function formatWorkflowVariableValue(variable: WorkflowVariable, value: string | undefined) {
    const raw = value ?? variable.defaultValue ?? "";
    if (variable.type !== "boolean") return raw;
    return raw === "true" ? "开启" : "关闭";
}

function parseVariableOptions(text: string) {
    return text
        .split(/[\/\n]/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function buildSeriesPromptDraftRequest(workflow: CreativeWorkflow, basePrompt: string, count: number, values: Record<string, string>) {
    const variables = Object.entries(values)
        .filter(([, value]) => String(value).trim())
        .map(([key, value]) => `- ${key}: ${value}`)
        .join("\n");
    return [
        "你是多图创作策划助手。请基于工作流信息，为同一主题生成一组互相连贯但画面重点不同的图片生成提示词。",
        "必须只返回 JSON，不要 Markdown。JSON 结构为：{\"items\":[{\"title\":\"第1张标题\",\"prompt\":\"完整图片提示词\"}]}。",
        `目标张数：${count}`,
        `工作流名称：${workflow.name}`,
        `工作流分类：${workflow.category || "未分类"}`,
        `工作流描述：${workflow.description || "无"}`,
        workflow.seriesConfig.promptInstruction ? `系列拆分规则：${workflow.seriesConfig.promptInstruction}` : "",
        variables ? `用户输入变量：\n${variables}` : "",
        `基础提示词：\n${basePrompt}`,
        "要求：每条 prompt 必须可以独立用于图片生成；保持统一主题、统一风格和连续叙事；避免重复构图；不要包含解释文字。",
    ]
        .filter(Boolean)
        .join("\n\n");
}

function parseSeriesPromptDrafts(content: string, count: number, fallbackPrompt: string): SeriesPromptDraft[] {
    const jsonText = extractJSONText(content);
    if (jsonText) {
        try {
            const payload = JSON.parse(jsonText) as { items?: Array<{ title?: string; prompt?: string }> } | Array<{ title?: string; prompt?: string }>;
            const items = Array.isArray(payload) ? payload : payload.items || [];
            const drafts = items
                .map((item, index) => ({ id: nanoid(), title: item.title?.trim() || `第 ${index + 1} 张`, prompt: item.prompt?.trim() || "", status: "draft" as const }))
                .filter((item) => item.prompt);
            if (drafts.length) return drafts.slice(0, count);
        } catch {
            // Fall back to line parsing below.
        }
    }
    const lines = content
        .split(/\n+/)
        .map((line) => line.replace(/^[-*\d.、\s]+/, "").trim())
        .filter(Boolean)
        .slice(0, count);
    if (lines.length) {
        return lines.map((line, index) => ({ id: nanoid(), title: `第 ${index + 1} 张`, prompt: line, status: "draft" as const }));
    }
    return Array.from({ length: count }, (_, index) => ({ id: nanoid(), title: `第 ${index + 1} 张`, prompt: `${fallbackPrompt}\n\n系列图片：第 ${index + 1} 张，画面重点与其他图片保持差异。`, status: "draft" as const }));
}

function extractJSONText(content: string) {
    const trimmed = content.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
    const objectStart = trimmed.indexOf("{");
    const objectEnd = trimmed.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) return trimmed.slice(objectStart, objectEnd + 1);
    const arrayStart = trimmed.indexOf("[");
    const arrayEnd = trimmed.lastIndexOf("]");
    if (arrayStart >= 0 && arrayEnd > arrayStart) return trimmed.slice(arrayStart, arrayEnd + 1);
    return "";
}

function seriesDraftStorageKey(workflowId: string) {
    return `${SERIES_DRAFT_STORE_PREFIX}${workflowId}`;
}

function normalizeSeriesDraft(draft: SeriesPromptDraft): SeriesPromptDraft {
    return {
        id: draft.id || nanoid(),
        title: draft.title || "未命名",
        prompt: draft.prompt || "",
        status: draft.status === "running" ? "draft" : draft.status || "draft",
        error: draft.error,
        resultIds: Array.isArray(draft.resultIds) ? draft.resultIds : [],
        referenceId: draft.referenceId,
    };
}

function inferVariableOptions(variable: WorkflowVariable) {
    return parseVariableOptions([variable.defaultValue, variable.placeholder, variable.options.join("/")].filter(Boolean).join("/"));
}

function workflowToRecord(workflow: CreativeWorkflow): CreativeWorkflowRecord<CreativeWorkflow> {
    return {
        id: workflow.id,
        ownerUserId: workflow.ownerUserId,
        scope: workflow.scope === "public" ? "public" : "private",
        name: workflow.name,
        category: workflow.category,
        description: workflow.description,
        data: workflow,
        createdAt: new Date(workflow.createdAt).toISOString(),
        updatedAt: new Date(workflow.updatedAt).toISOString(),
        lastRunAt: workflow.lastRunAt ? new Date(workflow.lastRunAt).toISOString() : undefined,
        editable: workflow.editable !== false,
    };
}

function recordToWorkflow(record: CreativeWorkflowRecord<CreativeWorkflow>): CreativeWorkflow {
    const data = record.data || ({} as CreativeWorkflow);
    return normalizeWorkflow({
        ...data,
        id: record.id || data.id,
        ownerUserId: record.ownerUserId,
        scope: record.scope === "public" ? "public" : "private",
        editable: record.editable,
        name: record.name || data.name || "",
        category: record.category || data.category || "",
        description: record.description || data.description || "",
        createdAt: record.createdAt ? Date.parse(record.createdAt) : data.createdAt,
        updatedAt: record.updatedAt ? Date.parse(record.updatedAt) : data.updatedAt,
        lastRunAt: record.lastRunAt ? Date.parse(record.lastRunAt) : data.lastRunAt,
    });
}

function resolveWorkflowRuntime(workflow: CreativeWorkflow, baseConfig: AiConfig) {
    const workflowModel = workflow.config.imageModel || workflow.config.model;
    const fallbackModel = baseConfig.imageModel || baseConfig.model;
    const fallbackChannelId = resolveWorkflowImageChannelId(baseConfig, fallbackModel, baseConfig.imageChannelId, baseConfig.activeChannelId);
    if (!workflowModel) return { model: fallbackModel, apiMode: baseConfig.apiMode, channelId: fallbackChannelId };
    if (baseConfig.channelMode === "remote" && workflowModel !== fallbackModel && (!baseConfig.models.length || !baseConfig.models.includes(workflowModel))) {
        return { model: fallbackModel, apiMode: baseConfig.apiMode, channelId: fallbackChannelId };
    }
    return { model: workflowModel, apiMode: workflow.config.apiMode || baseConfig.apiMode, channelId: resolveWorkflowImageChannelId(baseConfig, workflowModel, workflow.config.imageChannelId, baseConfig.imageChannelId, baseConfig.activeChannelId) };
}

function resolveWorkflowImageChannelId(config: AiConfig, model: string, ...preferredIds: Array<string | undefined>) {
    const channels = config.channelMode === "remote"
        ? config.publicChannels.map((channel) => ({ id: channel.id || "", models: channel.models || [] }))
        : normalizeLocalChannels(config).map((channel) => ({ id: channel.id, models: channel.models }));
    for (const id of preferredIds) {
        const channelId = (id || "").trim();
        if (channelId && channels.some((channel) => channel.id === channelId && channel.models.includes(model))) return channelId;
    }
    return channels.find((channel) => channel.models.includes(model))?.id || "";
}

function buildRunConfig(baseConfig: AiConfig, workflowConfig: WorkflowGenerationConfig, runtime: { model: string; apiMode: AiConfig["apiMode"]; channelId: string }): AiConfig {
    return {
        ...baseConfig,
        ...workflowConfig,
        model: runtime.model,
        imageModel: runtime.model,
        imageChannelId: runtime.channelId,
        activeChannelId: runtime.channelId,
        apiMode: runtime.apiMode,
        systemPrompt: workflowConfig.systemPrompt || baseConfig.systemPrompts.workflow || baseConfig.systemPrompt,
        count: workflowConfig.count || "1",
    };
}

function buildImageHistoryLog({
    id,
    workflow,
    prompt,
    config,
    model,
    images,
    durationMs,
    inputs,
    references,
    categoryIds,
    seriesTitle,
    seriesIndex,
    status = "成功",
    task,
    lastPolledAt,
}: {
    id?: string;
    workflow: CreativeWorkflow;
    prompt: string;
    config: ImageHistoryLog["config"];
    model: string;
    images: ImageHistoryLog["images"];
    durationMs: number;
    inputs: Record<string, unknown>;
    references: ReferenceImage[];
    categoryIds: string[];
    seriesTitle?: string;
    seriesIndex?: number;
    status?: ImageHistoryLog["status"];
    task?: CanvasImageTask;
    lastPolledAt?: number;
}): ImageHistoryLog {
    return {
        id: id || nanoid(),
        createdAt: Date.now(),
        title: seriesTitle ? `${workflow.name} · ${seriesTitle}` : workflow.name,
        prompt,
        time: new Date().toLocaleString("zh-CN", { hour12: false }),
        model,
        config,
        references,
        durationMs,
        successCount: status === "成功" ? images.length : 0,
        failCount: status === "失败" ? 1 : 0,
        imageCount: status === "生成中" ? 0 : images.length,
        size: config.size,
        quality: config.quality,
        status,
        images,
        thumbnails: images.map((image) => image.dataUrl),
        errors: [],
        categoryIds,
        workflowId: workflow.id,
        workflowName: workflow.name,
        workflowInputs: { ...inputs, ...(seriesTitle ? { seriesTitle, seriesIndex } : {}) },
        task,
        lastPolledAt,
    };
}

async function ensureWorkflowCategory(name: string, scope: AccountScope = getAccountScope()) {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const store = categoryStore(scope);
    const categories = (await store.getItem<GenerationCategory[]>(CATEGORY_STORE_KEY)) || [];
    const existing = categories.find((item) => item.name === trimmed);
    if (existing) return existing;
    const nextCategory = { id: nanoid(), name: trimmed, createdAt: Date.now() };
    await store.setItem(CATEGORY_STORE_KEY, [...categories, nextCategory]);
    return nextCategory;
}

function serializeHistoryLog(log: ImageHistoryLog): ImageHistoryLog {
    return {
        ...log,
        images: log.images.map((image) => ({ ...image, dataUrl: image.dataUrl?.startsWith("http") ? image.dataUrl : "" })),
        thumbnails: log.images.map((image) => (image.dataUrl?.startsWith("http") ? image.dataUrl : "")),
    };
}

function isDisposableReferenceFile(reference: ReferenceImage) {
    const item = reference as ReferenceImage & { temporary?: boolean; source?: string };
    return item.temporary === true || item.source === "upload" || item.source === "clipboard";
}

function referenceUsedByWorkflowTask(reference: ReferenceImage, tasks: WorkflowTask[]) {
    if (!reference.storageKey) return false;
    return tasks.some((task) => task.references.some((item) => item.storageKey === reference.storageKey));
}

function formatDate(value: number) {
    return new Date(value).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}






