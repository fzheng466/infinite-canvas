package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/fzheng466/infinite-canvas/config"
	"github.com/fzheng466/infinite-canvas/model"
	"github.com/fzheng466/infinite-canvas/repository"
)

var onePixelPNG = "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte{
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0xf0,
	0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
	0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
})

func TestMain(m *testing.M) {
	_ = os.MkdirAll(filepath.Join("..", "data"), 0755)
	root, err := os.MkdirTemp(filepath.Join("..", "data"), "persistence-test-*")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(root)
	// WAL 模式：避免 Windows 上回退日志模式时 fsync 偶发长停顿（历史上 glebarez/sqlite 踩过）。
	dsn := "file:" + filepath.ToSlash(filepath.Join(root, "test.db")) + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)"
	config.Cfg = config.Config{
		StorageDriver:        "sqlite",
		DatabaseDSN:          dsn,
		AutoMigrateEnabled:   true,
		LocalStorageEnabled:  true,
		LocalStorageDir:      filepath.Join(root, "storage"),
		StorageSpoolDir:      filepath.Join(root, "spool"),
		StorageMaxImageBytes: 1024 * 1024,
	}
	os.Exit(m.Run())
}

func init() {
	// 测试保持同步语义：QueueGeneratedImagePersistence 入队后立即处理，断言可确定性完成。
	storageTransferTrigger = func() { ProcessStorageTransferJobs(context.Background()) }
}

func TestImagePersistenceIdempotentAndRestartRecovery(t *testing.T) {
	task := model.CanvasImageTask{ID: "task-persistence", UserID: "user-a", Status: "completed", ImageURL: onePixelPNG, ImageURLs: []string{onePixelPNG}, CreatedAt: now(), UpdatedAt: now()}
	if _, _, err := repository.SaveCanvasImageTask(task); err != nil {
		t.Fatal(err)
	}
	if _, err := QueueGeneratedImagePersistence(task, task.ImageURLs); err != nil {
		t.Fatal(err)
	}
	if _, err := QueueGeneratedImagePersistence(task, task.ImageURLs); err != nil {
		t.Fatal(err)
	}
	outputs, err := repository.GetGeneratedImageOutputs(task.ID)
	if err != nil || len(outputs) != 1 || outputs[0].Status != model.PersistenceStatusCompleted {
		t.Fatalf("outputs=%+v err=%v", outputs, err)
	}
	if _, err := os.Stat(filepath.Join(config.Cfg.LocalStorageDir, "user-a", task.ID, outputs[0].ID+".png")); err != nil {
		t.Fatal(err)
	}

	spool, _, _, _, _, err := spoolGeneratedImage(context.Background(), "restart-output", onePixelPNG)
	if err != nil {
		t.Fatal(err)
	}
	current := now()
	restartOutput := model.GeneratedImageOutput{ID: "restart-output", TaskID: task.ID, Position: 1, CreatedBy: task.UserID, SourceURL: onePixelPNG, MimeType: "image/png", Bytes: 70, Status: model.PersistenceStatusProcessing, CreatedAt: current, UpdatedAt: current}
	restartJob := model.StorageTransferJob{ID: "storage_transfer_restart-output", OutputID: restartOutput.ID, TaskID: task.ID, CreatedBy: task.UserID, ProviderID: "local", ProviderType: model.StorageProviderTypeLocal, SpoolPath: spool, Status: model.PersistenceStatusProcessing, LeaseUntil: time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano), CreatedAt: current, UpdatedAt: current}
	if err := repository.CreateImagePersistence(restartOutput, restartJob); err != nil {
		t.Fatal(err)
	}
	// 追加输出后，任务的期望输出数必须同步为 2，claim 才会认领该 job。
	task.ExpectedOutputCount = 2
	if _, _, err := repository.SaveCanvasImageTask(task); err != nil {
		t.Fatal(err)
	}
	ProcessStorageTransferJobs(context.Background())
	job, err := repository.GetStorageTransferJob(restartJob.ID)
	if err != nil || job.Status != model.PersistenceStatusCompleted {
		t.Fatalf("recovered job=%+v err=%v", job, err)
	}
}

func TestStorageTransferFailureSchedulesRetryWithoutFailingGeneration(t *testing.T) {
	task := model.CanvasImageTask{ID: "retry-task", UserID: "user-a", Status: "completed", PersistenceStatus: model.PersistenceStatusProcessing, UpdatedAt: now()}
	if _, _, err := repository.SaveCanvasImageTask(task); err != nil {
		t.Fatal(err)
	}
	output := model.GeneratedImageOutput{ID: "retry-output", TaskID: task.ID, CreatedBy: task.UserID, Status: model.PersistenceStatusProcessing, UpdatedAt: now()}
	job := model.StorageTransferJob{ID: "retry-job", OutputID: output.ID, TaskID: task.ID, CreatedBy: task.UserID, SpoolPath: filepath.Join(os.TempDir(), "canvas-missing-spool.png"), Status: model.PersistenceStatusProcessing, UpdatedAt: now()}
	if err := repository.CreateImagePersistence(output, job); err != nil {
		t.Fatal(err)
	}
	if err := failStorageTransfer(job, output, task, os.ErrNotExist); err == nil {
		t.Fatal("failure should be returned")
	}
	saved, found, err := repository.GetUserCanvasImageTask(task.UserID, task.ID)
	if err != nil || !found || saved.Status != "completed" || saved.PersistenceStatus != model.PersistenceStatusRetryWait {
		t.Fatalf("generation status changed on persistence failure: %+v found=%v err=%v", saved, found, err)
	}
}

func TestTrashedObjectHiddenAndOwnerScoped(t *testing.T) {
	ownerCtx := WithUser(context.Background(), model.AuthUser{ID: "user-a", Role: model.UserRoleUser})
	object := model.StorageObject{ID: "generated-owner-test", ProviderID: "local", ObjectKey: "user-a/x.png", MimeType: "image/png", CreatedBy: "user-a", Status: "active", CreatedAt: now()}
	if _, err := repository.SaveStorageObject(object); err != nil {
		t.Fatal(err)
	}
	localPath := filepath.Join(config.Cfg.LocalStorageDir, filepath.FromSlash(object.ObjectKey))
	if err := os.MkdirAll(filepath.Dir(localPath), 0750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(localPath, []byte{0x89, 0x50, 0x4e, 0x47}, 0640); err != nil {
		t.Fatal(err)
	}
	otherCtx := WithUser(context.Background(), model.AuthUser{ID: "user-b", Role: model.UserRoleUser})

	// A 本人可读。
	if _, err := DownloadStorageObject(ownerCtx, object.ID, ""); err != nil {
		t.Fatalf("owner download failed: %v", err)
	}
	// B 不可读。
	if _, err := DownloadStorageObject(otherCtx, object.ID, ""); err == nil {
		t.Fatal("other user should not read private object")
	}
	// 匿名不可读。
	if _, err := DownloadStorageObject(context.Background(), object.ID, ""); err == nil {
		t.Fatal("anonymous should not read private object")
	}
	// 删除进入 trash 后对普通读取不可见。
	if err := DeleteStorageObject(ownerCtx, object.ID, nil); err != nil {
		t.Fatalf("delete failed: %v", err)
	}
	if _, err := DownloadStorageObject(ownerCtx, object.ID, ""); err == nil {
		t.Fatal("trashed object should not be downloadable")
	}
	// 签名 URL 也应拒绝已 trash 对象。
	if _, _, err := SignStorageObjectURL(ownerCtx, object.ID); err == nil {
		t.Fatal("trashed object should not be signable")
	}
}

func TestThumbnailGeneratedOnPersistence(t *testing.T) {
	png1024 := makePNGDataURL(1024, 640)
	task := model.CanvasImageTask{ID: "task-thumb", UserID: "user-a", Status: "completed", ImageURL: png1024, ImageURLs: []string{png1024}, CreatedAt: now(), UpdatedAt: now()}
	if _, _, err := repository.SaveCanvasImageTask(task); err != nil {
		t.Fatal(err)
	}
	if _, err := QueueGeneratedImagePersistence(task, task.ImageURLs); err != nil {
		t.Fatal(err)
	}
	outputs, err := repository.GetGeneratedImageOutputs(task.ID)
	if err != nil || len(outputs) != 1 {
		t.Fatalf("outputs=%v err=%v", outputs, err)
	}
	if outputs[0].ThumbnailURL == "" || outputs[0].ThumbnailObjectID == "" {
		t.Fatalf("thumbnail missing: %+v", outputs[0])
	}
	thumbPath := filepath.Join(config.Cfg.LocalStorageDir, "user-a", task.ID, "thumb-"+outputs[0].ID+".jpg")
	if _, err := os.Stat(thumbPath); err != nil {
		t.Fatalf("thumb file missing: %v", err)
	}
}

func TestQueueGeneratedImagePersistenceAvoidsCrossOwnerOutputIDCollision(t *testing.T) {
	baseID := "shared-image-output-task-0"
	foreign := model.GeneratedImageOutput{ID: baseID, TaskID: "foreign-task", Position: 0, CreatedBy: "image-owner-a", Status: model.PersistenceStatusCompleted, CreatedAt: now(), UpdatedAt: now()}
	if err := repository.CreateImagePersistence(foreign, model.StorageTransferJob{ID: "foreign-output-job", OutputID: baseID, TaskID: foreign.TaskID, CreatedBy: foreign.CreatedBy, Status: model.PersistenceStatusCompleted}); err != nil {
		t.Fatal(err)
	}
	task := model.CanvasImageTask{ID: "shared-image-output-task", UserID: "image-owner-b", Status: "completed", ImageURLs: []string{onePixelPNG}, CreatedAt: now(), UpdatedAt: now()}
	if _, _, err := repository.SaveCanvasImageTask(task); err != nil {
		t.Fatal(err)
	}
	if _, err := QueueGeneratedImagePersistence(task, task.ImageURLs); err != nil {
		t.Fatal(err)
	}
	outputs, err := repository.GetGeneratedImageOutputs(task.ID)
	if err != nil || len(outputs) != 1 {
		t.Fatalf("outputs=%+v err=%v", outputs, err)
	}
	if outputs[0].ID == baseID || outputs[0].CreatedBy != task.UserID || outputs[0].StorageObjectID == "generated-"+baseID {
		t.Fatalf("output collision was not isolated: %+v", outputs[0])
	}
	storedForeign, err := repository.GetGeneratedImageOutput(baseID)
	if err != nil || storedForeign.CreatedBy != foreign.CreatedBy {
		t.Fatalf("foreign output changed: %+v err=%v", storedForeign, err)
	}
}

func TestQueueGeneratedImagePersistenceAvoidsCrossOwnerStorageObjectIDCollision(t *testing.T) {
	task := model.CanvasImageTask{ID: "storage-object-collision-task", UserID: "storage-owner-b", Status: "completed", ImageURLs: []string{onePixelPNG}, CreatedAt: now(), UpdatedAt: now()}
	foreignID := "generated-" + task.ID + "-0"
	foreign := model.StorageObject{ID: foreignID, ProviderID: "local", ObjectKey: "storage-owner-a/foreign.png", CreatedBy: "storage-owner-a", Status: "active", CreatedAt: now()}
	if _, err := repository.SaveStorageObject(foreign); err != nil {
		t.Fatal(err)
	}
	if _, _, err := repository.SaveCanvasImageTask(task); err != nil {
		t.Fatal(err)
	}
	if _, err := QueueGeneratedImagePersistence(task, task.ImageURLs); err != nil {
		t.Fatal(err)
	}
	outputs, err := repository.GetGeneratedImageOutputs(task.ID)
	if err != nil || len(outputs) != 1 {
		t.Fatalf("outputs=%+v err=%v", outputs, err)
	}
	if outputs[0].StorageObjectID == foreignID || outputs[0].StorageKey == "server:"+foreignID || outputs[0].URL == "/api/files/"+foreignID+"/content" {
		t.Fatalf("storage object collision was not isolated: %+v", outputs[0])
	}
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	var storedForeign model.StorageObject
	if err := db.First(&storedForeign, "id = ?", foreignID).Error; err != nil || storedForeign.CreatedBy != foreign.CreatedBy {
		t.Fatalf("foreign storage object changed: %+v err=%v", storedForeign, err)
	}
}

func TestStorageObjectIdentityAvoidsIDAndKeyCollisions(t *testing.T) {
	foreign := model.StorageObject{ID: "generated-collision", ProviderID: "local", ObjectKey: "image-owner-a/task/image.png", CreatedBy: "image-owner-a", Status: "active", CreatedAt: now()}
	if _, err := repository.SaveStorageObject(foreign); err != nil {
		t.Fatal(err)
	}
	id, key, err := repository.AllocateStorageObjectIdentity(foreign.ID, "image-owner-b/task/image.png", "image-owner-b")
	if err != nil {
		t.Fatal(err)
	}
	if id == foreign.ID || key == foreign.ObjectKey {
		t.Fatalf("ID collision not avoided: id=%s key=%s", id, key)
	}
	id, key, err = repository.AllocateStorageObjectIdentity("generated-key-collision", foreign.ObjectKey, "image-owner-b")
	if err != nil {
		t.Fatal(err)
	}
	if id == "generated-key-collision" || key == foreign.ObjectKey {
		t.Fatalf("object key collision not avoided: id=%s key=%s", id, key)
	}
}

// makePNGDataURL 生成一张纯色 PNG data URL。
func makePNGDataURL(width, height int) string {
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.Set(x, y, color.RGBA{uint8(x % 256), uint8(y % 256), 128, 255})
		}
	}
	buffer := &bytes.Buffer{}
	if err := png.Encode(buffer, img); err != nil {
		panic(err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buffer.Bytes())
}
