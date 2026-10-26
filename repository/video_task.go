package repository

import (
	"errors"

	"github.com/fzheng466/infinite-canvas/model"
	"gorm.io/gorm"
)

var ErrVideoTaskOwnerConflict = errors.New("视频任务 ID 已属于其他用户")

func SaveVideoTask(task model.VideoTask) (model.VideoTask, error) {
	db, err := DB()
	if err != nil {
		return task, err
	}
	var existing model.VideoTask
	err = db.First(&existing, "id = ?", task.ID).Error
	if err == nil {
		if existing.UserID != task.UserID {
			return existing, ErrVideoTaskOwnerConflict
		}
		return task, db.Model(&model.VideoTask{}).Where("id = ? AND user_id = ?", task.ID, task.UserID).Select("*").Updates(&task).Error
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return task, err
	}
	if err := db.Create(&task).Error; err != nil {
		if collided, found, readErr := GetVideoTask(task.ID); readErr == nil && found {
			if collided.UserID != task.UserID {
				return collided, ErrVideoTaskOwnerConflict
			}
			return collided, nil
		}
		return task, err
	}
	return task, nil
}

func GetVideoTask(id string) (model.VideoTask, bool, error) {
	db, err := DB()
	if err != nil {
		return model.VideoTask{}, false, err
	}
	var task model.VideoTask
	err = db.First(&task, "id = ?", id).Error
	if err != nil {
		return model.VideoTask{}, false, nil
	}
	return task, true, nil
}

func GetUserVideoTask(userID string, id string) (model.VideoTask, bool, error) {
	db, err := DB()
	if err != nil {
		return model.VideoTask{}, false, err
	}
	var task model.VideoTask
	err = db.First(&task, "user_id = ? AND (id = ? OR upstream_task_id = ? OR upstream_video_id = ?)", userID, id, id, id).Error
	if err != nil {
		return model.VideoTask{}, false, nil
	}
	return task, true, nil
}

func ListUserVideoTasks(userID string, source string, limit int) ([]model.VideoTask, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 100
	}
	var tasks []model.VideoTask
	query := db.Where("user_id = ?", userID)
	if source != "" {
		if source == "video-workbench" {
			query = query.Where("(source = ? OR source = '' OR source IS NULL)", source)
		} else {
			query = query.Where("source = ?", source)
		}
	}
	err = query.
		Where("status IN ?", []string{"queued", "in_progress", "processing", "running"}).
		Order("created_at DESC").
		Limit(limit).
		Find(&tasks).Error
	return tasks, err
}

func DeleteUserVideoTask(userID string, id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Where("user_id = ? AND (id = ? OR upstream_task_id = ? OR upstream_video_id = ?)", userID, id, id, id).Delete(&model.VideoTask{}).Error
}

func ListDueVideoTasks(limit int) ([]model.VideoTask, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 100
	}
	var tasks []model.VideoTask
	err = db.Where("status IN ?", []string{"queued", "in_progress", "processing", "running"}).
		Order("created_at ASC").
		Limit(limit).
		Find(&tasks).Error
	return tasks, err
}

func DeleteFinishedVideoTasksBefore(before string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.
		Where("completed_at <> ? AND completed_at < ?", "", before).
		Where("status IN ?", []string{"completed", "failed", "cancelled", "canceled"}).
		Delete(&model.VideoTask{}).Error
}
