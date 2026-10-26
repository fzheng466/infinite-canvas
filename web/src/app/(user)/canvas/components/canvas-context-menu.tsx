"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import { BetweenHorizontalStart, GalleryHorizontal, GalleryHorizontalEnd, Lock, LockOpen, Pencil, Plus, Shrink, Trash2, Ungroup } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ContextMenuState } from "../types";
import { GROUP_COLORS } from "../utils/canvas-group";
import type { VideoFramePosition } from "../utils/canvas-video-frame";

// 右键分组时的专属菜单项；不传则显示普通节点菜单。
export type CanvasGroupMenuActions = {
    color: string;
    pinned: boolean;
    onRename: () => void;
    onColorChange: (color: string) => void;
    onTogglePinned: () => void;
    onFitToContents: () => void;
    onDissolve: () => void;
    onDeleteWithContents: () => void;
};

export function CanvasNodeContextMenu({ menu, canCaptureVideoFrame, group, onClose, onCaptureVideoFrame, onDuplicate, onDelete }: { menu: ContextMenuState; canCaptureVideoFrame: boolean; group?: CanvasGroupMenuActions; onClose: () => void; onCaptureVideoFrame: (position: VideoFramePosition) => void; onDuplicate: () => void; onDelete: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    useEffect(() => {
        const close = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest(".ant-popover")) return;
            onClose();
        };
        window.addEventListener("pointerdown", close);
        return () => window.removeEventListener("pointerdown", close);
    }, [onClose]);

    return (
        <div
            className="fixed z-[80] min-w-44 overflow-hidden rounded-xl border py-1 shadow-2xl"
            style={{ left: menu.x, top: menu.y, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {canCaptureVideoFrame ? (
                <>
                    <MenuButton icon={<BetweenHorizontalStart className="size-4" />} label="截取首帧" onClick={() => onCaptureVideoFrame("first")} />
                    <MenuButton icon={<GalleryHorizontalEnd className="size-4" />} label="截取尾帧" onClick={() => onCaptureVideoFrame("last")} />
                    <MenuButton icon={<GalleryHorizontal className="size-4" />} label="截取当前帧" onClick={() => onCaptureVideoFrame("current")} />
                    <div className="my-1 border-t" style={{ borderColor: theme.toolbar.border }} />
                </>
            ) : null}
            {group ? (
                <>
                    <MenuButton icon={<Pencil className="size-4" />} label="重命名" onClick={group.onRename} />
                    <div className="flex items-center gap-1.5 px-3 py-2">
                        {GROUP_COLORS.map((color) => (
                            <button
                                key={color}
                                type="button"
                                aria-label={`分组颜色 ${color}`}
                                className="size-4 rounded-full transition hover:scale-110"
                                style={{ background: color, boxShadow: color === group.color.toLowerCase() ? `0 0 0 2px ${theme.toolbar.panel}, 0 0 0 3.5px ${color}` : undefined }}
                                onClick={() => group.onColorChange(color)}
                            />
                        ))}
                    </div>
                    <MenuButton icon={group.pinned ? <LockOpen className="size-4" /> : <Lock className="size-4" />} label={group.pinned ? "解除锁定" : "锁定分组"} onClick={group.onTogglePinned} />
                    <MenuButton icon={<Shrink className="size-4" />} label="收紧到内容" onClick={group.onFitToContents} />
                    <div className="my-1 border-t" style={{ borderColor: theme.toolbar.border }} />
                    <MenuButton icon={<Ungroup className="size-4" />} label="解散分组（保留图片）" onClick={group.onDissolve} />
                    <MenuButton icon={<Trash2 className="size-4" />} label="删除分组及内容" onClick={group.onDeleteWithContents} danger />
                </>
            ) : (
                <>
                    {menu.type === "node" ? <MenuButton icon={<Plus className="size-4" />} label="Duplicate" onClick={onDuplicate} /> : null}
                    <MenuButton icon={<Trash2 className="size-4" />} label="Delete" onClick={onDelete} danger />
                </>
            )}
        </div>
    );
}

function MenuButton({ icon, label, onClick, danger = false }: { icon: ReactNode; label: string; onClick?: () => void; danger?: boolean }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:opacity-80" style={{ color: danger ? "#f87171" : theme.node.text }} onClick={onClick}>
            {icon}
            <span>{label}</span>
        </button>
    );
}
