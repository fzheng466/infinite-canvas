import { describe, expect, test } from "bun:test";

import { createClientTaskId } from "./client-task-id";

describe("createClientTaskId", () => {
    test("keeps the prefix the backend uses to recognise task kinds", () => {
        expect(createClientTaskId("image", "node-1").startsWith("client_image_task_node-1_")).toBe(true);
        expect(createClientTaskId("video", "node-1").startsWith("client_video_task_node-1_")).toBe(true);
        expect(createClientTaskId("audio", "node-1").startsWith("client_audio_task_node-1_")).toBe(true);
    });

    test("never repeats for the same node, so copied nodes in different accounts cannot collide", () => {
        const ids = new Set(Array.from({ length: 200 }, () => createClientTaskId("image", "copied-node")));
        expect(ids.size).toBe(200);
    });
});
