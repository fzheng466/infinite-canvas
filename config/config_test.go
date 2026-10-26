package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNormalizeDockerSQLiteDSNUsesMountedDataDir(t *testing.T) {
	root := t.TempDir()
	appDataDir := filepath.Join(root, "data")
	if err := os.MkdirAll(appDataDir, 0755); err != nil {
		t.Fatal(err)
	}
	Cfg = Config{StorageDriver: "sqlite", DatabaseDSN: "data/infinite-canvas.db?_pragma=busy_timeout(5000)"}

	normalizeDockerSQLiteDSN(appDataDir)

	want := filepath.Join(root, "data", "infinite-canvas.db") + "?_pragma=busy_timeout(5000)"
	if Cfg.DatabaseDSN != want {
		t.Fatalf("DatabaseDSN = %q, want %q", Cfg.DatabaseDSN, want)
	}
}

func TestLegacyPublicBaseURLFillsPublicOriginWhenUnset(t *testing.T) {
	t.Setenv("PUBLIC_ORIGIN", "")
	os.Unsetenv("PUBLIC_ORIGIN")
	t.Setenv("PUBLIC_BASE_URL", "http://127.0.0.1:3200/canvas")
	Cfg = Config{PublicOrigin: "http://127.0.0.1:3100"}

	applyLegacyPublicBaseURL()

	if Cfg.PublicOrigin != "http://127.0.0.1:3200" {
		t.Fatalf("PublicOrigin = %q, want http://127.0.0.1:3200", Cfg.PublicOrigin)
	}
}

func TestExplicitPublicOriginWinsOverLegacyPublicBaseURL(t *testing.T) {
	t.Setenv("PUBLIC_ORIGIN", "https://canvas.example.com")
	t.Setenv("PUBLIC_BASE_URL", "http://127.0.0.1:3200")
	Cfg = Config{PublicOrigin: "https://canvas.example.com"}

	applyLegacyPublicBaseURL()

	if Cfg.PublicOrigin != "https://canvas.example.com" {
		t.Fatalf("PublicOrigin = %q, want explicit PUBLIC_ORIGIN", Cfg.PublicOrigin)
	}
}

func TestNormalizeDockerSQLiteDSNLeavesLocalPathWithoutMountedDataDir(t *testing.T) {
	Cfg = Config{StorageDriver: "sqlite", DatabaseDSN: "data/infinite-canvas.db"}

	normalizeDockerSQLiteDSN(filepath.Join(t.TempDir(), "missing-data"))

	if Cfg.DatabaseDSN != "data/infinite-canvas.db" {
		t.Fatalf("DatabaseDSN = %q, want relative local path", Cfg.DatabaseDSN)
	}
}
