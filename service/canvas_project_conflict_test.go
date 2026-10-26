package service

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/fzheng466/infinite-canvas/model"
)

func canvasProjectPayload(id string, updatedAt string, prompt string) json.RawMessage {
	return json.RawMessage(`{"id":"` + id + `","title":"t","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"` + updatedAt + `","nodes":[{"id":"n1","type":"image","title":"` + prompt + `","position":{"x":0,"y":0},"width":10,"height":10,"metadata":{}}],"connections":[],"chatSessions":[],"activeChatId":null,"agentConfig":null,"autoTitlePending":false,"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1},"sidePanel":{"open":true,"width":280},"agentPanel":{"open":false,"width":464}}`)
}

func TestSaveCurrentUserCanvasProjectConflict(t *testing.T) {
	user := model.PublicUser(model.User{ID: "project-conflict-user", Role: model.UserRoleUser, Status: model.UserStatusActive})
	ctx := WithUser(context.Background(), user)
	projectID := "conflict-project-1"

	if _, err := SaveCurrentUserCanvasProject(ctx, canvasProjectPayload(projectID, "2026-09-26T10:00:00.000Z", "first")); err != nil {
		t.Fatalf("initial save: %v", err)
	}
	// 相同时间戳重复保存：幂等允许。
	if _, err := SaveCurrentUserCanvasProject(ctx, canvasProjectPayload(projectID, "2026-09-26T10:00:00.000Z", "first")); err != nil {
		t.Fatalf("idempotent save: %v", err)
	}
	// 更新时间戳：正常覆盖。
	if _, err := SaveCurrentUserCanvasProject(ctx, canvasProjectPayload(projectID, "2026-09-26T10:05:00.000Z", "second")); err != nil {
		t.Fatalf("newer save: %v", err)
	}
	// 旧时间戳：必须冲突并携带服务器当前版本。
	_, err := SaveCurrentUserCanvasProject(ctx, canvasProjectPayload(projectID, "2026-09-26T10:01:00.000Z", "stale"))
	if err == nil {
		t.Fatal("stale save must conflict")
	}
	var conflict *ProjectSaveConflict
	if !errors.As(err, &conflict) {
		t.Fatalf("expected ProjectSaveConflict, got %T %v", err, err)
	}
	var stored map[string]any
	if json.Unmarshal(conflict.Stored, &stored) != nil {
		t.Fatalf("stored payload invalid: %s", string(conflict.Stored))
	}
	if stored["updatedAt"] != "2026-09-26T10:05:00.000Z" {
		t.Fatalf("stored payload is not the server version: %v", stored["updatedAt"])
	}

	// 对账接口：since 之前的返回空；新于 since 的返回项目。
	empty, err := GetCurrentUserCanvasProject(ctx, projectID, "2026-09-26T10:05:00.000Z")
	if err != nil || empty != nil {
		t.Fatalf("check since=latest: %v %v", empty, err)
	}
	fresh, err := GetCurrentUserCanvasProject(ctx, projectID, "2026-09-26T10:00:00.000Z")
	if err != nil || fresh == nil {
		t.Fatalf("check since=older: %v %v", fresh, err)
	}
}
