package repository

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/libtnb/sqlite"
	mysqldriver "github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/fzheng466/infinite-canvas/config"
	"github.com/fzheng466/infinite-canvas/model"
	gormmysql "gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

var promptCategories = []model.PromptCategory{
	{Category: "system", Name: "系统", Description: "系统提示词分类"},
	{Category: "gpt-image-2-prompts", Name: "GPT Image 2 Prompts", Description: "TigerOWO 的 GPT Image 2 案例提示词分类", GithubURL: "https://github.com/tigerowo/awesome-gpt-image-2-prompts", Remote: true},
	{Category: "awesome-gpt-image", Name: "Awesome GPT Image", Description: "ZeroLu 的中文 GPT Image 提示词分类", GithubURL: "https://github.com/ZeroLu/awesome-gpt-image", Remote: true},
	{Category: "awesome-gpt4o-image-prompts", Name: "Awesome GPT4o Image Prompts", Description: "ImgEdify 的 GPT-4o 图像提示词分类", GithubURL: "https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts", Remote: true},
	{Category: "xianyu-awesome-gptimage2", Name: "Xianyu Awesome GPT Image 2", Description: "xianyu110 的 GPT Image 2 提示词分类", GithubURL: "https://github.com/xianyu110/awesome-gptimage2", Remote: true},
	{Category: "youmind-gpt-image-2", Name: "YouMind GPT Image 2", Description: "YouMind OpenLab 的 GPT Image 2 中文提示词分类", GithubURL: "https://github.com/YouMind-OpenLab/awesome-gpt-image-2", Remote: true},
	{Category: "youmind-nano-banana-pro", Name: "YouMind Nano Banana Pro", Description: "YouMind OpenLab 的 Nano Banana Pro 中文提示词分类", GithubURL: "https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts", Remote: true},
	{Category: "davidwu-gpt-image2-prompts", Name: "awesome-gpt-image2-prompts", Description: "davidwuw0811-boop 整理的 GPT Image 2 提示词分类", GithubURL: "https://github.com/davidwuw0811-boop/awesome-gpt-image2-prompts", Remote: true},
}

var (
	db     *gorm.DB
	dbOnce sync.Once
	dbErr  error
)

type schemaMigration struct {
	Version   int `gorm:"primaryKey"`
	AppliedAt string
}

func runSchemaMigrations(database *gorm.DB, allowDDL bool) error {
	if allowDDL {
		if err := database.AutoMigrate(&schemaMigration{}); err != nil {
			return err
		}
	} else if !database.Migrator().HasTable(&schemaMigration{}) {
		return errors.New("database schema is not initialized; enable AUTO_MIGRATE_ENABLED for migration")
	}
	var count int64
	if err := database.Model(&schemaMigration{}).Where("version = ?", 1).Count(&count).Error; err != nil {
		return err
	}
	if count != 0 {
		return nil
	}
	return database.Transaction(func(tx *gorm.DB) error {
		if tx.Migrator().HasTable(&model.StorageObject{}) {
			if err := tx.Model(&model.StorageObject{}).Where("status IS NULL OR status = ''").Update("status", "active").Error; err != nil {
				return err
			}
		}
		return tx.Create(&schemaMigration{Version: 1, AppliedAt: time.Now().UTC().Format(time.RFC3339Nano)}).Error
	})
}

// DB 初始化并返回全局数据库连接。
func DB() (*gorm.DB, error) {
	dbOnce.Do(func() {
		driver := strings.ToLower(strings.TrimSpace(config.Cfg.StorageDriver))
		if driver == "" {
			driver = "sqlite"
		}
		dsn := config.Cfg.DatabaseDSN
		if driver == "sqlite" && dsn != ":memory:" {
			_ = os.MkdirAll(filepath.Dir(dsn), 0755)
		}
		if isPostgresDriver(driver) {
			dbErr = ensurePostgresDatabase(dsn)
			if dbErr != nil {
				return
			}
		}
		if driver == "mysql" {
			dbErr = ensureMySQLDatabase(dsn)
			if dbErr != nil {
				return
			}
		}
		db, dbErr = gorm.Open(dialector(driver, dsn), gormSessionConfig())
		if dbErr != nil {
			return
		}
		if !config.Cfg.AutoMigrateEnabled {
			dbErr = runSchemaMigrations(db, false)
			return
		}
		dbErr = db.AutoMigrate(
			&model.User{},
			&model.CreditLog{},
			&model.Prompt{},
			&model.AgentSkill{},
			&model.AgentSkillFile{},
			&model.Asset{},
			&model.Setting{},
			&model.CreativeWorkflow{},
			&model.UserConfig{},
			&model.AICallLog{},
			&model.StorageObject{},
			&model.VideoTask{},
			&model.VideoGenerationLog{},
			&model.ImageGenerationLog{},
			&model.CanvasImageTask{},
			&model.GeneratedImageOutput{},
			&model.StorageTransferJob{},
			&model.CanvasAudioTask{},
			&model.CanvasProject{},
		)
		if dbErr == nil {
			dbErr = runSchemaMigrations(db, true)
		}
	})
	return db, dbErr
}

func dialector(driver string, dsn string) gorm.Dialector {
	switch driver {
	case "mysql":
		return gormmysql.Open(dsn)
	case "postgres", "postgresql":
		return postgres.Open(dsn)
	default:
		return sqlite.Open(withSQLitePragmas(dsn))
	}
}

// gormSessionConfig 收敛生产日志：慢查询阈值 1s、Warn 级、参数化输出。
// 默认 logger 会把整条 SQL 连同几百 KB 的参数（如 canvas_projects.project_data）打进 stdout。
func gormSessionConfig() *gorm.Config {
	return &gorm.Config{
		Logger: logger.New(log.New(os.Stdout, "\r\n", log.LstdFlags), logger.Config{
			SlowThreshold:             time.Second,
			LogLevel:                  logger.Warn,
			IgnoreRecordNotFoundError: true,
			ParameterizedQueries:      true,
		}),
	}
}

// sqlitePragmas 高频写入下的稳定性配置：
// WAL 让读写不再互斥（未开启时生成高峰期任务创建直接 SQLITE_BUSY），
// busy_timeout 让写锁冲突等待而不是立刻失败，synchronous(NORMAL) 是 WAL 推荐档位。
const sqlitePragmas = "_pragma=journal_mode(WAL)&_pragma=busy_timeout(15000)&_pragma=synchronous(NORMAL)&_pragma=cache_size(-20000)"

// withSQLitePragmas 为 SQLite DSN 注入稳定性 pragma。
// DSN 里已有的同名 pragma 不重复注入；纯路径会转成 file: URI 以支持查询参数。
func withSQLitePragmas(dsn string) string {
	trimmed := strings.TrimSpace(dsn)
	if trimmed == "" || trimmed == ":memory:" {
		return dsn
	}
	needed := make([]string, 0, 5)
	for _, pragma := range strings.Split(sqlitePragmas, "&") {
		name := strings.SplitN(strings.TrimPrefix(pragma, "_pragma="), "(", 2)[0]
		if !strings.Contains(trimmed, "_pragma="+name+"(") {
			needed = append(needed, pragma)
		}
	}
	// BEGIN IMMEDIATE：写事务开始时就拿写锁，避免锁升级失败留下的"事务中套事务"残留连接。
	if !strings.Contains(trimmed, "_txlock=") {
		needed = append(needed, "_txlock=immediate")
	}
	if len(needed) == 0 {
		return dsn
	}
	if strings.Contains(trimmed, "?") {
		return trimmed + "&" + strings.Join(needed, "&")
	}
	if !strings.HasPrefix(trimmed, "file:") {
		trimmed = "file:" + filepath.ToSlash(trimmed)
	}
	return trimmed + "?" + strings.Join(needed, "&")
}

func isPostgresDriver(driver string) bool {
	return driver == "postgres" || driver == "postgresql"
}

func ensureMySQLDatabase(dsn string) error {
	cfg, err := mysqldriver.ParseDSN(dsn)
	if err != nil {
		return err
	}
	target := strings.TrimSpace(cfg.DBName)
	if target == "" {
		return nil
	}
	ctx := context.Background()
	targetDB, err := sql.Open("mysql", dsn)
	if err != nil {
		return err
	}
	err = targetDB.PingContext(ctx)
	_ = targetDB.Close()
	if err == nil {
		return nil
	}
	if !isMySQLError(err, 1049) {
		return err
	}

	maintenance := cfg.Clone()
	maintenance.DBName = ""
	serverDB, err := sql.Open("mysql", maintenance.FormatDSN())
	if err != nil {
		return err
	}
	defer serverDB.Close()

	_, err = serverDB.ExecContext(ctx, "CREATE DATABASE "+quoteMySQLIdentifier(target)+" CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
	if isMySQLError(err, 1007) {
		return nil
	}
	return err
}

func ensurePostgresDatabase(dsn string) error {
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		return err
	}
	target := strings.TrimSpace(cfg.Database)
	if target == "" {
		return nil
	}
	ctx := context.Background()
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err == nil {
		_ = conn.Close(ctx)
		return nil
	}
	if !isPostgresError(err, "3D000") {
		return err
	}

	maintenance := cfg.Copy()
	maintenance.Database = "postgres"
	if strings.EqualFold(target, "postgres") {
		maintenance.Database = "template1"
	}
	conn, err = pgx.ConnectConfig(ctx, maintenance)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)

	_, err = conn.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{target}.Sanitize(), pgx.QueryExecModeExec)
	if isPostgresError(err, "42P04") {
		return nil
	}
	return err
}

func isMySQLError(err error, number uint16) bool {
	var mysqlErr *mysqldriver.MySQLError
	return errors.As(err, &mysqlErr) && mysqlErr.Number == number
}

func isPostgresError(err error, code string) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == code
}

func quoteMySQLIdentifier(name string) string {
	return "`" + strings.ReplaceAll(name, "`", "``") + "`"
}
