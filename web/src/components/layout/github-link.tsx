"use client";

import type { CSSProperties } from "react";

type GitHubLinkProps = {
    className?: string;
    style?: CSSProperties;
};

// 产品部署版隐藏 GitHub 仓库入口,保留组件占位避免多处引用改动。
export function GitHubLink(_props: GitHubLinkProps) {
    return null;
}