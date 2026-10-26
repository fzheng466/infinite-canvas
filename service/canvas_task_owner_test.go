package service

import (
	"errors"
	"testing"

	"github.com/fzheng466/infinite-canvas/model"
	"github.com/fzheng466/infinite-canvas/repository"
)

func TestCanvasImageTaskSaveNeverOverwritesAnotherUsersRow(t *testing.T) {
	current := now()
	task := model.CanvasImageTask{ID: "owner-guard-image", UserID: "owner-a", Prompt: "a", Status: "queued", CreatedAt: current, UpdatedAt: current}
	if _, _, err := repository.SaveCanvasImageTask(task); err != nil {
		t.Fatal(err)
	}
	hijack := task
	hijack.UserID, hijack.Prompt = "owner-b", "b"
	if _, _, err := repository.SaveCanvasImageTask(hijack); !errors.Is(err, repository.ErrCanvasTaskOwnerConflict) {
		t.Fatalf("cross-user save err=%v", err)
	}
	task.Prompt = "a2"
	if _, _, err := repository.SaveCanvasImageTask(task); err != nil {
		t.Fatalf("same-user save err=%v", err)
	}
	if stored, found, _ := repository.GetUserCanvasImageTask("owner-a", task.ID); !found || stored.Prompt != "a2" {
		t.Fatalf("owner task=%+v found=%v", stored, found)
	}
	if _, found, _ := repository.GetUserCanvasImageTask("owner-b", task.ID); found {
		t.Fatal("task ownership moved to owner-b")
	}
	if _, _, err := CreateCanvasImageTask(CanvasImageTaskCreateInput{UserID: "owner-b", ClientTaskID: task.ID, Prompt: "b"}); err == nil {
		t.Fatal("another user's clientTaskID must be rejected")
	}
}

func TestCanvasAudioTaskSaveNeverOverwritesAnotherUsersRow(t *testing.T) {
	current := now()
	task := model.CanvasAudioTask{ID: "owner-guard-audio", UserID: "owner-a", Prompt: "a", Status: "queued", CreatedAt: current, UpdatedAt: current}
	if _, _, err := repository.SaveCanvasAudioTask(task); err != nil {
		t.Fatal(err)
	}
	hijack := task
	hijack.UserID, hijack.Prompt = "owner-b", "b"
	if _, _, err := repository.SaveCanvasAudioTask(hijack); !errors.Is(err, repository.ErrCanvasTaskOwnerConflict) {
		t.Fatalf("cross-user save err=%v", err)
	}
	task.Prompt = "a2"
	if _, _, err := repository.SaveCanvasAudioTask(task); err != nil {
		t.Fatalf("same-user save err=%v", err)
	}
	if stored, found, _ := repository.GetUserCanvasAudioTask("owner-a", task.ID); !found || stored.Prompt != "a2" {
		t.Fatalf("owner task=%+v found=%v", stored, found)
	}
	if _, found, _ := repository.GetUserCanvasAudioTask("owner-b", task.ID); found {
		t.Fatal("task ownership moved to owner-b")
	}
	if _, _, err := CreateCanvasAudioTask(CanvasAudioTaskCreateInput{UserID: "owner-b", ClientTaskID: task.ID, Prompt: "b"}); err == nil {
		t.Fatal("another user's clientTaskID must be rejected")
	}
}
