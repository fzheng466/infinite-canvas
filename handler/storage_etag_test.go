package handler

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestStorageObjectETagIncludesOwner(t *testing.T) {
	etag := storageObjectETag(model.StorageObject{ID: "obj-1", SHA256: "abc", CreatedBy: "user-a"})
	if etag != `"user-a:abc"` {
		t.Fatalf("etag = %s", etag)
	}
	other := storageObjectETag(model.StorageObject{ID: "obj-1", SHA256: "abc", CreatedBy: "user-b"})
	if etag == other {
		t.Fatal("different owners must not share an ETag")
	}
}

func TestPrivateFileCacheHeaders(t *testing.T) {
	rec := httptest.NewRecorder()
	setPrivateFileCacheHeaders(rec)
	if rec.Header().Get("Cache-Control") != privateFileCacheControl {
		t.Fatalf("Cache-Control = %q", rec.Header().Get("Cache-Control"))
	}
	vary := rec.Header().Values("Vary")
	joined := strings.Join(vary, ",")
	if !strings.Contains(joined, "Authorization") || !strings.Contains(joined, "Cookie") {
		t.Fatalf("Vary = %v", vary)
	}
}
