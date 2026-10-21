package service

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

func TestCancelledContextReleasesStorageJobLease(t *testing.T) {
	task := model.CanvasImageTask{ID: "cancel-task", UserID: "user-a", Status: "completed", PersistenceStatus: model.PersistenceStatusProcessing, ExpectedOutputCount: 1, UpdatedAt: now()}
	if _, _, err := repository.SaveCanvasImageTask(task); err != nil {
		t.Fatal(err)
	}
	output := model.GeneratedImageOutput{ID: "cancel-output", TaskID: task.ID, CreatedBy: task.UserID, Status: model.PersistenceStatusProcessing, UpdatedAt: now()}
	job := model.StorageTransferJob{ID: "cancel-job", OutputID: output.ID, TaskID: task.ID, CreatedBy: task.UserID, Status: model.PersistenceStatusProcessing, LeaseUntil: time.Now().UTC().Add(time.Minute).Format(time.RFC3339Nano), LeaseOwner: storageWorkerID, LeaseToken: "cancel-token", Version: 3, UpdatedAt: now()}
	if err := repository.CreateImagePersistence(output, job); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := processStorageTransferJob(ctx, job)
	if err == nil {
		t.Fatal("cancellation should be reported")
	}
	saved, err := repository.GetStorageTransferJob(job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Status != model.PersistenceStatusPending {
		t.Fatalf("cancelled job status=%s, want pending for immediate retry", saved.Status)
	}
	if saved.LeaseUntil != "" || saved.LeaseToken != "" {
		t.Fatalf("lease not released: %+v", saved)
	}
	if saved.Version != job.Version+1 {
		t.Fatalf("version=%d, want %d", saved.Version, job.Version+1)
	}
	// 释放后下一轮调度应能立即重新认领。
	claimed, err := repository.ClaimStorageTransferJobs(10, time.Now().UTC(), time.Now().UTC().Add(storageTransferLease).Format(time.RFC3339Nano), "worker-test")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range claimed {
		if item.ID == job.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("released job not claimable: %+v", claimed)
	}
}

func TestCleanupStorageSpoolProtectsActiveJobs(t *testing.T) {
	// 建一个超出 24h 清理线的旧 spool 文件，并由 retry_wait job 引用。
	old := time.Now().Add(-30 * time.Hour)
	activeSpool := filepath.Join(config.Cfg.StorageSpoolDir, "active-retry-spool.png")
	if err := os.MkdirAll(config.Cfg.StorageSpoolDir, 0750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(activeSpool, []byte("keep"), 0640); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(activeSpool, old, old); err != nil {
		t.Fatal(err)
	}
	task := model.CanvasImageTask{ID: "spool-keep-task", UserID: "user-a", Status: "completed", PersistenceStatus: model.PersistenceStatusRetryWait, UpdatedAt: now()}
	if _, _, err := repository.SaveCanvasImageTask(task); err != nil {
		t.Fatal(err)
	}
	output := model.GeneratedImageOutput{ID: "spool-keep-output", TaskID: task.ID, CreatedBy: task.UserID, Status: model.PersistenceStatusRetryWait, UpdatedAt: now()}
	job := model.StorageTransferJob{ID: "spool-keep-job", OutputID: output.ID, TaskID: task.ID, CreatedBy: task.UserID, SpoolPath: activeSpool, Status: model.PersistenceStatusRetryWait, UpdatedAt: now()}
	if err := repository.CreateImagePersistence(output, job); err != nil {
		t.Fatal(err)
	}
	// 孤儿文件应被清理。
	orphan := filepath.Join(config.Cfg.StorageSpoolDir, "orphan.png")
	if err := os.WriteFile(orphan, []byte("drop"), 0640); err != nil {
		t.Fatal(err)
	}

	CleanupStorageSpool()

	if _, err := os.Stat(activeSpool); err != nil {
		t.Fatalf("spool of active retry_wait job must survive cleanup: %v", err)
	}
	if _, err := os.Stat(orphan); err == nil {
		t.Fatal("orphan spool file should be removed")
	} else if !os.IsNotExist(err) {
		t.Fatal(err)
	}
}
