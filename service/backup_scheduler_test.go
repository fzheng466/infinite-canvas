package service

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fzheng466/infinite-canvas/config"
	"github.com/fzheng466/infinite-canvas/repository"
)

func TestBackupRunOnceCreatesVerifiedArchive(t *testing.T) {
	// DB 用不自动清理的临时目录：repository 单例在测试结束后仍持有连接，
	// t.TempDir 的 RemoveAll 会因文件占用而失败。备份目录仍走 t.TempDir 正常清理。
	root, err := os.MkdirTemp("", "backup-db-*")
	if err != nil {
		t.Fatalf("mkdir db root: %v", err)
	}
	dsn := filepath.ToSlash(filepath.Join(root, "main.db"))
	previous := config.Cfg
	config.Cfg.DatabaseDSN = dsn
	config.Cfg.BackupDir = filepath.Join(root, "backups")
	config.Cfg.BackupRetainDays = 7
	t.Cleanup(func() { config.Cfg = previous })

	// repository 单例使用全局配置的 DSN；测试进程内首次触发即按测试 DSN 建库。
	db, dbErr := repository.DB()
	if dbErr != nil {
		t.Fatalf("open db: %v", dbErr)
	}
	if err := db.Exec("CREATE TABLE IF NOT EXISTS backup_probe (id TEXT PRIMARY KEY)").Error; err != nil {
		t.Fatalf("create probe table: %v", err)
	}

	archive, err := RunBackupOnce()
	if err != nil {
		t.Fatalf("RunBackupOnce: %v", err)
	}
	if !strings.HasSuffix(archive, ".db.gz") {
		t.Fatalf("unexpected archive name: %s", archive)
	}
	info, err := os.Stat(archive)
	if err != nil || info.Size() == 0 {
		t.Fatalf("archive missing or empty: %v", err)
	}
	sumPath := archive + ".sha256"
	sumBytes, err := os.ReadFile(sumPath)
	if err != nil || !strings.Contains(string(sumBytes), filepath.Base(archive)) {
		t.Fatalf("sha256 sidecar missing/invalid: %v %s", err, string(sumBytes))
	}

	// 再跑一次：同一天覆盖同名归档（幂等），不产生第二份。
	again, err := RunBackupOnce()
	if err != nil || again != archive {
		t.Fatalf("second run: %v %s", err, again)
	}
}

func TestBackupDirDefaultsNextToDatabaseForEveryDSNForm(t *testing.T) {
	previous := config.Cfg
	t.Cleanup(func() { config.Cfg = previous })
	want := filepath.Join(filepath.FromSlash("/app/data"), "backups")
	for _, dsn := range []string{
		"/app/data/infinite-canvas.db",
		"/app/data/infinite-canvas.db?_pragma=busy_timeout(5000)",
		"file:/app/data/infinite-canvas.db?_pragma=journal_mode(WAL)&_pragma=busy_timeout(15000)",
	} {
		config.Cfg.BackupDir = ""
		config.Cfg.DatabaseDSN = dsn
		if got := backupDir(); got != want {
			t.Fatalf("backupDir(%q) = %q, want %q", dsn, got, want)
		}
	}
}
