package service

import (
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/fzheng466/infinite-canvas/model"
	"github.com/fzheng466/infinite-canvas/repository"
)

type CanvasImageTaskCreateInput struct {
	UserID          string
	UserDisplayName string
	Source          string
	SourceID        string
	NodeID          string
	ClientTaskID    string
	Model           string
	ChannelID       string
	UserChannelID   string
	ChannelName     string
	Prompt          string
	GenerationType  string
	Endpoint        string
	ContentType     string
	RequestBody     string
}

// CreateCanvasImageTask 按 clientTaskID 幂等创建任务；第二个返回值表示是否为本次新建，
// 为 false 时调用方不得再次启动执行（否则幂等重放会重复调用上游并重复扣费）。
func CreateCanvasImageTask(input CanvasImageTaskCreateInput) (model.CanvasImageTask, bool, error) {
	userID := strings.TrimSpace(input.UserID)
	clientTaskID := strings.TrimSpace(input.ClientTaskID)
	if clientTaskID != "" {
		if existing, err := repository.GetCanvasImageTaskByID(clientTaskID); err == nil {
			if existing.UserID != userID {
				return model.CanvasImageTask{}, false, errors.New("clientTaskID 已被其他用户使用")
			}
			return existing, false, nil
		}
	}
	current := now()
	task := model.CanvasImageTask{
		ID:              firstVideoTaskValue(clientTaskID, "canvas_image_task_"+uuid.NewString()),
		UserID:          userID,
		UserDisplayName: strings.TrimSpace(input.UserDisplayName),
		Source:          normalizeCanvasImageTaskSource(input.Source),
		SourceID:        strings.TrimSpace(input.SourceID),
		NodeID:          strings.TrimSpace(input.NodeID),
		Model:           strings.TrimSpace(input.Model),
		ChannelID:       strings.TrimSpace(input.ChannelID),
		UserChannelID:   strings.TrimSpace(input.UserChannelID),
		ChannelName:     strings.TrimSpace(input.ChannelName),
		Status:          "queued",
		Progress:        0,
		Prompt:          strings.TrimSpace(input.Prompt),
		GenerationType:  strings.TrimSpace(input.GenerationType),
		Endpoint:        strings.TrimSpace(input.Endpoint),
		ContentType:     strings.TrimSpace(input.ContentType),
		RequestBody:     input.RequestBody,
		CreatedAt:       current,
		UpdatedAt:       current,
	}
	created, inserted, err := repository.SaveCanvasImageTask(task)
	if err != nil {
		if clientTaskID != "" {
			// 并发重复提交时另一请求可能已建任务：主键冲突后返回已有任务，而不是报错。
			if existing, found, getErr := repository.GetUserCanvasImageTask(userID, clientTaskID); getErr == nil && found {
				return existing, false, nil
			}
		}
		return model.CanvasImageTask{}, false, err
	}
	if !inserted && clientTaskID != "" {
		// 并发竞态：另一请求刚刚插入同 clientTaskID，本次实际走的是更新分支——按幂等命中返回已有任务。
		if existing, found, getErr := repository.GetUserCanvasImageTask(userID, clientTaskID); getErr == nil && found {
			return existing, false, nil
		}
	}
	return created, inserted, nil
}

func GetUserCanvasImageTask(userID string, id string) (model.CanvasImageTask, bool, error) {
	return repository.GetUserCanvasImageTask(strings.TrimSpace(userID), strings.TrimSpace(id))
}

func ListUserCanvasImageTasks(userID string, sources []string, limit int) ([]map[string]any, error) {
	tasks, err := repository.ListUserCanvasImageTasks(strings.TrimSpace(userID), normalizeCanvasImageTaskSources(sources), limit)
	if err != nil {
		return nil, err
	}
	result := make([]map[string]any, 0, len(tasks))
	for _, task := range tasks {
		result = append(result, CanvasImageTaskResponse(task))
	}
	return result, nil
}

func ListRecentCompletedCanvasImageTasks(userID string, sources []string, limit int) ([]map[string]any, error) {
	tasks, err := repository.ListRecentCompletedCanvasImageTasks(strings.TrimSpace(userID), normalizeCanvasImageTaskSources(sources), limit)
	if err != nil {
		return nil, err
	}
	result := make([]map[string]any, 0, len(tasks))
	for _, task := range tasks {
		result = append(result, CanvasImageTaskResponse(task))
	}
	return result, nil
}

func BatchUserCanvasImageTasks(userID string, ids []string) ([]map[string]any, error) {
	tasks, err := repository.BatchUserCanvasImageTasks(strings.TrimSpace(userID), ids)
	if err != nil {
		return nil, err
	}
	result := make([]map[string]any, 0, len(tasks))
	for _, task := range tasks {
		result = append(result, CanvasImageTaskResponse(task))
	}
	return result, nil
}

func DeleteUserCanvasImageTask(userID string, id string) error {
	return repository.DeleteUserCanvasImageTask(strings.TrimSpace(userID), strings.TrimSpace(id))
}

func DeleteUserCanvasTasks(userID string, sourceID string, nodeIDs []string) error {
	return repository.DeleteUserCanvasTasks(strings.TrimSpace(userID), strings.TrimSpace(sourceID), nodeIDs)
}

func SaveCanvasImageTask(task model.CanvasImageTask) (model.CanvasImageTask, error) {
	task.UpdatedAt = now()
	return repository.UpdateCanvasImageTask(task)
}

func CanvasImageTaskResponse(task model.CanvasImageTask) map[string]any {
	outputs, _ := repository.GetGeneratedImageOutputs(task.ID)
	publishedOutputs := make([]model.GeneratedImageOutput, 0, len(outputs))
	for _, output := range outputs {
		// 上游 URL 只允许作为服务器内部转存源；公开响应只能发布本服务对象。
		if output.Status != model.PersistenceStatusCompleted || !isPublishedStorageURL(output.StorageKey, output.URL) {
			output.URL = ""
			output.StorageKey = ""
		}
		output.SourceURL = ""
		publishedOutputs = append(publishedOutputs, output)
	}
	published := task.PersistenceStatus == model.PersistenceStatusCompleted && isPublishedStorageURL(task.StorageKey, task.ImageURL)
	result := map[string]any{
		"id":                 task.ID,
		"object":             "canvas.image.task",
		"source":             task.Source,
		"source_id":          task.SourceID,
		"node_id":            task.NodeID,
		"model":              task.Model,
		"status":             task.Status,
		"progress":           task.Progress,
		"prompt":             task.Prompt,
		"generationType":     task.GenerationType,
		"created_at":         task.CreatedAt,
		"updated_at":         task.UpdatedAt,
		"started_at":         task.StartedAt,
		"completed_at":       task.CompletedAt,
		"createdAt":          task.CreatedAt,
		"updatedAt":          task.UpdatedAt,
		"persistence_status": task.PersistenceStatus,
		"persistence_error":  task.PersistenceError,
		"outputs":            publishedOutputs,
	}
	if published {
		result["url"] = task.ImageURL
		result["image_url"] = task.ImageURL
		if len(task.ImageURLs) > 0 {
			publishedURLs := make([]string, 0, len(task.ImageURLs))
			for _, imageURL := range task.ImageURLs {
				if isPublishedStorageURL(task.StorageKey, imageURL) {
					publishedURLs = append(publishedURLs, imageURL)
				}
			}
			if len(publishedURLs) > 0 {
				result["image_urls"] = publishedURLs
			}
		}
		result["storageKey"] = task.StorageKey
		result["width"] = task.Width
		result["height"] = task.Height
		result["mimeType"] = task.MimeType
		result["bytes"] = task.Bytes
	}
	if task.Error != "" || task.ErrorDetail != "" {
		result["error"] = map[string]any{"message": firstVideoTaskValue(task.Error, task.ErrorDetail)}
		result["error_detail"] = task.ErrorDetail
	}
	return result
}

func isPublishedStorageURL(storageKey, imageURL string) bool {
	return strings.HasPrefix(strings.TrimSpace(storageKey), "server:") && strings.HasPrefix(strings.TrimSpace(imageURL), "/api/files/")
}

func normalizeCanvasImageTaskSource(source string) string {
	switch strings.ToLower(strings.TrimSpace(source)) {
	case "image-workbench":
		return "image-workbench"
	case "workflow":
		return "workflow"
	case "canvas", "":
		return "canvas"
	default:
		return "canvas"
	}
}

func normalizeCanvasImageTaskSources(sources []string) []string {
	result := make([]string, 0, len(sources))
	seen := map[string]bool{}
	for _, source := range sources {
		normalized := normalizeCanvasImageTaskSource(source)
		if normalized != "" && !seen[normalized] {
			result = append(result, normalized)
			seen[normalized] = true
		}
	}
	return result
}
