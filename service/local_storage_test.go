package service

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/fzheng466/infinite-canvas/config"
	"github.com/fzheng466/infinite-canvas/model"
)

func TestLocalStorageAtomicWritePathValidationAndRange(t *testing.T) {
	root := t.TempDir()
	provider := model.StorageProvider{ID: "local", Type: model.StorageProviderTypeLocal, Endpoint: root}
	spool := filepath.Join(t.TempDir(), "image.png")
	if err := os.WriteFile(spool, []byte("0123456789"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := putLocalStorageFile(provider, "user/task/image.png", spool); err != nil {
		t.Fatal(err)
	}
	stored, err := os.ReadFile(filepath.Join(root, "user", "task", "image.png"))
	if err != nil || string(stored) != "0123456789" {
		t.Fatalf("stored data = %q, err=%v", stored, err)
	}
	if err := putLocalStorageFile(provider, "../escape.png", spool); err == nil {
		t.Fatal("path traversal should be rejected")
	}
	stream, err := getLocalStorageStream(provider, "user/task/image.png", 10, "bytes=2-5")
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Body.Close()
	data, _ := io.ReadAll(stream.Body)
	if stream.StatusCode != http.StatusPartialContent || stream.ContentRange != "bytes 2-5/10" || string(data) != "2345" {
		t.Fatalf("unexpected range response: status=%d range=%q data=%q", stream.StatusCode, stream.ContentRange, data)
	}
}

func TestStorageObjectReadAuthorization(t *testing.T) {
	previous := config.Cfg.LegacyPublicFilesEnabled
	defer func() { config.Cfg.LegacyPublicFilesEnabled = previous }()
	config.Cfg.LegacyPublicFilesEnabled = false
	object := model.StorageObject{CreatedBy: "user-a"}
	if err := authorizeStorageObjectRead(WithUser(context.Background(), model.AuthUser{ID: "user-a", Role: model.UserRoleUser}), object); err != nil {
		t.Fatalf("owner should read: %v", err)
	}
	if err := authorizeStorageObjectRead(WithUser(context.Background(), model.AuthUser{ID: "user-b", Role: model.UserRoleUser}), object); err == nil {
		t.Fatal("user B must not read user A object")
	}
	if err := authorizeStorageObjectRead(WithUser(context.Background(), model.AuthUser{ID: "admin", Role: model.UserRoleAdmin}), object); err != nil {
		t.Fatalf("admin should read: %v", err)
	}
	if err := authorizeStorageObjectRead(context.Background(), object); err == nil {
		t.Fatal("anonymous read must be denied by default")
	}
	config.Cfg.LegacyPublicFilesEnabled = true
	if err := authorizeStorageObjectRead(context.Background(), object); err != nil {
		t.Fatalf("legacy public feature flag should permit read: %v", err)
	}
}
