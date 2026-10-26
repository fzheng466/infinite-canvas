import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseChangelog } from "@/lib/release";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

export default function nextConfig(phase: string): NextConfig {
    const isDev = phase === PHASE_DEVELOPMENT_SERVER;
    const releases = parseChangelog(localChangelog);
    // 本机 commit 内存紧张时可用 NEXT_BUILD_CPUS 限制"收集页面数据"阶段的 worker 数，
    // 避免默认 CPU 数量（本机 23 个）同时拉起把虚拟内存提交额度打爆；不设则维持默认。
    const buildCpus = Number(process.env.NEXT_BUILD_CPUS || "");

    return {
        output: "standalone",
        ...(buildCpus > 0 ? { experimental: { cpus: buildCpus } } : {}),
        allowedDevOrigins: isDev ? ["*.*.*.*"] : [],
        typescript: {
            ignoreBuildErrors: true,
        },
        env: {
            NEXT_PUBLIC_APP_VERSION: localVersion,
            NEXT_PUBLIC_APP_RELEASES: JSON.stringify(releases),
        },
    };
}
