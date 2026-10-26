package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/fzheng466/infinite-canvas/model"
	"github.com/fzheng466/infinite-canvas/repository"
)

func canvasReferencePayload(t *testing.T, id, updatedAt string, extra any) json.RawMessage {
	t.Helper()
	payload := map[string]any{
		"id": id, "createdAt": "2026-09-29T00:00:00Z", "updatedAt": updatedAt,
		"nodes": []any{}, "extra": extra,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func saveCanvasReferenceObject(t *testing.T, id, owner, status string) {
	t.Helper()
	_, err := repository.SaveStorageObject(model.StorageObject{
		ID: id, ProviderID: "local", ObjectKey: fmt.Sprintf("canvas-reference/%s", id),
		CreatedBy: owner, Status: status, CreatedAt: "2026-09-29T00:00:00Z",
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestSaveCurrentUserCanvasProjectReferenceOwnership(t *testing.T) {
	const userID = "canvas-reference-owner-0729"
	ctx := WithUser(context.Background(), model.AuthUser{ID: userID, Role: model.UserRoleUser})
	saveCanvasReferenceObject(t, "canvas-ref-owned-0729", userID, "active")
	saveCanvasReferenceObject(t, "canvas-ref-foreign-0729", "canvas-reference-other-0729", "active")
	saveCanvasReferenceObject(t, "canvas-ref-trash-0729", userID, "trash")

	tests := []struct {
		name     string
		objectID string
		category string
	}{
		{name: "owned active allowed", objectID: "canvas-ref-owned-0729"},
		{name: "foreign new rejected", objectID: "canvas-ref-foreign-0729", category: "foreign_owner"},
		{name: "missing rejected", objectID: "canvas-ref-missing-0729", category: "missing"},
		{name: "trashed rejected", objectID: "canvas-ref-trash-0729", category: "trash"},
	}
	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			projectID := fmt.Sprintf("canvas-ref-table-0729-%d", index)
			raw := canvasReferencePayload(t, projectID, "2026-09-29T01:00:00Z", map[string]any{"storageKey": "server:" + test.objectID})
			_, err := SaveCurrentUserCanvasProject(ctx, raw)
			if test.category == "" {
				if err != nil {
					t.Fatalf("save failed: %v", err)
				}
				return
			}
			var referenceError *ProjectReferenceError
			if !errors.As(err, &referenceError) || referenceError.Category != test.category || referenceError.ObjectID != test.objectID {
				t.Fatalf("expected %s/%s, got %T %v", test.category, test.objectID, err, err)
			}
		})
	}
}

func TestStaleSaveDoesNotPoisonStoredProjectRefCache(t *testing.T) {
	resetStoredProjectRefCache()
	t.Cleanup(resetStoredProjectRefCache)

	const userID = "canvas-cache-poison-owner"
	const ownedID = "canvas-cache-poison-owned"
	const foreignID = "canvas-cache-poison-foreign"
	const projectID = "canvas-cache-poison-project"
	ctx := WithUser(context.Background(), model.AuthUser{ID: userID, Role: model.UserRoleUser})
	saveCanvasReferenceObject(t, ownedID, userID, "active")
	saveCanvasReferenceObject(t, foreignID, "canvas-cache-poison-other", "active")

	first := canvasReferencePayload(t, projectID, "2026-09-29T01:00:00Z", map[string]any{"storageKey": "server:" + ownedID})
	if _, err := SaveCurrentUserCanvasProject(ctx, first); err != nil {
		t.Fatalf("seed save failed: %v", err)
	}

	stale := canvasReferencePayload(t, projectID, "2026-09-29T00:59:00Z", map[string]any{"storageKey": "server:" + foreignID})
	if _, err := SaveCurrentUserCanvasProject(ctx, stale); err == nil {
		t.Fatal("stale save with older updatedAt should not succeed")
	}

	retry := canvasReferencePayload(t, projectID, "2026-09-29T02:00:00Z", map[string]any{"storageKey": "server:" + foreignID})
	_, err := SaveCurrentUserCanvasProject(ctx, retry)
	var referenceError *ProjectReferenceError
	if !errors.As(err, &referenceError) || referenceError.Category != "foreign_owner" || referenceError.ObjectID != foreignID {
		t.Fatalf("expected foreign_owner after stale save, got %T %v", err, err)
	}
}

func TestStoredProjectRefCacheHitsSameVersion(t *testing.T) {
	resetStoredProjectRefCache()
	t.Cleanup(resetStoredProjectRefCache)

	stored := &model.CanvasProject{
		UserID: "cache-owner", ID: "cache-project", UpdatedAt: "2026-10-19T00:00:00Z",
		ProjectData: `{"id":"cache-project","storageKey":"server:obj-cached"}`,
	}
	first, err := extractStoredProjectReferences(stored)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := first["obj-cached"]; !ok {
		t.Fatalf("missing ref: %v", first)
	}
	stored.ProjectData = `{"id":"cache-project","storageKey":"server:obj-should-not-be-parsed"}`
	second, err := extractStoredProjectReferences(stored)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := second["obj-cached"]; !ok {
		t.Fatal("same updatedAt should reuse cached refs")
	}
	if _, ok := second["obj-should-not-be-parsed"]; ok {
		t.Fatal("cache hit parsed the mutated JSON")
	}

	stored.UpdatedAt = "2026-10-19T00:00:01Z"
	third, err := extractStoredProjectReferences(stored)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := third["obj-should-not-be-parsed"]; !ok {
		t.Fatal("new updatedAt must parse fresh JSON")
	}
}

func TestCanvasProjectHistoricalReferencesAndExtraction(t *testing.T) {
	const (
		userID    = "canvas-history-owner-0729"
		foreignID = "canvas-history-foreign-0729"
	)
	ctx := WithUser(context.Background(), model.AuthUser{ID: userID, Role: model.UserRoleUser})
	saveCanvasReferenceObject(t, foreignID, "canvas-history-other-0729", "active")

	tests := []struct {
		name       string
		projectID  string
		oldExtra   any
		newExtra   any
		shouldFail bool
	}{
		{
			name: "historical foreign retained", projectID: "canvas-history-retain-0729",
			oldExtra: map[string]any{"storageKey": "server:" + foreignID},
			newExtra: map[string]any{"nested": []any{map[string]any{"storageKey": "server:" + foreignID}}},
		},
		{
			name: "historical foreign removed", projectID: "canvas-history-remove-0729",
			oldExtra: map[string]any{"storageKey": "server:" + foreignID}, newExtra: map[string]any{},
		},
		{
			name: "nested foreign detected", projectID: "canvas-history-nested-0729",
			oldExtra:   map[string]any{},
			newExtra:   map[string]any{"a": []any{map[string]any{"b": map[string]any{"storageKey": "server:" + foreignID}}}},
			shouldFail: true,
		},
		{
			name: "webdav and local skipped", projectID: "canvas-history-local-0729",
			oldExtra: map[string]any{},
			newExtra: []any{map[string]any{"storageKey": "server:webdav:remote-key"}, map[string]any{"storageKey": "image:local-key"}},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			oldRaw := canvasReferencePayload(t, test.projectID, "2026-09-29T01:00:00Z", test.oldExtra)
			oldProject, err := canvasProjectFromRaw(userID, oldRaw)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := repository.SaveUserCanvasProject(oldProject); err != nil {
				t.Fatal(err)
			}
			newRaw := canvasReferencePayload(t, test.projectID, "2026-09-29T02:00:00Z", test.newExtra)
			_, err = SaveCurrentUserCanvasProject(ctx, newRaw)
			var referenceError *ProjectReferenceError
			if test.shouldFail {
				if !errors.As(err, &referenceError) || referenceError.Category != "foreign_owner" || referenceError.ObjectID != foreignID {
					t.Fatalf("expected nested foreign rejection, got %T %v", err, err)
				}
			} else if err != nil {
				t.Fatalf("save failed: %v", err)
			}
		})
	}
}

func TestSyncCurrentUserCanvasProjectsReferenceOwnership(t *testing.T) {
	const userID = "canvas-sync-owner-0729"
	ctx := WithUser(context.Background(), model.AuthUser{ID: userID, Role: model.UserRoleUser})
	saveCanvasReferenceObject(t, "canvas-sync-owned-0729", userID, "active")
	saveCanvasReferenceObject(t, "canvas-sync-foreign-0729", "canvas-sync-other-0729", "active")

	owned := canvasReferencePayload(t, "canvas-sync-owned-project-0729", "2026-09-29T01:00:00Z", map[string]any{"storageKey": "server:canvas-sync-owned-0729"})
	if _, err := SyncCurrentUserCanvasProjects(ctx, []json.RawMessage{owned}); err != nil {
		t.Fatalf("owned sync failed: %v", err)
	}
	foreign := canvasReferencePayload(t, "canvas-sync-foreign-project-0729", "2026-09-29T01:00:00Z", map[string]any{"storageKey": "server:canvas-sync-foreign-0729"})
	_, err := SyncCurrentUserCanvasProjects(ctx, []json.RawMessage{foreign})
	var referenceError *ProjectReferenceError
	if !errors.As(err, &referenceError) || referenceError.Category != "foreign_owner" || referenceError.ObjectID != "canvas-sync-foreign-0729" {
		t.Fatalf("expected sync foreign rejection, got %T %v", err, err)
	}
}
