export const IMAGE_ASPECT_RATIOS = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"] as const;
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];
export type ImageResolution = "auto" | "1k" | "2k" | "4k";

const ASPECT_VALUES: Array<[ImageAspectRatio, number]> = [
    ["1:1", 1],
    ["3:2", 1.5],
    ["2:3", 2 / 3],
    ["4:3", 4 / 3],
    ["3:4", 3 / 4],
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
    ["21:9", 21 / 9],
];

const LEGACY_PIXEL_TO_RATIO: Record<string, ImageAspectRatio> = {
    "1024x1024": "1:1",
    "2048x2048": "1:1",
    "1536x1024": "3:2",
    "1024x1536": "2:3",
    "1024x768": "4:3",
    "768x1024": "3:4",
    "1920x1080": "16:9",
    "2048x1152": "16:9",
    "3840x2160": "16:9",
    "1080x1920": "9:16",
    "1152x2048": "9:16",
    "2160x3840": "9:16",
    "1568x672": "21:9",
    "3136x1344": "21:9",
    "6272x2688": "21:9",
};

const LEGACY_PIXEL_TO_RESOLUTION: Record<string, Exclude<ImageResolution, "auto">> = {
    "2048x2048": "2k",
    "2048x1152": "2k",
    "1152x2048": "2k",
    "3136x1344": "2k",
    "3840x2160": "4k",
    "2160x3840": "4k",
    "6272x2688": "4k",
};

export const RESOLUTION_BASE: Record<Exclude<ImageResolution, "auto">, number> = {
    "1k": 1024,
    "2k": 2048,
    "4k": 2880,
};

export function isImageAspectRatio(value: string): value is ImageAspectRatio {
    return (IMAGE_ASPECT_RATIOS as readonly string[]).includes(value);
}

export function isPixelSize(value: string) {
    return /^\d+x\d+$/.test(value.trim());
}

export function nearestImageAspectRatio(size: string): ImageAspectRatio {
    const normalized = size.trim().toLowerCase();
    if (isImageAspectRatio(normalized)) return normalized;
    const known = LEGACY_PIXEL_TO_RATIO[normalized];
    if (known) return known;
    const match = normalized.match(/^(\d+)x(\d+)$/);
    if (!match) return "1:1";
    const ratio = Number(match[1]) / Math.max(1, Number(match[2]));
    return ASPECT_VALUES.reduce((best, current) => (Math.abs(current[1] - ratio) < Math.abs(best[1] - ratio) ? current : best))[0];
}

export function inferImageResolution(size: string): ImageResolution | "" {
    const normalized = size.trim().toLowerCase();
    return LEGACY_PIXEL_TO_RESOLUTION[normalized] || "";
}

export function imageResolutionOptions(model: string, protocol = ""): Exclude<ImageResolution, "auto">[] {
    const key = model.trim().toLowerCase().replace(/[._/]+/g, "-");
    if (protocol === "gemini" || key.startsWith("gemini") || key.startsWith("imagen") || key.includes("nano-banana") || key.includes("gemini-")) {
        if (key.includes("2-5") || key.includes("2.5")) return [];
        return ["1k", "2k", "4k"];
    }
    if (protocol === "grok2api" || key.startsWith("grok-imagine-image")) return ["1k", "2k"];
    // Seedream 5.x 上游只支持 1K / 1.5K / 2K，选 4K 会被明确拒绝。
    if (key.includes("seedream") && (key.includes("seedream-5") || key.includes("seedream 5") || key.includes("seedream5"))) return ["1k", "2k"];
    return ["1k", "2k", "4k"];
}

function greatestCommonDivisor(a: number, b: number) {
    a = Math.round(a);
    b = Math.round(b);
    while (b) {
        const remainder = a % b;
        a = b;
        b = remainder;
    }
    return a || 1;
}

export function pixelSizeFromRatio(ratio: string, basePixels: number) {
    const parts = ratio.split(":");
    if (parts.length !== 2) return undefined;
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!w || !h || !basePixels) return undefined;
    const a = greatestCommonDivisor(w, h);
    const unit = Math.round(Math.sqrt((basePixels * basePixels) / ((w / a) * (h / a))) / 16) * 16;
    return `${(w / a) * unit}x${(h / a) * unit}`;
}

const QUALITY_BASE: Record<string, number> = { low: 1024, medium: 2048, high: 2880, standard: 1024, hd: 2048 };
const QUALITY_TO_RESOLUTION: Record<string, Exclude<ImageResolution, "auto">> = { low: "1k", standard: "1k", medium: "2k", hd: "2k", high: "4k", "1k": "1k", "2k": "2k", "4k": "4k" };

export function resolveImageTarget(size: string, resolution: string, quality: string) {
    const value = (size || "auto").trim();
    const custom = isPixelSize(value);
    const ratio = value === "auto" ? "auto" : nearestImageAspectRatio(value);
    const explicitResolution = resolution.trim().toLowerCase();
    let resolved: ImageResolution = "auto";
    if (explicitResolution === "1k" || explicitResolution === "2k" || explicitResolution === "4k") resolved = explicitResolution;
    else {
        const fromQuality = QUALITY_TO_RESOLUTION[quality.trim().toLowerCase()];
        const fromLegacy = inferImageResolution(value);
        resolved = fromQuality || fromLegacy || "auto";
    }
    const base = resolved === "1k" || resolved === "2k" || resolved === "4k" ? RESOLUTION_BASE[resolved] : QUALITY_BASE[quality.trim().toLowerCase()] || 1024;
    const pixelSize = custom ? value : ratio === "auto" ? undefined : pixelSizeFromRatio(ratio, base);
    return { ratio, resolution: resolved, pixelSize, custom };
}
