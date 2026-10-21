package repository

import (
	"errors"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
)

var ErrCanvasTaskOwnerConflict = errors.New("任务 ID 已属于其他用户")

func SaveCanvasImageTask(task model.CanvasImageTask) (model.CanvasImageTask, bool, error) {
	db, err := DB()
	if err != nil {
		return task, false, err
	}
	// 生成高峰期的热路径：写锁竞争时退避重试而不是让用户生图直接失败。
	var created bool
	err = retryOnSQLiteBusy(func() error {
		var opErr error
		created, opErr = saveOwnedCanvasTask(db, &model.CanvasImageTask{}, task.ID, task.UserID, &task)
		return opErr
	})
	return task, created, err
}

// saveOwnedCanvasTask 的任务表主键只有 id：同用户按 (id, user_id) 更新，新 ID 插入，
// ID 已属于其他用户时拒绝，绝不像 db.Save 那样按主键改写他人记录（含 user_id）。
// 返回的 created 区分"本次插入"与"更新已有行"：并发同 clientTaskID 时后到者会走更新分支，
// 调用方必须把它识别为"非新建"，否则会重复启动执行、重复扣费。
func saveOwnedCanvasTask(db *gorm.DB, table any, id string, userID string, task any) (bool, error) {
	owner, found, err := canvasTaskOwner(db, table, id)
	if err != nil {
		return false, err
	}
	if found {
		if owner != userID {
			return false, ErrCanvasTaskOwnerConflict
		}
		return false, db.Model(table).Where("id = ? AND user_id = ?", id, userID).Select("*").Updates(task).Error
	}
	if err := db.Create(task).Error; err != nil {
		if owner, found, readErr := canvasTaskOwner(db, table, id); readErr == nil && found && owner != userID {
			return false, ErrCanvasTaskOwnerConflict
		}
		return false, err
	}
	return true, nil
}

func canvasTaskOwner(db *gorm.DB, table any, id string) (string, bool, error) {
	var owners []string
	if err := db.Model(table).Where("id = ?", id).Limit(1).Pluck("user_id", &owners).Error; err != nil {
		return "", false, err
	}
	if len(owners) == 0 {
		return "", false, nil
	}
	return owners[0], true, nil
}

func UpdateCanvasImageTask(task model.CanvasImageTask) (model.CanvasImageTask, error) {
	db, err := DB()
	if err != nil {
		return task, err
	}

	err = retryOnSQLiteBusy(func() error {
		return db.Model(&model.CanvasImageTask{}).
			Where("user_id = ? AND id = ?", task.UserID, task.ID).
			Select("*").
			Updates(&task).Error
	})
	return task, err
}

func GetUserCanvasImageTask(userID string, id string) (model.CanvasImageTask, bool, error) {
	db, err := DB()
	if err != nil {
		return model.CanvasImageTask{}, false, err
	}
	var task model.CanvasImageTask
	err = db.First(&task, "user_id = ? AND id = ?", userID, id).Error
	if err != nil {
		return model.CanvasImageTask{}, false, nil
	}
	return task, true, nil
}

func ListUserCanvasImageTasks(userID string, sources []string, limit int) ([]model.CanvasImageTask, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 100
	}
	var tasks []model.CanvasImageTask
	query := db.Where("user_id = ?", userID)
	if len(sources) > 0 {
		query = query.Where("source IN ?", sources)
	}
	err = query.
		Where("status IN ?", []string{"queued", "processing", "running", "in_progress"}).
		Order("created_at DESC").
		Limit(limit).
		Find(&tasks).Error
	return tasks, err
}

func ListRecentCompletedCanvasImageTasks(userID string, sources []string, limit int) ([]model.CanvasImageTask, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 50
	}
	var tasks []model.CanvasImageTask
	query := db.Where("user_id = ?", userID)
	if len(sources) > 0 {
		query = query.Where("source IN ?", sources)
	}
	err = query.
		Where("status = ? AND image_url <> ?", "completed", "").
		Order("created_at DESC").
		Limit(limit).
		Find(&tasks).Error
	return tasks, err
}

func BatchUserCanvasImageTasks(userID string, ids []string) ([]model.CanvasImageTask, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	keys := uniqueTrimmedValues(ids...)
	if len(keys) == 0 {
		return []model.CanvasImageTask{}, nil
	}
	var tasks []model.CanvasImageTask
	err = db.Where("user_id = ? AND id IN ?", userID, keys).Find(&tasks).Error
	return tasks, err
}

func DeleteUserCanvasImageTask(userID string, id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		current := time.Now().UTC().Format(time.RFC3339Nano)
		if _, err := CancelStorageJobsForTasks(tx, []string{strings.TrimSpace(id)}, current); err != nil {
			return err
		}
		return tx.Where("user_id = ? AND id = ?", userID, strings.TrimSpace(id)).Delete(&model.CanvasImageTask{}).Error
	})
}

func DeleteUserCanvasTasks(userID string, sourceID string, nodeIDs []string) error {
	db, err := DB()
	if err != nil {
		return err
	}

	nodeIDs = uniqueTrimmedValues(nodeIDs...)

	return db.Transaction(func(tx *gorm.DB) error {
		var taskIDs []string
		if err := tx.Model(&model.CanvasImageTask{}).Where("user_id = ? AND source = ? AND source_id = ?", userID, "canvas", sourceID).
			Limit(1000).Pluck("id", &taskIDs).Error; err != nil {
			return err
		}
		if _, err := CancelStorageJobsForTasks(tx, taskIDs, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return err
		}
		deleteTasks := func(task any) error {
			query := tx.Where(
				"user_id = ? AND source = ? AND source_id = ?",
				userID,
				"canvas",
				sourceID,
			)
			if len(nodeIDs) > 0 {
				query = query.Where("node_id IN ?", nodeIDs)
			}
			return query.Delete(task).Error
		}

		if err := deleteTasks(&model.CanvasImageTask{}); err != nil {
			return err
		}
		return deleteTasks(&model.CanvasAudioTask{})
	})
}

func uniqueTrimmedValues(values ...string) []string {
	result := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" && !seen[value] {
			result = append(result, value)
			seen[value] = true
		}
	}
	return result
}
