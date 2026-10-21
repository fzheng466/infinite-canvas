package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

type canvasProjectMetadata struct {
	ID        string `json:"id"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

const (
	canvasProjectMaxReferenceDepth = 64
	canvasProjectMaxReferences     = 10000
)

var (
	canvasProjectStorageKeyPattern = regexp.MustCompile(`^server:([A-Za-z0-9][A-Za-z0-9._-]*)$`)
	canvasProjectFileURLPattern    = regexp.MustCompile(`(?:^|/)api/files/([^/?#]+)/content(?:[?#]|$)`)
)

type ProjectReferenceError struct {
	Category string
	ObjectID string
}

func (e *ProjectReferenceError) Error() string {
	return fmt.Sprintf("画布引用的存储对象不可用: category=%s object=%s", e.Category, e.ObjectID)
}

func (e *ProjectReferenceError) SafeMessage() string {
	switch e.Category {
	case "foreign_owner":
		return "画布引用了不属于当前账号的文件"
	case "trash":
		return "画布引用的文件已在回收站中"
	default:
		return "画布引用的文件不存在"
	}
}

const storedProjectRefCacheLimit = 64

type storedProjectRefCacheEntry struct {
	key  string
	refs map[string]struct{}
}

var storedProjectRefCache = struct {
	mu      sync.Mutex
	entries []storedProjectRefCacheEntry
}{}

func storedProjectRefCacheKey(userID, projectID, updatedAt string) string {
	return userID + "\x00" + projectID + "\x00" + updatedAt
}

func lookupStoredProjectRefs(userID, projectID, updatedAt string) (map[string]struct{}, bool) {
	key := storedProjectRefCacheKey(userID, projectID, updatedAt)
	storedProjectRefCache.mu.Lock()
	defer storedProjectRefCache.mu.Unlock()
	for i, entry := range storedProjectRefCache.entries {
		if entry.key != key {
			continue
		}
		if i != len(storedProjectRefCache.entries)-1 {
			storedProjectRefCache.entries = append(append(storedProjectRefCache.entries[:i], storedProjectRefCache.entries[i+1:]...), entry)
		}
		return entry.refs, true
	}
	return nil, false
}

func resetStoredProjectRefCache() {
	storedProjectRefCache.mu.Lock()
	storedProjectRefCache.entries = nil
	storedProjectRefCache.mu.Unlock()
}

func rememberStoredProjectRefs(userID, projectID, updatedAt string, refs map[string]struct{}) {
	key := storedProjectRefCacheKey(userID, projectID, updatedAt)
	storedProjectRefCache.mu.Lock()
	defer storedProjectRefCache.mu.Unlock()
	for i, entry := range storedProjectRefCache.entries {
		if entry.key == key {
			storedProjectRefCache.entries = append(storedProjectRefCache.entries[:i], storedProjectRefCache.entries[i+1:]...)
			break
		}
	}
	storedProjectRefCache.entries = append(storedProjectRefCache.entries, storedProjectRefCacheEntry{key: key, refs: refs})
	if len(storedProjectRefCache.entries) > storedProjectRefCacheLimit {
		storedProjectRefCache.entries = storedProjectRefCache.entries[len(storedProjectRefCache.entries)-storedProjectRefCacheLimit:]
	}
}

func extractStoredProjectReferences(stored *model.CanvasProject) (map[string]struct{}, error) {
	if stored == nil || strings.TrimSpace(stored.ProjectData) == "" {
		return map[string]struct{}{}, nil
	}
	if refs, ok := lookupStoredProjectRefs(stored.UserID, stored.ID, stored.UpdatedAt); ok {
		return refs, nil
	}
	refs, _, err := extractCanvasProjectReferences(json.RawMessage(stored.ProjectData))
	if err != nil {
		return nil, errors.New("服务器画布项目数据无效")
	}
	rememberStoredProjectRefs(stored.UserID, stored.ID, stored.UpdatedAt, refs)
	return refs, nil
}

func extractCanvasProjectReferences(raw json.RawMessage) (map[string]struct{}, map[string]struct{}, error) {
	var root any
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	if err := decoder.Decode(&root); err != nil {
		return nil, nil, errors.New("画布项目数据无效")
	}
	storageRefs := make(map[string]struct{})
	auditRefs := make(map[string]struct{})
	refCount := 0
	addReference := func(refs map[string]struct{}, id string) error {
		refCount++
		if refCount > canvasProjectMaxReferences {
			return errors.New("画布项目引用数量过多")
		}
		refs[id] = struct{}{}
		return nil
	}
	var walk func(any, int) error
	walk = func(value any, depth int) error {
		if depth > canvasProjectMaxReferenceDepth {
			return errors.New("画布项目数据层级过深")
		}
		switch typed := value.(type) {
		case map[string]any:
			for key, child := range typed {
				if text, ok := child.(string); ok {
					if key == "storageKey" {
						trimmed := strings.TrimSpace(text)
						if match := canvasProjectStorageKeyPattern.FindStringSubmatch(trimmed); len(match) == 2 {
							if err := addReference(storageRefs, match[1]); err != nil {
								return err
							}
						}
					}
					if match := canvasProjectFileURLPattern.FindStringSubmatch(text); len(match) == 2 {
						if err := addReference(auditRefs, match[1]); err != nil {
							return err
						}
					}
				}
				if err := walk(child, depth+1); err != nil {
					return err
				}
			}
		case []any:
			for _, child := range typed {
				if err := walk(child, depth+1); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := walk(root, 0); err != nil {
		return nil, nil, err
	}
	return storageRefs, auditRefs, nil
}

func validateCanvasProjectReferences(userID, projectID string, raw json.RawMessage, stored *model.CanvasProject) (map[string]struct{}, error) {
	refs, auditRefs, err := extractCanvasProjectReferences(raw)
	if err != nil {
		return nil, err
	}
	oldRefs, err := extractStoredProjectReferences(stored)
	if err != nil {
		return nil, err
	}
	newIDs := make([]string, 0, len(refs))
	for id := range refs {
		if _, existed := oldRefs[id]; !existed {
			newIDs = append(newIDs, id)
		}
	}
	sort.Strings(newIDs)
	objects, err := repository.GetStorageObjects(newIDs)
	if err != nil {
		return nil, err
	}
	byID := make(map[string]model.StorageObject, len(objects))
	for _, object := range objects {
		byID[object.ID] = object
	}
	for _, id := range newIDs {
		object, found := byID[id]
		if !found {
			return nil, &ProjectReferenceError{Category: "missing", ObjectID: id}
		}
		if object.CreatedBy != userID {
			return nil, &ProjectReferenceError{Category: "foreign_owner", ObjectID: id}
		}
		if object.Status != "active" || object.DeletedAt != "" {
			return nil, &ProjectReferenceError{Category: "trash", ObjectID: id}
		}
	}

	warnings := make([]string, 0)
	oldIDs := make([]string, 0, len(oldRefs))
	for id := range oldRefs {
		if _, retained := refs[id]; retained {
			oldIDs = append(oldIDs, id)
		}
	}
	oldObjects, err := repository.GetStorageObjects(oldIDs)
	if err != nil {
		return nil, err
	}
	oldByID := make(map[string]model.StorageObject, len(oldObjects))
	for _, object := range oldObjects {
		oldByID[object.ID] = object
	}
	for _, id := range oldIDs {
		object, found := oldByID[id]
		if !found {
			warnings = append(warnings, "missing:"+id)
		} else if object.CreatedBy != userID {
			warnings = append(warnings, "foreign_owner:"+id)
		} else if object.Status != "active" || object.DeletedAt != "" {
			warnings = append(warnings, "trash:"+id)
		}
	}
	if len(warnings) > 0 {
		sort.Strings(warnings)
		log.Printf("canvas project retained historical storage warnings user=%s project=%s warnings=%v", userID, projectID, warnings)
	}
	for id := range auditRefs {
		if _, authoritative := refs[id]; !authoritative {
			log.Printf("canvas project contains unauthoritative file URL user=%s project=%s object=%s", userID, projectID, id)
		}
	}
	return refs, nil
}

func canvasProjectFromRaw(
	userID string,
	raw json.RawMessage,
) (model.CanvasProject, error) {
	var metadata canvasProjectMetadata
	if len(raw) == 0 || json.Unmarshal(raw, &metadata) != nil {
		return model.CanvasProject{}, errors.New("画布项目数据无效")
	}

	metadata.ID = strings.TrimSpace(metadata.ID)
	metadata.CreatedAt = strings.TrimSpace(metadata.CreatedAt)
	metadata.UpdatedAt = strings.TrimSpace(metadata.UpdatedAt)
	if metadata.ID == "" || metadata.CreatedAt == "" ||
		metadata.UpdatedAt == "" {
		return model.CanvasProject{}, errors.New("画布项目数据无效")
	}

	return model.CanvasProject{
		UserID:      strings.TrimSpace(userID),
		ID:          metadata.ID,
		ProjectData: string(raw),
		CreatedAt:   metadata.CreatedAt,
		UpdatedAt:   metadata.UpdatedAt,
	}, nil
}

func canvasProjectData(
	projects []model.CanvasProject,
) []json.RawMessage {
	result := make([]json.RawMessage, 0, len(projects))
	for _, project := range projects {
		if strings.TrimSpace(project.ProjectData) != "" {
			result = append(
				result,
				json.RawMessage(project.ProjectData),
			)
		}
	}
	return result
}

func CurrentUserCanvasProjects(
	ctx context.Context,
) ([]json.RawMessage, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return nil, errors.New("请先登录")
	}

	projects, err := repository.ListUserCanvasProjects(user.ID)
	if err != nil {
		return nil, err
	}
	return canvasProjectData(projects), nil
}

// ProjectSaveConflict 表示保存被拒：服务器上已有更新的项目版本（其他窗口/设备先保存了）。
// Stored 携带服务器当前版本，供客户端做节点级合并后重试。
type ProjectSaveConflict struct {
	Stored json.RawMessage
}

func (e *ProjectSaveConflict) Error() string {
	return "画布已在其他窗口更新"
}

// GetCurrentUserCanvasProject 供画布页定期对账：仅当服务器版本比 since 新时返回项目数据。
func GetCurrentUserCanvasProject(
	ctx context.Context,
	projectID string,
	since string,
) (json.RawMessage, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return nil, errors.New("请先登录")
	}
	project, found, err := repository.GetCanvasProject(user.ID, strings.TrimSpace(projectID))
	if err != nil {
		return nil, err
	}
	if !found || project.DeletedAt != "" {
		return nil, nil
	}
	if strings.TrimSpace(since) != "" && project.UpdatedAt <= strings.TrimSpace(since) {
		return nil, nil
	}
	if strings.TrimSpace(project.ProjectData) == "" {
		return nil, nil
	}
	return json.RawMessage(project.ProjectData), nil
}

func SaveCurrentUserCanvasProject(
	ctx context.Context,
	raw json.RawMessage,
) (json.RawMessage, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return nil, errors.New("请先登录")
	}

	project, err := canvasProjectFromRaw(user.ID, raw)
	if err != nil {
		return nil, err
	}
	// 双开冲突保护：服务器上已有更新的版本时显式拒绝本次保存，
	// 由客户端合并（节点级）后重试；不再静默丢弃，也不允许旧快照覆盖新数据。
	stored, found, err := repository.GetCanvasProject(user.ID, project.ID)
	if err != nil {
		return nil, err
	}
	if found && stored.DeletedAt == "" &&
		stored.UpdatedAt > project.UpdatedAt &&
		strings.TrimSpace(stored.ProjectData) != "" {
		return nil, &ProjectSaveConflict{Stored: json.RawMessage(stored.ProjectData)}
	}
	var storedProject *model.CanvasProject
	if found {
		storedProject = &stored
	}
	refs, err := validateCanvasProjectReferences(user.ID, project.ID, raw, storedProject)
	if err != nil {
		return nil, err
	}
	saved, err := repository.SaveUserCanvasProjectFromStored(project, storedProject)
	if err != nil {
		return nil, err
	}
	if saved.DeletedAt != "" {
		return nil, errors.New("画布项目已删除")
	}
	// 只有本次写入真正落库时才缓存；并发写入失败时 saved 是别人的版本，不能用本次 refs 冒充它的引用集合。
	if saved.ProjectData == project.ProjectData && saved.UpdatedAt == project.UpdatedAt {
		rememberStoredProjectRefs(saved.UserID, saved.ID, saved.UpdatedAt, refs)
	}
	return json.RawMessage(saved.ProjectData), nil
}

func SyncCurrentUserCanvasProjects(
	ctx context.Context,
	rawProjects []json.RawMessage,
) ([]json.RawMessage, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return nil, errors.New("请先登录")
	}

	projects := make([]model.CanvasProject, 0, len(rawProjects))
	for _, raw := range rawProjects {
		project, err := canvasProjectFromRaw(user.ID, raw)
		if err != nil {
			return nil, err
		}
		stored, found, err := repository.GetCanvasProject(user.ID, project.ID)
		if err != nil {
			return nil, err
		}
		var storedProject *model.CanvasProject
		if found {
			storedProject = &stored
		}
		if _, err := validateCanvasProjectReferences(user.ID, project.ID, raw, storedProject); err != nil {
			return nil, err
		}
		projects = append(projects, project)
	}

	saved, err := repository.SaveUserCanvasProjects(user.ID, projects)
	if err != nil {
		return nil, err
	}
	return canvasProjectData(saved), nil
}

func DeleteCurrentUserCanvasProjects(
	ctx context.Context,
	projectIDs []string,
) error {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return errors.New("请先登录")
	}

	for _, projectID := range projectIDs {
		if strings.TrimSpace(projectID) != "" {
			return repository.SoftDeleteUserCanvasProjects(
				user.ID,
				projectIDs,
				time.Now().UTC().Format(time.RFC3339Nano),
			)
		}
	}
	return errors.New("画布项目参数无效")
}
