package service

import (
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/fzheng466/infinite-canvas/model"
	"github.com/fzheng466/infinite-canvas/repository"
)

type CanvasAudioTaskCreateInput struct {
	UserID          string
	UserDisplayName string
	SourceID        string
	NodeID          string
	ClientTaskID    string
	Model           string
	ChannelID       string
	UserChannelID   string
	ChannelName     string
	Prompt          string
	Endpoint        string
	ContentType     string
	RequestBody     string
}

// CreateCanvasAudioTask 按 clientTaskID 幂等创建任务；第二个返回值表示是否为本次新建，
// 为 false 时调用方不得再次启动执行。
func CreateCanvasAudioTask(input CanvasAudioTaskCreateInput) (model.CanvasAudioTask, bool, error) {
	userID := strings.TrimSpace(input.UserID)
	clientTaskID := strings.TrimSpace(input.ClientTaskID)
	if clientTaskID != "" {
		if existing, err := repository.GetCanvasAudioTaskByID(clientTaskID); err == nil {
			if existing.UserID != userID {
				return model.CanvasAudioTask{}, false, errors.New("clientTaskID 已被其他用户使用")
			}
			return existing, false, nil
		}
	}
	current := now()
	task := model.CanvasAudioTask{
		ID:              firstVideoTaskValue(clientTaskID, "canvas_audio_task_"+uuid.NewString()),
		UserID:          userID,
		UserDisplayName: strings.TrimSpace(input.UserDisplayName),
		Source:          "canvas",
		SourceID:        strings.TrimSpace(input.SourceID),
		NodeID:          strings.TrimSpace(input.NodeID),
		Model:           strings.TrimSpace(input.Model),
		ChannelID:       strings.TrimSpace(input.ChannelID),
		UserChannelID:   strings.TrimSpace(input.UserChannelID),
		ChannelName:     strings.TrimSpace(input.ChannelName),
		Status:          "queued",
		Progress:        0,
		Prompt:          strings.TrimSpace(input.Prompt),
		Endpoint:        strings.TrimSpace(input.Endpoint),
		ContentType:     strings.TrimSpace(input.ContentType),
		RequestBody:     input.RequestBody,
		CreatedAt:       current,
		UpdatedAt:       current,
	}
	created, inserted, err := repository.SaveCanvasAudioTask(task)
	if err != nil {
		if clientTaskID != "" {
			// 并发重复提交时另一请求可能已建任务：主键冲突后返回已有任务，而不是报错。
			if existing, found, getErr := repository.GetUserCanvasAudioTask(userID, clientTaskID); getErr == nil && found {
				return existing, false, nil
			}
		}
		return model.CanvasAudioTask{}, false, err
	}
	if !inserted && clientTaskID != "" {
		// 并发竞态：另一请求刚刚插入同 clientTaskID，本次实际走的是更新分支——按幂等命中返回已有任务。
		if existing, found, getErr := repository.GetUserCanvasAudioTask(userID, clientTaskID); getErr == nil && found {
			return existing, false, nil
		}
	}
	return created, inserted, nil
}

func GetUserCanvasAudioTask(userID string, id string) (model.CanvasAudioTask, bool, error) {
	return repository.GetUserCanvasAudioTask(strings.TrimSpace(userID), strings.TrimSpace(id))
}

func SaveCanvasAudioTask(task model.CanvasAudioTask) (model.CanvasAudioTask, error) {
	task.UpdatedAt = now()
	return repository.UpdateCanvasAudioTask(task)
}

func CanvasAudioTaskResponse(task model.CanvasAudioTask) map[string]any {
	result := map[string]any{
		"id":           task.ID,
		"object":       "canvas.audio.task",
		"source":       task.Source,
		"source_id":    task.SourceID,
		"node_id":      task.NodeID,
		"model":        task.Model,
		"status":       task.Status,
		"progress":     task.Progress,
		"prompt":       task.Prompt,
		"created_at":   task.CreatedAt,
		"updated_at":   task.UpdatedAt,
		"started_at":   task.StartedAt,
		"completed_at": task.CompletedAt,
		"createdAt":    task.CreatedAt,
		"updatedAt":    task.UpdatedAt,
	}
	if task.AudioURL != "" {
		result["url"] = task.AudioURL
		result["audio_url"] = task.AudioURL
		result["storageKey"] = task.StorageKey
		result["mimeType"] = task.MimeType
		result["bytes"] = task.Bytes
	}
	if task.Error != "" || task.ErrorDetail != "" {
		result["error"] = map[string]any{"message": firstVideoTaskValue(task.Error, task.ErrorDetail)}
		result["error_detail"] = task.ErrorDetail
	}
	return result
}
