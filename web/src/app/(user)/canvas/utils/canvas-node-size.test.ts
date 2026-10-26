import { expect, test } from "bun:test";

import { resolveResultNodeGeometry } from "./canvas-node-size";

const fitted = { width: 640, height: 360 };

test("未手动调整尺寸时按结果尺寸适配，并以当前中心居中", () => {
    const geometry = resolveResultNodeGeometry({ position: { x: 100, y: 100 }, width: 400, height: 400, metadata: {} }, fitted);
    expect(geometry).toEqual({ width: 640, height: 360, position: { x: -20, y: 120 } });
});

test("生成期间拖动过位置但未改尺寸：以新位置为中心，不跳回旧位置", () => {
    const geometry = resolveResultNodeGeometry({ position: { x: 900, y: -50 }, width: 400, height: 400 }, fitted);
    expect(geometry.position).toEqual({ x: 780, y: -30 });
});

test("用户手动调过尺寸时首次落地保留宽高和位置", () => {
    const node = { position: { x: 12, y: 34 }, width: 777, height: 555, metadata: { userResized: true } };
    expect(resolveResultNodeGeometry(node, fitted)).toEqual({ width: 777, height: 555, position: { x: 12, y: 34 } });
});
