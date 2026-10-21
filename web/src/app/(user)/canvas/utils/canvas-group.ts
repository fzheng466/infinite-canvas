import { CanvasNodeType, type CanvasNodeData } from "../types";

export const GROUP_PADDING = 24;
// 分组标题栏高度：只有标题栏能拖动整组，组体空白处放行给画布框选（ComfyUI 同款语义）。
export const GROUP_TITLE_HEIGHT = 32;

// 取自 litegraph LGraphCanvas.node_colors.*.groupcolor（短 hex 展开为 6 位）；第一个 pale_blue 是 ComfyUI 默认分组色，
// 老数据没有 groupColor 时也按它渲染。
export const GROUP_COLORS = ["#3f789e", "#88aaaa", "#88aa88", "#b58b2a", "#b06634", "#aa8888", "#a1309b", "#8888aa"] as const;
export const DEFAULT_GROUP_COLOR = GROUP_COLORS[0];

export type GroupRect = { x: number; y: number; width: number; height: number };

export function resolveGroupColor(node: CanvasNodeData) {
    const color = node.metadata?.groupColor;
    return color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : DEFAULT_GROUP_COLOR;
}

// 新建分组按画布里已有分组数量轮换取色，相邻创建的分组颜色不同。
export function nextGroupColor(nodes: CanvasNodeData[]) {
    const groupCount = nodes.filter((node) => node.type === CanvasNodeType.Group).length;
    return GROUP_COLORS[groupCount % GROUP_COLORS.length];
}

// 拖拽起止点 → 规范化矩形（向左上拖时宽高仍为正）。
export function normalizeGroupRect(startX: number, startY: number, endX: number, endY: number): GroupRect {
    return { x: Math.min(startX, endX), y: Math.min(startY, endY), width: Math.abs(endX - startX), height: Math.abs(endY - startY) };
}

function isCenterInside(node: CanvasNodeData, rect: GroupRect) {
    const centerX = node.position.x + node.width / 2;
    const centerY = node.position.y + node.height / 2;
    return centerX >= rect.x && centerX <= rect.x + rect.width && centerY >= rect.y && centerY <= rect.y + rect.height;
}

// groupId 指向已不存在的分组（旧数据残留）时视为未分组。
function hasLiveGroup(node: CanvasNodeData, groupIds: Set<string>) {
    const groupId = node.metadata?.groupId;
    return Boolean(groupId && groupIds.has(groupId));
}

function collectGroupIds(nodes: CanvasNodeData[]) {
    return new Set(nodes.filter((node) => node.type === CanvasNodeType.Group).map((node) => node.id));
}

export function collectRectGroupMembers(rect: GroupRect, nodes: CanvasNodeData[], isHidden: (node: CanvasNodeData) => boolean) {
    const groupIds = collectGroupIds(nodes);
    return nodes.filter((node) => node.type !== CanvasNodeType.Group && !isHidden(node) && !hasLiveGroup(node, groupIds) && isCenterInside(node, rect)).map((node) => node.id);
}

// 框选矩形直接作为分组框几何；中心落在矩形内、未分组且可见的普通节点收编为成员。
// 没有可收编节点时返回 null（不允许空分组）。
export function createGroupFromRect(rect: GroupRect, nodes: CanvasNodeData[], isHidden: (node: CanvasNodeData) => boolean, options: { id: string; title?: string; color?: string }) {
    const memberIds = new Set(collectRectGroupMembers(rect, nodes, isHidden));
    if (!memberIds.size) return null;

    const group: CanvasNodeData = {
        id: options.id,
        type: CanvasNodeType.Group,
        title: options.title || "组",
        position: { x: rect.x, y: rect.y },
        width: rect.width,
        height: rect.height,
        metadata: { groupColor: options.color || nextGroupColor(nodes) },
    };
    return {
        group,
        memberIds: Array.from(memberIds),
        nodes: [...nodes.map((node) => (memberIds.has(node.id) ? { ...node, metadata: { ...node.metadata, groupId: group.id } } : node)), group],
    };
}

// 分组 resize 结束后重算成员：中心在框内且未分组/本组的加入，本组但中心出框的退出；
// 属于其他（仍存在的）分组的节点不抢。收起隐藏的批次子图不单独判定，跟随其批次根退出。
// 没有变化时返回原数组，避免无意义的重渲染和保存。
export function recomputeGroupMembers(groupId: string, nodes: CanvasNodeData[], isHidden: (node: CanvasNodeData) => boolean) {
    const group = nodes.find((node) => node.id === groupId && node.type === CanvasNodeType.Group);
    if (!group) return nodes;
    const rect: GroupRect = { x: group.position.x, y: group.position.y, width: group.width, height: group.height };
    const groupIds = collectGroupIds(nodes);

    let changed = false;
    const visiblePass = nodes.map((node) => {
        if (node.type === CanvasNodeType.Group || isHidden(node)) return node;
        const currentGroupId = node.metadata?.groupId;
        const inside = isCenterInside(node, rect);
        if (inside && currentGroupId !== groupId && !hasLiveGroup(node, groupIds)) {
            changed = true;
            return { ...node, metadata: { ...node.metadata, groupId } };
        }
        if (!inside && currentGroupId === groupId) {
            changed = true;
            return { ...node, metadata: { ...node.metadata, groupId: undefined } };
        }
        return node;
    });

    const groupIdById = new Map(visiblePass.map((node) => [node.id, node.metadata?.groupId]));
    const next = visiblePass.map((node) => {
        if (node.type === CanvasNodeType.Group || !isHidden(node) || node.metadata?.groupId !== groupId) return node;
        const rootId = node.metadata?.batchRootId;
        if (rootId && groupIdById.get(rootId) === groupId) return node;
        changed = true;
        return { ...node, metadata: { ...node.metadata, groupId: undefined } };
    });
    return changed ? next : nodes;
}

// 收紧到内容：按成员外接框 + 边距 + 标题栏重设分组几何（参考 ComfyUI LGraphGroup.resizeTo）。
export function fitGroupToMembers(groupId: string, nodes: CanvasNodeData[], isHidden: (node: CanvasNodeData) => boolean) {
    const members = nodes.filter((node) => node.metadata?.groupId === groupId && node.type !== CanvasNodeType.Group && !isHidden(node));
    if (!members.length) return nodes;
    const bounds = getNodeBounds(members);
    const position = { x: bounds.left - GROUP_PADDING, y: bounds.top - GROUP_PADDING - GROUP_TITLE_HEIGHT };
    const width = bounds.right - bounds.left + GROUP_PADDING * 2;
    const height = bounds.bottom - bounds.top + GROUP_PADDING * 2 + GROUP_TITLE_HEIGHT;
    return nodes.map((node) => (node.id === groupId && node.type === CanvasNodeType.Group ? { ...node, position, width, height } : node));
}

export function getNodeBounds(nodes: CanvasNodeData[]) {
    return nodes.reduce(
        (bounds, node) => ({
            left: Math.min(bounds.left, node.position.x),
            top: Math.min(bounds.top, node.position.y),
            right: Math.max(bounds.right, node.position.x + node.width),
            bottom: Math.max(bounds.bottom, node.position.y + node.height),
        }),
        { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
    );
}

export function findGroupDropTarget(movedIds: Set<string>, nodes: CanvasNodeData[]) {
    if (nodes.some((node) => movedIds.has(node.id) && node.type === CanvasNodeType.Group)) return null;

    const movingNodes = nodes.filter((node) => movedIds.has(node.id) && node.type !== CanvasNodeType.Group);
    return [...nodes].reverse().find((group) => {
        if (group.type !== CanvasNodeType.Group || movedIds.has(group.id)) return false;
        return movingNodes.some((node) => {
            const centerX = node.position.x + node.width / 2;
            const centerY = node.position.y + node.height / 2;
            return centerX >= group.position.x && centerX <= group.position.x + group.width && centerY >= group.position.y && centerY <= group.position.y + group.height;
        });
    }) || null;
}

export function snapNodesIntoGroup(movedIds: Set<string>, nodes: CanvasNodeData[], group: CanvasNodeData) {
    const movingNodes = nodes.filter((node) => movedIds.has(node.id) && node.type !== CanvasNodeType.Group);
    if (!movingNodes.length) return nodes;

    const bounds = getNodeBounds(movingNodes);
    const left = group.position.x + GROUP_PADDING;
    // 顶部让出标题栏：标题栏是整组的拖动把手，吸入的图片不能压住它。
    const top = group.position.y + GROUP_TITLE_HEIGHT + GROUP_PADDING;
    const right = group.position.x + group.width - GROUP_PADDING;
    const bottom = group.position.y + group.height - GROUP_PADDING;
    const dx = bounds.left < left ? left - bounds.left : bounds.right > right ? right - bounds.right : 0;
    const dy = bounds.top < top ? top - bounds.top : bounds.bottom > bottom ? bottom - bounds.bottom : 0;

    return nodes.map((node) => {
        if (!movedIds.has(node.id) || node.type === CanvasNodeType.Group) return node;
        return {
            ...node,
            position: { x: node.position.x + dx, y: node.position.y + dy },
            metadata: { ...node.metadata, groupId: group.id },
        };
    });
}

export function findContainingGroupId(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    const centerX = node.position.x + node.width / 2;
    const centerY = node.position.y + node.height / 2;
    return [...nodes].reverse().find((group) => group.type === CanvasNodeType.Group && centerX >= group.position.x && centerX <= group.position.x + group.width && centerY >= group.position.y && centerY <= group.position.y + group.height)?.id;
}
