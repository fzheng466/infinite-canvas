package config

import (
	"crypto/rand"
	"encoding/base64"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/caarlos0/env/v11"
	"github.com/joho/godotenv"
)

type Config struct {
	Port                     string `env:"PORT" envDefault:"8080"`
	AdminUsername            string `env:"ADMIN_USERNAME" envDefault:"admin"`
	AdminPassword            string `env:"ADMIN_PASSWORD" envDefault:"infinite-canvas"`
	JWTSecret                string `env:"JWT_SECRET" envDefault:"infinite-canvas"`
	JWTExpireHours           int    `env:"JWT_EXPIRE_HOURS" envDefault:"168"`
	PublicOrigin             string `env:"PUBLIC_ORIGIN" envDefault:"http://127.0.0.1:3100"`
	JWTIssuer                string `env:"JWT_ISSUER" envDefault:"infinite-canvas"`
	JWTAudience              string `env:"JWT_AUDIENCE" envDefault:"canvas-web"`
	StorageDriver            string `env:"STORAGE_DRIVER" envDefault:"sqlite"`
	DatabaseDSN              string `env:"DATABASE_DSN" envDefault:"data/infinite-canvas.db"`
	LinuxDoAuthorizeURL      string `env:"LINUX_DO_AUTHORIZE_URL" envDefault:"https://connect.linux.do/oauth2/authorize"`
	LinuxDoTokenURL          string `env:"LINUX_DO_TOKEN_URL" envDefault:"https://connect.linux.do/oauth2/token"`
	LinuxDoUserInfoURL       string `env:"LINUX_DO_USERINFO_URL" envDefault:"https://connect.linux.do/api/user"`
	AILogDir                 string `env:"AI_LOG_DIR" envDefault:"data/logs/ai-calls"`
	LocalStorageEnabled      bool   `env:"LOCAL_STORAGE_ENABLED" envDefault:"false"`
	BackupEnabled            bool   `env:"BACKUP_ENABLED" envDefault:"false"`
	BackupDir                string `env:"BACKUP_DIR" envDefault:""`
	BackupCron               string `env:"BACKUP_CRON" envDefault:"30 3 * * *"`
	BackupRetainDays         int    `env:"BACKUP_RETAIN_DAYS" envDefault:"7"`
	LocalStorageDir          string `env:"LOCAL_STORAGE_DIR" envDefault:"data/test-storage"`
	StorageSpoolDir          string `env:"STORAGE_SPOOL_DIR" envDefault:"data/storage-spool"`
	StorageMaxImageBytes     int64  `env:"STORAGE_MAX_IMAGE_BYTES" envDefault:"33554432"`
	StorageSpoolMaxBytes     int64  `env:"STORAGE_SPOOL_MAX_BYTES" envDefault:"1073741824"`
	StorageSpoolTTLHours     int    `env:"STORAGE_SPOOL_TTL_HOURS" envDefault:"24"`
	FileURLTTLSeconds        int    `env:"FILE_URL_TTL_SECONDS" envDefault:"300"`
	AutoMigrateEnabled       bool   `env:"AUTO_MIGRATE_ENABLED" envDefault:"true"`
	LegacyPublicFilesEnabled bool   `env:"LEGACY_PUBLIC_FILES_ENABLED" envDefault:"false"`
	// TrustedDownloadHosts 允许服务端持久化下载访问的内网/本机主机名，
	// 供同机自建网关(返回 127.0.0.1 链接)等合法场景显式放行；默认为空。
	TrustedDownloadHosts string `env:"STORAGE_TRUSTED_DOWNLOAD_HOSTS" envDefault:""`
}

var Cfg Config

func Load() error {
	_ = godotenv.Load()
	if err := env.Parse(&Cfg); err != nil {
		return err
	}
	applyLegacyPublicBaseURL()
	normalizeDockerSQLiteDSN("/app/data")
	if strings.TrimSpace(Cfg.JWTSecret) == "" || Cfg.JWTSecret == "infinite-canvas" {
		secret, err := randomSecret()
		if err != nil {
			return err
		}
		Cfg.JWTSecret = secret
	}
	return nil
}

// applyLegacyPublicBaseURL 兼容旧注释里写错的 PUBLIC_BASE_URL：只有未显式设置 PUBLIC_ORIGIN 时才生效，
// 且只取 scheme://host（PUBLIC_ORIGIN 不允许带路径）。CSRF 同源策略本身不变。
func applyLegacyPublicBaseURL() {
	if _, ok := os.LookupEnv("PUBLIC_ORIGIN"); ok {
		return
	}
	legacy := strings.TrimSpace(os.Getenv("PUBLIC_BASE_URL"))
	if legacy == "" {
		return
	}
	parsed, err := url.Parse(legacy)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		log.Printf("忽略无效的 PUBLIC_BASE_URL=%q，请改用 PUBLIC_ORIGIN", legacy)
		return
	}
	Cfg.PublicOrigin = parsed.Scheme + "://" + parsed.Host
	log.Printf("PUBLIC_BASE_URL 已废弃，请改用 PUBLIC_ORIGIN；当前按 PUBLIC_ORIGIN=%s 生效", Cfg.PublicOrigin)
}

func normalizeDockerSQLiteDSN(appDataDir string) {
	driver := strings.ToLower(strings.TrimSpace(Cfg.StorageDriver))
	if driver != "" && driver != "sqlite" {
		return
	}
	dsn := strings.TrimSpace(Cfg.DatabaseDSN)
	if dsn == "" || dsn == ":memory:" || strings.HasPrefix(dsn, "file:") {
		return
	}
	pathPart, suffix := dsn, ""
	if index := strings.Index(dsn, "?"); index >= 0 {
		pathPart = dsn[:index]
		suffix = dsn[index:]
	}
	if filepath.IsAbs(pathPart) {
		return
	}
	slashPath := filepath.ToSlash(pathPart)
	if slashPath != "data" && !strings.HasPrefix(slashPath, "data/") {
		return
	}
	if _, err := os.Stat(appDataDir); err != nil {
		return
	}
	Cfg.DatabaseDSN = filepath.Join(filepath.Dir(appDataDir), filepath.FromSlash(slashPath)) + suffix
}

func randomSecret() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
