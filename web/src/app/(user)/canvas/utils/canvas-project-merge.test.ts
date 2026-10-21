import { expect, test } from "bun:test";

import { CanvasNodeType, type CanvasNodeData } from "../types";
import type { CanvasProject } from "../stores/use-canvas-store";
import { mergeProjectOnConflict, sameProjectContent } from "./canvas-project-merge";

function project(overrides: Partial<CanvasProject> = {}): CanvasProject {
    return {
        id: "p1",
        title: "画布",
        createdAt: "2026-09-26T00:00:00.000Z",
        updatedAt: "2026-09-26T00:00:00.000Z",
        nodes: [],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        agentConfig: null,
        autoTitlePending: false,
        backgroundMode: "lines",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        sidePanel: { open: true, width: 280 },
        agentPanel: { open: false, width: 464 },
        ...overrides,
    };
}

function node(id: string, title: string): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title, position: { x: 0, y: 0 }, width: 10, height: 10, metadata: { status: "success" } };
}

const BASE = project({
    updatedAt: "2026-09-26T10:00:00.000Z",
    nodes: [node("a", "原始A"), node("b", "原始B")],
    connections: [{ id: "c1", fromNodeId: "a", toNodeId: "b" }],
});

test("远端新增节点在本地未动时被合并进来（跨窗口生成场景）", () => {
    const local = project({ ...BASE, updatedAt: BASE.updatedAt });
    const remote = project({ ...BASE, nodes: [...BASE.nodes, node("r1", "其他窗口生成")] });
    const merged = mergeProjectOnConflict(BASE, local, remote);
    expect(merged.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "r1"]);
});

test("本地编辑过的节点优先于远端版本", () => {
    const local = project({ nodes: [node("a", "本地改过"), node("b", "原始B")], connections: BASE.connections });
    const remote = project({ nodes: [node("a", "远端也改了"), node("b", "原始B")], connections: BASE.connections });
    const merged = mergeProjectOnConflict(BASE, local, remote);
    expect(merged.nodes.find((n) => n.id === "a")?.title).toBe("本地改过");
});

test("本地未动的节点采用远端修改", () => {
    const local = project({ nodes: BASE.nodes, connections: BASE.connections });
    const remote = project({ nodes: [node("a", "原始A"), node("b", "远端改了B")], connections: BASE.connections });
    const merged = mergeProjectOnConflict(BASE, local, remote);
    expect(merged.nodes.find((n) => n.id === "b")?.title).toBe("远端改了B");
});

test("本地删除且远端未动时删除生效", () => {
    const local = project({ nodes: [node("a", "原始A")], connections: BASE.connections });
    const remote = project({ nodes: BASE.nodes, connections: BASE.connections });
    const merged = mergeProjectOnConflict(BASE, local, remote);
    expect(merged.nodes.map((n) => n.id)).toEqual(["a"]);
});

test("远端改过的节点不会被本地删除误删", () => {
    const local = project({ nodes: [node("a", "原始A")], connections: BASE.connections });
    const remote = project({ nodes: [node("a", "原始A"), node("b", "远端改了B")], connections: BASE.connections });
    const merged = mergeProjectOnConflict(BASE, local, remote);
    expect(merged.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
});

test("本地新增节点保留", () => {
    const local = project({ nodes: [...BASE.nodes, node("l1", "本地新增")], connections: BASE.connections });
    const remote = project({ nodes: BASE.nodes, connections: BASE.connections });
    const merged = mergeProjectOnConflict(BASE, local, remote);
    expect(merged.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "l1"]);
});

test("连接按同样规则合并（双方各自新增都保留）", () => {
    const local = project({
        connections: [{ id: "c1", fromNodeId: "a", toNodeId: "b" }, { id: "c2", fromNodeId: "b", toNodeId: "a" }],
    });
    const remote = project({
        connections: [{ id: "c1", fromNodeId: "a", toNodeId: "b" }, { id: "c3", fromNodeId: "a", toNodeId: "a" }],
    });
    const merged = mergeProjectOnConflict(BASE, local, remote);
    expect(merged.connections.map((c) => c.id).sort()).toEqual(["c1", "c2", "c3"]);
});

test("本地改过的标量字段赢，未改的采用远端；视口保持本地", () => {
    const local = project({
        title: "本地重命名",
        backgroundMode: BASE.backgroundMode,
        viewport: { x: 100, y: 200, k: 1.5 },
    });
    const remote = project({
        title: "远端标题",
        backgroundMode: "dots" as CanvasProject["backgroundMode"],
        viewport: { x: -999, y: -999, k: 0.2 },
    });
    const merged = mergeProjectOnConflict(BASE, local, remote);
    expect(merged.title).toBe("本地重命名");
    expect(merged.backgroundMode).toBe("dots");
    expect(merged.viewport).toEqual({ x: 100, y: 200, k: 1.5 });
    expect(merged.updatedAt >= BASE.updatedAt).toBe(true);
});

test("节点字段级合并：本地只改进度、远端只改位置时两边都保留", () => {
    const baseNode: CanvasNodeData = { ...node("a", "素材图"), position: { x: 0, y: 0 }, metadata: { status: "loading", progress: 10 } };
    const localNode: CanvasNodeData = { ...baseNode, metadata: { status: "loading", progress: 55 } };
    const remoteNode: CanvasNodeData = { ...baseNode, position: { x: 500, y: 300 } };
    const base = project({ ...BASE, nodes: [baseNode, node("b", "原始B")] });
    const local = project({ nodes: [localNode, node("b", "原始B")], connections: BASE.connections });
    const remote = project({ nodes: [remoteNode, node("b", "原始B")], connections: BASE.connections });
    const merged = mergeProjectOnConflict(base, local, remote);
    const mergedNode = merged.nodes.find((n) => n.id === "a");
    expect(mergedNode?.position).toEqual({ x: 500, y: 300 });
    expect(mergedNode?.metadata?.progress).toBe(55);
});

test("metadata 内部按字段合并：本地改进度、远端改分组归属时两边都保留", () => {
    const baseNode: CanvasNodeData = { ...node("a", "素材图"), metadata: { status: "loading", progress: 10 } };
    const localNode: CanvasNodeData = { ...baseNode, metadata: { ...baseNode.metadata!, progress: 80 } };
    const remoteNode: CanvasNodeData = { ...baseNode, metadata: { ...baseNode.metadata!, groupId: "group-1", prompt: "远端改的提示词" } };
    const base = project({ ...BASE, nodes: [baseNode, node("b", "原始B")] });
    const local = project({ nodes: [localNode, node("b", "原始B")], connections: BASE.connections });
    const remote = project({ nodes: [remoteNode, node("b", "原始B")], connections: BASE.connections });
    const merged = mergeProjectOnConflict(base, local, remote);
    const mergedMetadata = merged.nodes.find((n) => n.id === "a")?.metadata;
    expect(mergedMetadata?.progress).toBe(80);
    expect(mergedMetadata?.groupId).toBe("group-1");
    expect(mergedMetadata?.prompt).toBe("远端改的提示词");
});

test("position 整体取一边：本地和远端都拖过时不拼混合坐标", () => {
    const baseNode: CanvasNodeData = { ...node("a", "素材图"), position: { x: 0, y: 0 } };
    const localNode: CanvasNodeData = { ...baseNode, position: { x: 100, y: 100 } };
    const remoteNode: CanvasNodeData = { ...baseNode, position: { x: 500, y: 300 } };
    const base = project({ ...BASE, nodes: [baseNode, node("b", "原始B")] });
    const local = project({ nodes: [localNode, node("b", "原始B")], connections: BASE.connections });
    const remote = project({ nodes: [remoteNode, node("b", "原始B")], connections: BASE.connections });
    const merged = mergeProjectOnConflict(base, local, remote);
    expect(merged.nodes.find((n) => n.id === "a")?.position).toEqual({ x: 100, y: 100 });
});

test("对账结果与本地内容一致时判为相同（忽略 updatedAt 与视口），不应回填触发重存", () => {
    const local = project({ ...BASE, updatedAt: "2026-09-26T11:00:00.000Z", viewport: { x: 5, y: 5, k: 2 } });
    const remote = project({ ...BASE, updatedAt: "2026-09-26T12:00:00.000Z" });
    const merged = mergeProjectOnConflict(BASE, local, remote);
    expect(sameProjectContent(merged, local)).toBe(true);
    expect(sameProjectContent(merged, project({ ...BASE, nodes: [node("a", "改过")] }))).toBe(false);
});
