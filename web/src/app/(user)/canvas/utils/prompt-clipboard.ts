export const PROMPT_CLIPBOARD_TYPE = "application/x-infinite-canvas-prompt";

export type PromptClipboardRef = { label: string; nodeId: string };

export type PromptClipboardPayload = {
    text: string;
    refs: PromptClipboardRef[];
};

// 复制提示词时把引用标签连同其节点 ID 一起写入自定义剪贴板类型；
// 粘贴端优先按节点 ID 还原引用，避免"图片1"这类按位置编号在目标节点里错配成别的资源。
export function writePromptClipboard(data: DataTransfer, payload: PromptClipboardPayload) {
    data.setData("text/plain", payload.text);
    data.setData(PROMPT_CLIPBOARD_TYPE, JSON.stringify(payload));
}

export function readPromptClipboard(data: DataTransfer): PromptClipboardPayload | null {
    const raw = data.getData(PROMPT_CLIPBOARD_TYPE);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<PromptClipboardPayload>;
        if (typeof parsed.text !== "string" || !Array.isArray(parsed.refs)) return null;
        return {
            text: parsed.text,
            refs: parsed.refs.filter((ref): ref is PromptClipboardRef => typeof ref?.label === "string" && typeof ref?.nodeId === "string"),
        };
    } catch {
        return null;
    }
}
