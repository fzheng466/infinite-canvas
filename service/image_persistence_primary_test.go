package service

import (
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

func TestRefreshTaskPersistenceUsesPositionZeroAsPrimary(t *testing.T) {
	current := now()
	task := model.CanvasImageTask{ID: "primary-output-task", UserID: "user-primary", Status: "completed", ExpectedOutputCount: 2, UpdatedAt: current}
	if _, _, err := repository.SaveCanvasImageTask(task); err != nil {
		t.Fatal(err)
	}
	outputs := []model.GeneratedImageOutput{
		{ID: "primary-output-0", TaskID: task.ID, Position: 0, CreatedBy: task.UserID, URL: "server://first", StorageKey: "server:first", MimeType: "image/png", Bytes: 111, Width: 1024, Height: 768, Status: model.PersistenceStatusCompleted, UpdatedAt: current},
		{ID: "primary-output-1", TaskID: task.ID, Position: 1, CreatedBy: task.UserID, URL: "server://second", StorageKey: "server:second", MimeType: "image/jpeg", Bytes: 222, Width: 768, Height: 1024, Status: model.PersistenceStatusProcessing, UpdatedAt: current},
	}
	for _, output := range outputs {
		job := model.StorageTransferJob{ID: "job-" + output.ID, OutputID: output.ID, TaskID: task.ID, CreatedBy: task.UserID, Status: output.Status, CreatedAt: current, UpdatedAt: current}
		if err := repository.CreateImagePersistence(output, job); err != nil {
			t.Fatal(err)
		}
	}
	refreshTaskPersistence(&task, outputs[0])
	if task.PersistenceStatus != model.PersistenceStatusProcessing {
		t.Fatalf("status=%s, want processing", task.PersistenceStatus)
	}
	outputs[1].Status = model.PersistenceStatusCompleted
	outputs[1].UpdatedAt = now()
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Save(&outputs[1]).Error; err != nil {
		t.Fatal(err)
	}
	refreshTaskPersistence(&task, outputs[1])
	if task.PersistenceStatus != model.PersistenceStatusCompleted {
		t.Fatalf("status=%s, want completed", task.PersistenceStatus)
	}
	if task.ImageURL != "server://first" || task.StorageKey != "server:first" || task.MimeType != "image/png" || task.Bytes != 111 || task.Width != 1024 || task.Height != 768 {
		t.Fatalf("primary metadata mismatched: %+v", task)
	}
	if len(task.ImageURLs) != 2 || task.ImageURLs[0] != "server://first" || task.ImageURLs[1] != "server://second" {
		t.Fatalf("image URLs=%v", task.ImageURLs)
	}
}
