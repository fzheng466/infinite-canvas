package service

import (
	"context"
	"testing"
	"time"

	"github.com/fzheng466/infinite-canvas/model"
	"github.com/fzheng466/infinite-canvas/repository"
)

func TestRescueOrphanPersistenceTasksRequeuesStuckTasks(t *testing.T) {
	current := time.Now().UTC().Add(-3 * time.Minute).Format(time.RFC3339Nano)
	task := model.CanvasImageTask{
		ID: "orphan-rescue-test", UserID: "user-orphan", Status: "completed",
		ImageURL:          "http://127.0.0.1:9/never.png", // 单图协议：URL 在单值字段，image_urls 为空
		PersistenceStatus: model.PersistenceStatusRetryWait, PersistenceError: "database is locked (5) (SQLITE_BUSY)",
		CreatedAt: current, UpdatedAt: current,
	}
	if _, _, err := repository.SaveCanvasImageTask(task); err != nil {
		t.Fatal(err)
	}
	before := time.Now().UTC().Format(time.RFC3339Nano)
	after := time.Now().UTC().Add(-24 * time.Hour).Format(time.RFC3339Nano)
	found, err := repository.ListOrphanRetryImageTasks(before, after, 50)
	if err != nil {
		t.Fatal(err)
	}
	hit := false
	for _, item := range found {
		if item.ID == task.ID {
			hit = true
		}
	}
	if !hit {
		t.Fatal("孤儿任务未被扫描到")
	}
	RescueOrphanPersistenceTasks(context.Background())
	var jobs int64
	db, dbErr := repository.DB()
	if dbErr != nil {
		t.Fatal(dbErr)
	}
	if err := db.Table("storage_transfer_jobs").Where("task_id = ?", task.ID).Count(&jobs).Error; err != nil {
		t.Fatal(err)
	}
	if jobs == 0 {
		t.Fatal("救援后仍没有 job，任务将永远卡住")
	}
	// 救援的核心目标是补出 job：下载失败属预期（job 按退避自动重试），
	// 任务即使短暂回到 retry_wait 也已不是"无 job 的孤儿"。
	// 已有 job 的任务不再被认作孤儿，避免重复入队。
	found2, err := repository.ListOrphanRetryImageTasks(before, after, 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range found2 {
		if item.ID == task.ID {
			t.Fatal("已有 job 的任务不应再次被列为孤儿")
		}
	}
}
