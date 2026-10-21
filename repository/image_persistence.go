package repository

import (
	"errors"
	"path"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrGeneratedImageOutputOwnerConflict = errors.New("图片输出 ID 已属于其他用户")

func CreateImagePersistenceBatch(task model.CanvasImageTask, outputs []model.GeneratedImageOutput, jobs []model.StorageTransferJob) error {
	db, err := DB()
	if err != nil {
		return err
	}
	// 入队是生成链路的收尾热点，与进度更新/日志回写并发时易撞 SQLITE_BUSY；
	// 短退避重试，避免任务落入没有任何 job 的 retry_wait（孤儿态）。
	return retryOnSQLiteBusy(func() error {
		return db.Transaction(func(tx *gorm.DB) error {
			for index := range outputs {
				baseID := outputs[index].ID
				resolvedID, err := resolveGeneratedImageOutputID(tx, baseID, outputs[index].CreatedBy)
				if err != nil {
					return err
				}
				if resolvedID != baseID {
					outputs[index].ID = resolvedID
					for jobIndex := range jobs {
						if jobs[jobIndex].OutputID == baseID {
							jobs[jobIndex].OutputID = resolvedID
							jobs[jobIndex].ID = "storage_transfer_" + resolvedID
						}
					}
				}
			}
			if err := tx.Save(&task).Error; err != nil {
				return err
			}
			if len(outputs) > 0 {
				if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&outputs).Error; err != nil {
					return err
				}
			}
			if len(jobs) > 0 {
				if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&jobs).Error; err != nil {
					return err
				}
			}
			return nil
		})
	})
}

// ListOrphanRetryImageTasks 返回处于 retry_wait 但没有任何转存 job 的任务：
// 入队批写整体失败时会留下这种孤儿态（只有任务被标记、没有 job 可被认领），
// 不救援将永远卡住。只取最近 24 小时内的，更早的上游链接大概率已失效。
func ListOrphanRetryImageTasks(before string, after string, limit int) ([]model.CanvasImageTask, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 50
	}
	tasks := []model.CanvasImageTask{}
	err = db.Where(
		"persistence_status = ? AND updated_at <= ? AND updated_at >= ?"+
			" AND ((image_urls <> '' AND image_urls <> 'null' AND image_urls <> '[]') OR image_url <> '')"+
			" AND NOT EXISTS (SELECT 1 FROM storage_transfer_jobs WHERE storage_transfer_jobs.task_id = canvas_image_tasks.id)",
		model.PersistenceStatusRetryWait, before, after,
	).Order("updated_at ASC").Limit(limit).Find(&tasks).Error
	return tasks, err
}

func CreateImagePersistence(output model.GeneratedImageOutput, job model.StorageTransferJob) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		originalOutputID := output.ID
		resolvedID, err := resolveGeneratedImageOutputID(tx, originalOutputID, output.CreatedBy)
		if err != nil {
			return err
		}
		output.ID = resolvedID
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&output).Error; err != nil {
			return err
		}
		job.OutputID = output.ID
		if resolvedID != originalOutputID && job.ID == "storage_transfer_"+originalOutputID {
			job.ID = "storage_transfer_" + resolvedID
		}
		return tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&job).Error
	})
}

func GetGeneratedImageOutputs(taskID string) ([]model.GeneratedImageOutput, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var outputs []model.GeneratedImageOutput
	err = db.Where("task_id = ?", taskID).Order("position ASC").Find(&outputs).Error
	return outputs, err
}

func GetGeneratedImageOutput(id string) (model.GeneratedImageOutput, error) {
	db, err := DB()
	if err != nil {
		return model.GeneratedImageOutput{}, err
	}
	var output model.GeneratedImageOutput
	err = db.First(&output, "id = ?", id).Error
	return output, err
}

func GetCanvasImageTaskByID(id string) (model.CanvasImageTask, error) {
	db, err := DB()
	if err != nil {
		return model.CanvasImageTask{}, err
	}
	var task model.CanvasImageTask
	err = db.First(&task, "id = ?", id).Error
	return task, err
}

func GetStorageTransferJob(id string) (model.StorageTransferJob, error) {
	db, err := DB()
	if err != nil {
		return model.StorageTransferJob{}, err
	}
	var job model.StorageTransferJob
	err = db.First(&job, "id = ?", id).Error
	return job, err
}

func ClaimStorageTransferJobs(limit int, current time.Time, leaseUntil, owner string) ([]model.StorageTransferJob, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 10
	}
	nowText := current.UTC().Format(time.RFC3339Nano)
	var claimed []model.StorageTransferJob
	err = db.Transaction(func(tx *gorm.DB) error {
		var jobs []model.StorageTransferJob
		readyTask := "EXISTS (SELECT 1 FROM canvas_image_tasks t WHERE t.id = storage_transfer_jobs.task_id AND t.status = ? AND t.expected_output_count > 0 AND t.expected_output_count = (SELECT COUNT(*) FROM generated_image_outputs o WHERE o.task_id = t.id))"
		if err := tx.Where("((status IN ? AND (next_attempt_at = '' OR next_attempt_at <= ?)) OR (status = ? AND lease_until != '' AND lease_until <= ?)) AND "+readyTask,
			[]string{model.PersistenceStatusPending, model.PersistenceStatusRetryWait}, nowText, model.PersistenceStatusProcessing, nowText, "completed").
			Order("created_at ASC").Limit(limit).Find(&jobs).Error; err != nil {
			return err
		}
		for _, job := range jobs {
			token := uuid.NewString()
			result := tx.Model(&model.StorageTransferJob{}).
				Where("id = ? AND status = ? AND version = ?", job.ID, job.Status, job.Version).
				Updates(map[string]any{"status": model.PersistenceStatusProcessing, "lease_until": leaseUntil, "lease_owner": owner, "lease_token": token, "version": job.Version + 1, "updated_at": nowText})
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected == 1 {
				job.Status, job.LeaseUntil, job.LeaseOwner, job.LeaseToken = model.PersistenceStatusProcessing, leaseUntil, owner, token
				job.Version++
				claimed = append(claimed, job)
			}
		}
		return nil
	})
	return claimed, err
}

func RenewStorageTransferLease(job model.StorageTransferJob, leaseUntil string) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	result := db.Model(&model.StorageTransferJob{}).
		Where("id = ? AND status = ? AND lease_owner = ? AND lease_token = ? AND version = ?", job.ID, model.PersistenceStatusProcessing, job.LeaseOwner, job.LeaseToken, job.Version).
		Updates(map[string]any{"lease_until": leaseUntil, "version": job.Version + 1, "updated_at": time.Now().UTC().Format(time.RFC3339Nano)})
	return result.RowsAffected == 1, result.Error
}

func CompleteStorageTransfer(job model.StorageTransferJob, output model.GeneratedImageOutput, task model.CanvasImageTask, object model.StorageObject, extraObjects []model.StorageObject) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		objects := append([]model.StorageObject{object}, extraObjects...)
		for index := range objects {
			obj := &objects[index]
			if obj.ID == "" {
				continue
			}
			var existing model.StorageObject
			err := tx.First(&existing, "id = ?", obj.ID).Error
			if err == nil {
				if existing.CreatedBy != output.CreatedBy || existing.ObjectKey != obj.ObjectKey {
					return errors.New("存储对象 ID 或 key 已被占用")
				}
				continue
			}
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
			var keyCount int64
			if err := tx.Model(&model.StorageObject{}).Where("object_key = ?", obj.ObjectKey).Count(&keyCount).Error; err != nil {
				return err
			}
			if keyCount != 0 {
				return errors.New("存储对象 ID 或 key 已被占用")
			}
			if err := tx.Create(obj).Error; err != nil {
				return err
			}
		}
		result := tx.Model(&model.GeneratedImageOutput{}).Where("id = ? AND created_by = ?", output.ID, output.CreatedBy).Select("*").Updates(&output)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrGeneratedImageOutputOwnerConflict
		}
		result = tx.Model(&model.StorageTransferJob{}).
			Where("id = ? AND status = ? AND lease_owner = ? AND lease_token = ? AND version = ?", job.ID, model.PersistenceStatusProcessing, job.LeaseOwner, job.LeaseToken, job.Version).
			Updates(map[string]any{"status": job.Status, "last_error": job.LastError, "lease_until": "", "lease_owner": "", "lease_token": "", "completed_at": job.CompletedAt, "updated_at": job.UpdatedAt, "version": job.Version + 1})
		if result.Error != nil || result.RowsAffected != 1 {
			if result.Error != nil {
				return result.Error
			}
			return gorm.ErrInvalidTransaction
		}
		return tx.Model(&model.CanvasImageTask{}).Where("id = ? AND user_id = ?", task.ID, task.UserID).
			Select("persistence_status", "persistence_error", "image_url", "image_urls", "storage_key", "mime_type", "bytes", "width", "height", "updated_at").Updates(&task).Error
	})
}

func resolveGeneratedImageOutputID(tx *gorm.DB, baseID, createdBy string) (string, error) {
	candidate := baseID
	for {
		var existing model.GeneratedImageOutput
		err := tx.First(&existing, "id = ?", candidate).Error
		if errors.Is(err, gorm.ErrRecordNotFound) || (err == nil && existing.CreatedBy == createdBy) {
			return candidate, nil
		}
		if err != nil {
			return "", err
		}
		candidate = baseID + "-" + uuid.NewString()[:8]
	}
}

func AllocateStorageObjectIdentity(baseID, objectKey, createdBy string) (string, string, error) {
	db, err := DB()
	if err != nil {
		return "", "", err
	}
	return resolveStorageObjectIdentity(db, baseID, objectKey, createdBy)
}

func resolveStorageObjectIdentity(tx *gorm.DB, baseID, objectKey, createdBy string) (string, string, error) {
	candidateID, candidateKey := baseID, objectKey
	for {
		var existing model.StorageObject
		idErr := tx.First(&existing, "id = ?", candidateID).Error
		if idErr == nil && existing.CreatedBy == createdBy && existing.ObjectKey == candidateKey {
			return candidateID, candidateKey, nil
		}
		if idErr != nil && !errors.Is(idErr, gorm.ErrRecordNotFound) {
			return "", "", idErr
		}
		var keyOwner model.StorageObject
		keyErr := tx.First(&keyOwner, "object_key = ?", candidateKey).Error
		if errors.Is(idErr, gorm.ErrRecordNotFound) && errors.Is(keyErr, gorm.ErrRecordNotFound) {
			return candidateID, candidateKey, nil
		}
		if keyErr != nil && !errors.Is(keyErr, gorm.ErrRecordNotFound) {
			return "", "", keyErr
		}
		suffix := uuid.NewString()[:8]
		candidateID = baseID + "-" + suffix
		candidateKey = storageObjectKeyWithSuffix(objectKey, suffix)
	}
}

func resolveStorageObjectID(tx *gorm.DB, object model.StorageObject) (string, error) {
	id, key, err := resolveStorageObjectIdentity(tx, object.ID, object.ObjectKey, object.CreatedBy)
	if err != nil {
		return "", err
	}
	if key != object.ObjectKey {
		return "", errors.New("存储对象 key 已被占用")
	}
	return id, nil
}

func storageObjectKeyWithSuffix(objectKey, suffix string) string {
	ext := path.Ext(objectKey)
	base := strings.TrimSuffix(path.Base(objectKey), ext)
	return path.Join(path.Dir(objectKey), base+"-"+suffix+ext)
}

func FailStorageTransfer(job model.StorageTransferJob, output model.GeneratedImageOutput, task model.CanvasImageTask) error {
	return CompleteStorageTransfer(job, output, task, model.StorageObject{}, nil)
}

func CancelStorageJobsForTasks(tx *gorm.DB, taskIDs []string, current string) ([]string, error) {
	if len(taskIDs) == 0 {
		return nil, nil
	}
	var paths []string
	if err := tx.Model(&model.StorageTransferJob{}).Where("task_id IN ? AND spool_path <> ''", taskIDs).Pluck("spool_path", &paths).Error; err != nil {
		return nil, err
	}
	err := tx.Model(&model.StorageTransferJob{}).Where("task_id IN ? AND status <> ?", taskIDs, model.PersistenceStatusCompleted).
		Updates(map[string]any{"status": "cancelled", "lease_until": "", "lease_owner": "", "lease_token": "", "updated_at": current}).Error
	return paths, err
}

func ReferencedSpoolPaths() (map[string]bool, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var paths []string
	if err := db.Model(&model.StorageTransferJob{}).Where("spool_path <> '' AND status <> ?", model.PersistenceStatusCompleted).Pluck("spool_path", &paths).Error; err != nil {
		return nil, err
	}
	result := make(map[string]bool, len(paths))
	for _, path := range paths {
		result[path] = true
	}
	return result, nil
}

// ActiveStorageSpoolPaths 返回仍可能被 worker 处理（pending/processing/retry_wait）
// 的 job 引用的 spool 文件；清理逻辑不得删除这些文件。
func ActiveStorageSpoolPaths() (map[string]bool, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var paths []string
	if err := db.Model(&model.StorageTransferJob{}).
		Where("spool_path <> '' AND status IN ?", []string{model.PersistenceStatusPending, model.PersistenceStatusProcessing, model.PersistenceStatusRetryWait}).
		Pluck("spool_path", &paths).Error; err != nil {
		return nil, err
	}
	result := make(map[string]bool, len(paths))
	for _, path := range paths {
		result[path] = true
	}
	return result, nil
}
