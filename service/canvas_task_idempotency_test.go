package service

import (
	"strings"
	"sync"
	"testing"

	"github.com/fzheng466/infinite-canvas/model"
	"github.com/fzheng466/infinite-canvas/repository"
)

func TestCreateCanvasImageTaskIdempotentByClientTaskID(t *testing.T) {
	input := CanvasImageTaskCreateInput{
		UserID:       "user-idem",
		ClientTaskID: "client-idem-image",
		Model:        "test-model",
	}
	first, isNewFirst, err := CreateCanvasImageTask(input)
	if err != nil {
		t.Fatal(err)
	}
	if !isNewFirst {
		t.Fatal("first create must be reported as new")
	}
	if first.Status != "queued" {
		t.Fatalf("first status=%s", first.Status)
	}
	second, isNewSecond, err := CreateCanvasImageTask(input)
	if err != nil {
		t.Fatal(err)
	}
	if isNewSecond {
		t.Fatal("duplicate clientTaskID must not be reported as new, otherwise handler would re-run the task and double-charge")
	}
	if second.ID != first.ID {
		t.Fatalf("duplicate clientTaskID created new task: %s vs %s", first.ID, second.ID)
	}
}

func TestCreateCanvasImageTaskConcurrentSameClientTaskID(t *testing.T) {
	const goroutines = 8
	const clientTaskID = "client-idem-image-concurrent"
	results := make([]model.CanvasImageTask, goroutines)
	isNews := make([]bool, goroutines)
	errs := make([]error, goroutines)
	var wg sync.WaitGroup
	for i := 0; goroutines > i; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			results[index], isNews[index], errs[index] = CreateCanvasImageTask(CanvasImageTaskCreateInput{
				UserID:       "user-idem-concurrent",
				ClientTaskID: clientTaskID,
				Model:        "test-model",
			})
		}(i)
	}
	wg.Wait()
	ids := map[string]bool{}
	newCount := 0
	for i := 0; goroutines > i; i++ {
		if errs[i] != nil {
			t.Fatalf("goroutine %d failed: %v", i, errs[i])
		}
		ids[results[i].ID] = true
		if isNews[i] {
			newCount++
		}
	}
	if len(ids) != 1 {
		t.Fatalf("concurrent duplicate clientTaskID produced %d tasks: %v", len(ids), ids)
	}
	if newCount != 1 {
		t.Fatalf("concurrent duplicate clientTaskID must report exactly one new task, got %d", newCount)
	}
}

func TestCreateCanvasImageTaskDifferentUserSameClientTaskIDRejected(t *testing.T) {
	clientTaskID := "client-idem-image-shared"
	if _, _, err := CreateCanvasImageTask(CanvasImageTaskCreateInput{UserID: "user-idem-a", ClientTaskID: clientTaskID, Model: "test-model"}); err != nil {
		t.Fatal(err)
	}
	// clientTaskID 直接作为全局主键，另一个用户复用必须报错而不是覆盖他人任务。
	if _, _, err := CreateCanvasImageTask(CanvasImageTaskCreateInput{UserID: "user-idem-b", ClientTaskID: clientTaskID, Model: "test-model"}); err == nil {
		t.Fatal("different user reusing clientTaskID should fail")
	}
	task, found, err := repository.GetUserCanvasImageTask("user-idem-a", clientTaskID)
	if err != nil || !found || task.UserID != "user-idem-a" {
		t.Fatalf("owner task changed: found=%v err=%v", found, err)
	}
}

func TestCreateCanvasImageTaskBlankClientTaskIDGeneratesUniqueIDs(t *testing.T) {
	first, _, err := CreateCanvasImageTask(CanvasImageTaskCreateInput{UserID: "user-idem-blank", Model: "test-model"})
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := CreateCanvasImageTask(CanvasImageTaskCreateInput{UserID: "user-idem-blank", Model: "test-model"})
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == second.ID || strings.HasPrefix(first.ID, "client-") {
		t.Fatalf("blank clientTaskID must generate uuid ids: %s %s", first.ID, second.ID)
	}
}

func TestCreateVideoTaskIdempotentAndOwnerScopedByClientTaskID(t *testing.T) {
	clientTaskID := "client_video_task_idem_shared"
	first, err := CreateVideoTask(VideoTaskCreateInput{UserID: "video-idem-a", ClientTaskID: clientTaskID, Model: "test-video", Status: "processing"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := CreateVideoTask(VideoTaskCreateInput{UserID: "video-idem-a", ClientTaskID: clientTaskID, Model: "changed-model", Status: "failed"})
	if err != nil {
		t.Fatal(err)
	}
	if second.ID != first.ID || second.Model != first.Model || second.Status != first.Status {
		t.Fatalf("same-user retry must return existing task: first=%+v second=%+v", first, second)
	}
	if _, err := CreateVideoTask(VideoTaskCreateInput{UserID: "video-idem-b", ClientTaskID: clientTaskID, Model: "test-video"}); err == nil || !strings.Contains(err.Error(), "其他用户") {
		t.Fatalf("different-user retry error=%v", err)
	}
	stored, found, err := repository.GetVideoTask(clientTaskID)
	if err != nil || !found || stored.UserID != "video-idem-a" {
		t.Fatalf("owner task changed: task=%+v found=%v err=%v", stored, found, err)
	}
}

func TestGenerationLogUpsertSkipsIDsOwnedByOtherUsers(t *testing.T) {
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	videoID := "video-log-owner-conflict"
	imageID := "image-log-owner-conflict"
	if err := db.Create(&model.VideoGenerationLog{ID: videoID, UserID: "log-owner-a", Status: "completed", PayloadJSON: "owner-video"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.ImageGenerationLog{ID: imageID, UserID: "log-owner-a", Status: "completed", PayloadJSON: "owner-image"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := repository.UpsertVideoGenerationLogs("log-owner-b", []model.VideoGenerationLog{{ID: videoID, Status: "failed", PayloadJSON: "attacker-video"}}); err != nil {
		t.Fatal(err)
	}
	if err := repository.UpsertImageGenerationLogs("log-owner-b", []model.ImageGenerationLog{{ID: imageID, Status: "failed", PayloadJSON: "attacker-image"}}); err != nil {
		t.Fatal(err)
	}
	var video model.VideoGenerationLog
	var image model.ImageGenerationLog
	if err := db.First(&video, "id = ?", videoID).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.First(&image, "id = ?", imageID).Error; err != nil {
		t.Fatal(err)
	}
	if video.UserID != "log-owner-a" || video.PayloadJSON != "owner-video" || image.UserID != "log-owner-a" || image.PayloadJSON != "owner-image" {
		t.Fatalf("cross-user upsert overwrote records: video=%+v image=%+v", video, image)
	}
}

func TestCreativeWorkflowRepositoryUpdatesAndDeletesByOwner(t *testing.T) {
	original := model.CreativeWorkflow{ID: "workflow-owner-defense", OwnerUserID: "workflow-owner-a", Scope: "private", Name: "owner", Data: "{}", CreatedAt: now(), UpdatedAt: now()}
	if _, err := repository.SaveCreativeWorkflow(original); err != nil {
		t.Fatal(err)
	}
	attacker := original
	attacker.OwnerUserID, attacker.Name = "workflow-owner-b", "attacker"
	if _, err := repository.SaveCreativeWorkflow(attacker); err == nil {
		t.Fatal("non-owner repository update should fail")
	}
	if err := repository.DeleteCreativeWorkflow(original.ID, "workflow-owner-b"); err != nil {
		t.Fatal(err)
	}
	stored, found, err := repository.GetCreativeWorkflow(original.ID)
	if err != nil || !found || stored.Name != "owner" || stored.OwnerUserID != "workflow-owner-a" {
		t.Fatalf("non-owner changed workflow: stored=%+v found=%v err=%v", stored, found, err)
	}
	if err := repository.DeleteCreativeWorkflow(original.ID, original.OwnerUserID); err != nil {
		t.Fatal(err)
	}
	if _, found, err := repository.GetCreativeWorkflow(original.ID); err != nil || found {
		t.Fatalf("owner delete failed: found=%v err=%v", found, err)
	}
}

func TestCreateCanvasAudioTaskIdempotentByClientTaskID(t *testing.T) {
	input := CanvasAudioTaskCreateInput{
		UserID:       "user-idem",
		ClientTaskID: "client-idem-audio",
		Model:        "test-tts",
	}
	first, isNewFirst, err := CreateCanvasAudioTask(input)
	if err != nil {
		t.Fatal(err)
	}
	if !isNewFirst {
		t.Fatal("first audio create must be reported as new")
	}
	second, isNewSecond, err := CreateCanvasAudioTask(input)
	if err != nil {
		t.Fatal(err)
	}
	if isNewSecond {
		t.Fatal("duplicate audio clientTaskID must not be reported as new")
	}
	if second.ID != first.ID {
		t.Fatalf("duplicate clientTaskID created new audio task: %s vs %s", first.ID, second.ID)
	}
}
