import { expect, test } from "bun:test";

import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "../types";
import { DEFAULT_GROUP_COLOR, GROUP_COLORS, GROUP_PADDING, GROUP_TITLE_HEIGHT, collectRectGroupMembers, createGroupFromRect, fitGroupToMembers, nextGroupColor, normalizeGroupRect, recomputeGroupMembers, resolveGroupColor } from "./canvas-group";

function node(id: string, x: number, y: number, metadata: CanvasNodeMetadata = {}, size = 100): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title: id, position: { x, y }, width: size, height: size, metadata: { status: "success", ...metadata } };
}

function group(id: string, x: number, y: number, width: number, height: number, metadata: CanvasNodeMetadata = {}): CanvasNodeData {
    return { id, type: CanvasNodeType.Group, title: id, position: { x, y }, width, height, metadata };
}

const notHidden = () => false;
const RECT = { x: 0, y: 0, width: 500, height: 400 };

test("拖拽矩形直接作为分组几何，中心在框内的节点被收编", () => {
    const nodes = [node("a", 20, 20), node("b", 300, 200), node("edge", 440, 100), node("out", 480, 100)];
    const result = createGroupFromRect(RECT, nodes, notHidden, { id: "g1", title: "角色参考", color: "#b06634" });
    expect(result).not.toBeNull();
    expect(result!.group).toMatchObject({ id: "g1", type: CanvasNodeType.Group, title: "角色参考", position: { x: 0, y: 0 }, width: 500, height: 400, metadata: { groupColor: "#b06634" } });
    // edge 的中心 x=490 在框内（即使右侧越出框），out 的中心 x=530 在框外
    expect(result!.memberIds.sort()).toEqual(["a", "b", "edge"]);
    expect(result!.nodes.find((n) => n.id === "out")?.metadata?.groupId).toBeUndefined();
    expect(result!.nodes.at(-1)?.id).toBe("g1");
});

test("已属于其他分组的节点不被抢，指向已删除分组的残留 groupId 视为未分组", () => {
    const nodes = [group("old", 0, 0, 200, 200), node("inOld", 20, 20, { groupId: "old" }), node("stale", 250, 50, { groupId: "deleted" })];
    const result = createGroupFromRect(RECT, nodes, notHidden, { id: "g2" });
    expect(result!.memberIds).toEqual(["stale"]);
    expect(result!.nodes.find((n) => n.id === "inOld")?.metadata?.groupId).toBe("old");
    expect(result!.nodes.find((n) => n.id === "stale")?.metadata?.groupId).toBe("g2");
});

test("隐藏节点与分组节点本身不参与收编；框内无可收编节点时不创建空分组", () => {
    const nodes = [group("other", 10, 10, 100, 100), node("hidden", 50, 50, { batchRootId: "root" })];
    expect(collectRectGroupMembers(RECT, nodes, (n) => n.id === "hidden")).toEqual([]);
    expect(createGroupFromRect(RECT, nodes, (n) => n.id === "hidden", { id: "g3" })).toBeNull();
});

test("未指定颜色时按已有分组数量轮换；老数据无颜色或颜色非法时回落默认浅蓝", () => {
    expect(nextGroupColor([])).toBe(GROUP_COLORS[0]);
    expect(nextGroupColor([group("g", 0, 0, 10, 10)])).toBe(GROUP_COLORS[1]);
    const result = createGroupFromRect(RECT, [group("g", 900, 900, 10, 10), node("a", 0, 0)], notHidden, { id: "g4" });
    expect(result!.group.metadata?.groupColor).toBe(GROUP_COLORS[1]);
    expect(resolveGroupColor(group("legacy", 0, 0, 10, 10))).toBe(DEFAULT_GROUP_COLOR);
    expect(resolveGroupColor(group("bad", 0, 0, 10, 10, { groupColor: "red;background:url(x)" }))).toBe(DEFAULT_GROUP_COLOR);
});

test("向左上拖拽得到的矩形会被规范化", () => {
    expect(normalizeGroupRect(300, 200, 100, 50)).toEqual({ x: 100, y: 50, width: 200, height: 150 });
});

test("resize 放大后中心进入框内的未分组节点加入，缩小后中心出框的本组成员退出", () => {
    const nodes = [group("g", 0, 0, 300, 300), node("member", 20, 20, { groupId: "g" }), node("leaving", 180, 180, { groupId: "g" }), node("joining", 320, 20), node("foreign", 50, 150, { groupId: "other" }), group("other", 40, 140, 120, 120)];
    const resized = nodes.map((n) => (n.id === "g" ? { ...n, width: 450, height: 200 } : n));
    const next = recomputeGroupMembers("g", resized, notHidden);
    const groupOf = (id: string) => next.find((n) => n.id === id)?.metadata?.groupId;
    expect(groupOf("member")).toBe("g");
    expect(groupOf("joining")).toBe("g");
    expect(groupOf("leaving")).toBeUndefined();
    expect(groupOf("foreign")).toBe("other");
});

test("成员没有变化时 recompute 返回原数组（不触发重渲染/保存）", () => {
    const nodes = [group("g", 0, 0, 300, 300), node("member", 20, 20, { groupId: "g" }), node("outside", 900, 900)];
    expect(recomputeGroupMembers("g", nodes, notHidden)).toBe(nodes);
    expect(recomputeGroupMembers("missing", nodes, notHidden)).toBe(nodes);
});

test("收起隐藏的批次子图跟随批次根：根留在组内则保留，根出组则一起退出", () => {
    const isHidden = (n: CanvasNodeData) => Boolean(n.metadata?.batchRootId);
    const base = [group("g", 0, 0, 300, 300), node("root", 20, 20, { groupId: "g", isBatchRoot: true, batchChildIds: ["kid"] }), node("kid", 900, 900, { groupId: "g", batchRootId: "root" })];
    expect(recomputeGroupMembers("g", base, isHidden)).toBe(base);
    const shrunk = base.map((n) => (n.id === "g" ? { ...n, width: 50, height: 50 } : n));
    const next = recomputeGroupMembers("g", shrunk, isHidden);
    expect(next.find((n) => n.id === "root")?.metadata?.groupId).toBeUndefined();
    expect(next.find((n) => n.id === "kid")?.metadata?.groupId).toBeUndefined();
});

test("收紧到内容按成员外接框加边距和标题栏重设分组几何", () => {
    const nodes = [group("g", -500, -500, 2000, 2000), node("a", 100, 100, { groupId: "g" }), node("b", 300, 250, { groupId: "g" })];
    const next = fitGroupToMembers("g", nodes, notHidden);
    expect(next.find((n) => n.id === "g")).toMatchObject({
        position: { x: 100 - GROUP_PADDING, y: 100 - GROUP_PADDING - GROUP_TITLE_HEIGHT },
        width: 300 + GROUP_PADDING * 2,
        height: 250 + GROUP_PADDING * 2 + GROUP_TITLE_HEIGHT,
    });
    const empty = [group("e", 0, 0, 100, 100)];
    expect(fitGroupToMembers("e", empty, notHidden)).toBe(empty);
});
