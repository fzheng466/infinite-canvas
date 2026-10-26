"use client";

export function fitNodeSize(width: number, height: number, maxWidth = 640, maxHeight = 640) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const scale = Math.min(1, maxWidth / w, maxHeight / h);
    return { width: w * scale, height: h * scale };
}

export function nodeSizeFromRatio(size: string, baseWidth: number, baseHeight: number) {
    const match = size?.match(/^(\d+)(?:x|:)(\d+)/);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    const ratio = width / Math.max(1, height);
    if (ratio < 0.25 || ratio > 4) return { width: baseWidth, height: baseHeight };
    return ratio >= baseWidth / baseHeight ? { width: baseWidth, height: baseWidth / ratio } : { width: baseHeight * ratio, height: baseHeight };
}

type GeometryNode = { position: { x: number; y: number }; width: number; height: number; metadata?: { userResized?: boolean } };

// 生成结果首次落地时的节点几何：用户在生成期间手动调过尺寸（userResized）则原样保留宽高和位置；
// 否则按结果尺寸 fitted 设置宽高，并以节点当前中心重新居中（拖动过位置也以新位置为中心，不会跳回）。
export function resolveResultNodeGeometry(node: GeometryNode, fitted: { width: number; height: number }) {
    if (node.metadata?.userResized) return { width: node.width, height: node.height, position: node.position };
    return {
        width: fitted.width,
        height: fitted.height,
        position: { x: node.position.x + node.width / 2 - fitted.width / 2, y: node.position.y + node.height / 2 - fitted.height / 2 },
    };
}
