import { expect, test } from "bun:test";

import { imageResolutionOptions, nearestImageAspectRatio, resolveImageTarget } from "./image-model-capabilities";

test("WxH 映射到最接近的标准比例", () => {
    expect(nearestImageAspectRatio("2048x1152")).toBe("16:9");
    expect(nearestImageAspectRatio("3840x2160")).toBe("16:9");
    expect(nearestImageAspectRatio("1024x1024")).toBe("1:1");
    expect(nearestImageAspectRatio("16:9")).toBe("16:9");
});

test("比例 × 2k 分辨率得到像素尺寸，只认比例的渠道仍拿到 16:9", () => {
    const target = resolveImageTarget("16:9", "2k", "auto");
    expect(target.ratio).toBe("16:9");
    expect(target.resolution).toBe("2k");
    expect(target.pixelSize).toMatch(/^\d+x\d+$/);
    const [w, h] = target.pixelSize!.split("x").map(Number);
    expect(w / h).toBeCloseTo(16 / 9, 2);
});

test("自定义 WxH 保留像素，比例取最近值", () => {
    const target = resolveImageTarget("2048x1152", "auto", "low");
    expect(target.custom).toBe(true);
    expect(target.pixelSize).toBe("2048x1152");
    expect(target.ratio).toBe("16:9");
});

test("Gemini 2.5 不提供分辨率选项，Grok/Seedream 5 只有 1k/2k", () => {
    expect(imageResolutionOptions("gemini-2.5-flash-image", "gemini")).toEqual([]);
    expect(imageResolutionOptions("grok-imagine-image", "grok2api")).toEqual(["1k", "2k"]);
    expect(imageResolutionOptions("M-Seedream 5.0 Pro", "openai")).toEqual(["1k", "2k"]);
    expect(imageResolutionOptions("gpt-image-2", "")).toEqual(["1k", "2k", "4k"]);
});
