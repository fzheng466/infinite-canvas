package service

import (
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/robfig/cron/v3"
	"github.com/fzheng466/infinite-canvas/config"
	"github.com/fzheng466/infinite-canvas/repository"
)

// 每日自动备份：VACUUM INTO 生成一致快照（WAL 下在线、不锁业务）+ gzip + SHA256 + 保留期清理。
// 商用级运维底线——此前全靠部署前手动 tar，一旦忘了就没有可恢复点。

var backupCron *cron.Cron
var backupCronMu = sync.Mutex{}

func backupDir() string {
	dir := strings.TrimSpace(config.Cfg.BackupDir)
	if dir == "" {
		// file: URI 不去前缀会得到相对目录 "file:/…"，备份落进容器可写层而不是数据卷。
		dsn := strings.TrimPrefix(strings.TrimSpace(config.Cfg.DatabaseDSN), "file:")
		if index := strings.Index(dsn, "?"); index >= 0 {
			dsn = dsn[:index]
		}
		dir = filepath.Join(filepath.Dir(filepath.FromSlash(dsn)), "backups")
	}
	return dir
}

// RunBackupOnce 执行一次备份，返回备份文件路径。独立导出以便测试与手动触发。
func RunBackupOnce() (string, error) {
	dir := backupDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	snapshot := filepath.Join(dir, fmt.Sprintf("canvas-%s.db", time.Now().UTC().Format("20060102")))
	db, err := repository.DB()
	if err != nil {
		return "", err
	}
	// VACUUM INTO：在线一致快照，失败（如磁盘不足）直接报错，不影响原库。
	if err := db.Exec("VACUUM INTO ?", snapshot).Error; err != nil {
		return "", fmt.Errorf("VACUUM INTO failed: %w", err)
	}
	archive := snapshot + ".gz"
	if err := gzipFile(snapshot, archive); err != nil {
		_ = os.Remove(snapshot)
		return "", err
	}
	_ = os.Remove(snapshot)
	sum, err := fileSHA256(archive)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(archive+".sha256", []byte(sum+"  "+filepath.Base(archive)+"\n"), 0o644); err != nil {
		return "", err
	}
	log.Printf("backup completed: %s (%d bytes, sha256=%s...)", archive, fileSize(archive), sum[:12])
	if retainDays := config.Cfg.BackupRetainDays; retainDays > 0 {
		pruneOldBackups(dir, time.Duration(retainDays)*24*time.Hour)
	}
	return archive, nil
}

func gzipFile(source string, target string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(target)
	if err != nil {
		return err
	}
	defer out.Close()
	writer := gzip.NewWriter(out)
	if _, err := io.Copy(writer, in); err != nil {
		return err
	}
	return writer.Close()
}

func fileSHA256(path string) (string, error) {
	in, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer in.Close()
	sum := sha256.New()
	if _, err := io.Copy(sum, in); err != nil {
		return "", err
	}
	return hex.EncodeToString(sum.Sum(nil)), nil
}

func fileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Size()
}

func pruneOldBackups(dir string, maxAge time.Duration) {
	entries, err := filepath.Glob(filepath.Join(dir, "canvas-*.db.gz"))
	if err != nil {
		return
	}
	sort.Strings(entries)
	cutoff := time.Now().Add(-maxAge)
	for _, entry := range entries {
		info, err := os.Stat(entry)
		if err != nil || info.ModTime().After(cutoff) {
			continue
		}
		_ = os.Remove(entry)
		_ = os.Remove(entry + ".sha256")
	}
}

// StartBackupScheduler 按 BACKUP_CRON（默认每天 03:30）执行自动备份；BACKUP_ENABLED=false 时不启动。
func StartBackupScheduler() {
	if !config.Cfg.BackupEnabled {
		return
	}
	spec := strings.TrimSpace(config.Cfg.BackupCron)
	if spec == "" {
		spec = "30 3 * * *"
	}
	backupCronMu.Lock()
	defer backupCronMu.Unlock()
	if backupCron == nil {
		backupCron = cron.New()
		backupCron.Start()
	}
	if _, err := backupCron.AddFunc(spec, func() {
		if _, err := RunBackupOnce(); err != nil {
			log.Printf("scheduled backup failed: %v", err)
		}
	}); err != nil {
		log.Printf("backup scheduler add func failed cron=%s err=%v", spec, err)
	}
	log.Printf("backup scheduler started cron=%s dir=%s", spec, backupDir())
}
