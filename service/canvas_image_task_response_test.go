package service

import (
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestCanvasImageTaskResponseHidesUnpublishedUpstreamURL(t *testing.T) {
	task := model.CanvasImageTask{
		ID:                "response-pending",
		Status:            "completed",
		PersistenceStatus: model.PersistenceStatusPending,
		ImageURL:          "https://cdn.aipaiai.cn/api/image/result/secret",
		ImageURLs:         []string{"https://cdn.aipaiai.cn/api/image/result/secret"},
		StorageKey:        "",
	}
	response := CanvasImageTaskResponse(task)
	for _, key := range []string{"url", "image_url", "image_urls", "storageKey"} {
		if value, ok := response[key]; ok && strings.Contains(toResponseString(value), "cdn.aipaiai.cn") {
			t.Fatalf("response leaked upstream URL in %s: %#v", key, value)
		}
	}
	if _, ok := response["url"]; ok {
		t.Fatalf("pending task must not publish url: %#v", response["url"])
	}
}

func TestCanvasImageTaskResponsePublishesOnlyServerObject(t *testing.T) {
	task := model.CanvasImageTask{
		ID:                "response-complete",
		Status:            "completed",
		PersistenceStatus: model.PersistenceStatusCompleted,
		ImageURL:          "/api/files/object-1/content",
		ImageURLs:         []string{"/api/files/object-1/content"},
		StorageKey:        "server:object-1",
	}
	response := CanvasImageTaskResponse(task)
	if response["url"] != "/api/files/object-1/content" || response["storageKey"] != "server:object-1" {
		t.Fatalf("published server object missing: %#v", response)
	}
}

func toResponseString(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}
