package handler

import (
	"errors"
	"testing"
	"time"

	"github.com/fzheng466/infinite-canvas/model"
)

type fakeImageSaver struct {
	failures int
	calls    int
}

func (s *fakeImageSaver) save(task model.CanvasImageTask) (model.CanvasImageTask, error) {
	s.calls++
	if s.calls <= s.failures {
		return task, errors.New("db busy")
	}
	task.Status = "saved"
	return task, nil
}

func withImageSaverForTest(t *testing.T, saver func(model.CanvasImageTask) (model.CanvasImageTask, error)) {
	t.Helper()
	previousSaver, previousDelays := canvasImageTaskSaver, canvasTaskSaveRetryDelays
	canvasImageTaskSaver = saver
	canvasTaskSaveRetryDelays = []time.Duration{0, 0}
	t.Cleanup(func() {
		canvasImageTaskSaver, canvasTaskSaveRetryDelays = previousSaver, previousDelays
	})
}

func TestSaveCanvasImageTaskWithRetryRetriesTransientFailure(t *testing.T) {
	saver := &fakeImageSaver{failures: 2}
	withImageSaverForTest(t, saver.save)
	task := model.CanvasImageTask{ID: "retry-helper-task", UserID: "user-a", Status: "completed"}
	updated := saveCanvasImageTaskWithRetry(task, "completed")
	if saver.calls != 3 {
		t.Fatalf("calls=%d, want 3", saver.calls)
	}
	if updated.Status != "saved" {
		t.Fatalf("updated.Status=%s, want saved", updated.Status)
	}
}

func TestSaveCanvasImageTaskWithRetryKeepsTaskWhenAllAttemptsFail(t *testing.T) {
	saver := &fakeImageSaver{failures: 100}
	withImageSaverForTest(t, saver.save)
	task := model.CanvasImageTask{ID: "fail-helper-task", UserID: "user-a", Status: "failed"}
	updated := saveCanvasImageTaskWithRetry(task, "failed")
	if saver.calls != 3 {
		t.Fatalf("calls=%d, want 3", saver.calls)
	}
	if updated.Status != "failed" {
		t.Fatalf("updated.Status=%s, want original failed state", updated.Status)
	}
}
