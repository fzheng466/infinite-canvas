import { nanoid } from "nanoid";

export type ClientTaskKind = "image" | "video" | "audio";

// 节点 ID 会随项目复制/导入出现在多个账号，任务主键只拼节点 ID 会让不同用户的任务撞同一行，必须带随机后缀。
export function createClientTaskId(kind: ClientTaskKind, nodeId: string) {
    return `client_${kind}_task_${nodeId}_${nanoid(8)}`;
}
