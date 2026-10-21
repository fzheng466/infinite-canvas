package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"strings"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/handler"
	"github.com/tigerowo/infinite-canvas/isolation"
	"github.com/tigerowo/infinite-canvas/router"
	"github.com/tigerowo/infinite-canvas/service"
)

func main() {
	if err := config.Load(); err != nil {
		log.Fatal(err)
	}
	if handled, err := runIsolationCLI(context.Background(), os.Args[1:], os.Stdout); handled {
		if err != nil {
			log.Fatal(err)
		}
		return
	}
	if err := service.EnsureDefaultAdmin(); err != nil {
		log.Fatal(err)
	}
	if err := service.EnsureDefaultAgentSkills(); err != nil {
		log.Fatal(err)
	}
	service.StartPromptSyncScheduler()
	service.StartCanvasProjectCleanupScheduler()
	service.StartStorageTransferWorker()
	service.StartBackupScheduler()
	handler.StartVideoTaskPoller()
	log.Fatal(router.New().Run(":" + config.Cfg.Port))
}

func runIsolationCLI(ctx context.Context, args []string, stdout io.Writer) (bool, error) {
	if len(args) == 0 || (args[0] != "audit-isolation" && args[0] != "repair-isolation") {
		return false, nil
	}
	command := args[0]
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	dbPath := flags.String("db", config.Cfg.DatabaseDSN, "SQLite database path")
	outPath := flags.String("out", "", "JSON output path")
	planPath := flags.String("plan", "", "repair plan JSON path")
	dryRun := flags.Bool("dry-run", true, "validate without changing the database")
	backupDir := flags.String("backup-dir", "", "backup directory")
	if err := flags.Parse(args[1:]); err != nil {
		return true, err
	}
	if flags.NArg() != 0 {
		return true, fmt.Errorf("unexpected positional arguments: %s", strings.Join(flags.Args(), " "))
	}
	writer := stdout
	var output *os.File
	if *outPath != "" {
		var err error
		output, err = os.OpenFile(*outPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
		if err != nil {
			return true, err
		}
		defer output.Close()
		writer = output
	}
	if command == "audit-isolation" {
		db, err := isolation.OpenSQLite(*dbPath, true)
		if err != nil {
			return true, err
		}
		defer db.Close()
		report, err := isolation.Audit(ctx, db)
		if err != nil {
			return true, err
		}
		return true, isolation.WriteJSON(writer, report)
	}
	if strings.TrimSpace(*planPath) == "" {
		return true, errors.New("--plan is required")
	}
	planFile, err := os.Open(*planPath)
	if err != nil {
		return true, err
	}
	plan, err := isolation.DecodePlan(planFile)
	planFile.Close()
	if err != nil {
		return true, err
	}
	db, err := isolation.OpenSQLite(*dbPath, false)
	if err != nil {
		return true, err
	}
	defer db.Close()
	result, err := isolation.Repair(ctx, db, *dbPath, *backupDir, plan, *dryRun)
	if err != nil {
		return true, err
	}
	return true, isolation.WriteJSON(writer, result)
}
