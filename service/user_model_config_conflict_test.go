package service

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/fzheng466/infinite-canvas/model"
)

func modelConfigWithChannel(id string, apiKey string, models []string) json.RawMessage {
	modelsJSON := "[]"
	if len(models) > 0 {
		b, _ := json.Marshal(models)
		modelsJSON = string(b)
	}
	return json.RawMessage(`{"channelMode":"local","localChannels":[{"id":"` + id + `","protocol":"openai","name":"测试渠道","baseUrl":"https://api.example.com/v1","apiKey":"` + apiKey + `","models":` + modelsJSON + `}]}`)
}

// 空占位渠道：与前端"本地直连"默认模板一致（空 Key、空模型），不算有内容。
var modelConfigPlaceholder = json.RawMessage(`{"channelMode":"local","localChannels":[{"id":"local-default","protocol":"openai","name":"本地直连","baseUrl":"https://api.openai.com","apiKey":"","models":[]}],"imageModel":"gpt-image-2"}`)

func TestSaveCurrentUserModelConfigConflict(t *testing.T) {
	user := model.PublicUser(model.User{ID: "model-config-conflict-user", Role: model.UserRoleUser, Status: model.UserStatusActive})
	ctx := WithUser(context.Background(), user)

	// 首次保存真实渠道：不带基准（服务器无旧版本），允许。
	first, err := SaveCurrentUserModelConfig(ctx, modelConfigWithChannel("c1", "sk-real", []string{"m1"}), "", false)
	if err != nil {
		t.Fatalf("initial save: %v", err)
	}
	if first.ModelConfigUpdatedAt == "" {
		t.Fatal("payload must carry modelConfigUpdatedAt")
	}

	// 最新基准 + 渠道清空：视为本人主动删除，允许。
	fresh, err := SaveCurrentUserModelConfig(ctx, modelConfigPlaceholder, first.ModelConfigUpdatedAt, false)
	if err != nil {
		t.Fatalf("up-to-date wipe must pass: %v", err)
	}

	// 渠道清空后再次保存真实渠道（无冲突状态）。
	if _, err := SaveCurrentUserModelConfig(ctx, modelConfigWithChannel("c2", "sk-real-2", []string{"m2"}), fresh.ModelConfigUpdatedAt, false); err != nil {
		t.Fatalf("re-save real channel: %v", err)
	}

	// 过期基准 + 渠道清空：必须冲突，并带回服务器当前配置。
	_, err = SaveCurrentUserModelConfig(ctx, modelConfigPlaceholder, "2000-01-01T00:00:00Z", false)
	if err == nil {
		t.Fatal("stale wipe must conflict")
	}
	var conflict *ModelConfigSaveConflict
	if !errors.As(err, &conflict) {
		t.Fatalf("expected ModelConfigSaveConflict, got %T %v", err, err)
	}
	if !localChannelsHaveRealChannel(string(conflict.Stored)) {
		t.Fatalf("stored payload must keep the real channel: %s", string(conflict.Stored))
	}
	if conflict.StoredUpdatedAt == "" {
		t.Fatal("conflict must carry storedUpdatedAt")
	}

	// 仅改其他字段（渠道仍有内容）即使基准过期也放行：last-write-wins 保持不变。
	keepChannels := modelConfigWithChannel("c2", "sk-rotated", []string{"m2"})
	if _, err := SaveCurrentUserModelConfig(ctx, keepChannels, "2000-01-01T00:00:00Z", false); err != nil {
		t.Fatalf("stale save with real channels must pass: %v", err)
	}

	// 过期基准 + 渠道清空 + force：用户在弹窗里明确选择强制覆盖后放行。
	if _, err := SaveCurrentUserModelConfig(ctx, modelConfigPlaceholder, "2000-01-01T00:00:00Z", true); err != nil {
		t.Fatalf("forced wipe must pass: %v", err)
	}
	if _, err := SaveCurrentUserModelConfig(ctx, modelConfigWithChannel("c2", "sk-real-2", []string{"m2"}), "", false); err != nil {
		t.Fatalf("restore after force: %v", err)
	}
}
