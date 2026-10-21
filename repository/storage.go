package repository

import (
	"time"

	"github.com/tigerowo/infinite-canvas/model"
)

// SaveStorageObject 保存存储对象记录。
func SaveStorageObject(object model.StorageObject) (model.StorageObject, error) {
	db, err := DB()
	if err != nil {
		return model.StorageObject{}, err
	}
	return object, db.Save(&object).Error
}

// GetStorageObject 根据 ID 获取存储对象。
func GetStorageObject(id string) (model.StorageObject, error) {
	db, err := DB()
	if err != nil {
		return model.StorageObject{}, err
	}
	var object model.StorageObject
	err = db.First(&object, "id = ?", id).Error
	if err == nil && object.Status == "" {
		object.Status = "active"
		_ = db.Model(&model.StorageObject{}).Where("id = ? AND (status IS NULL OR status = '')", id).Update("status", "active").Error
	}
	return object, err
}

// GetStorageObjects 批量获取指定 ID 的存储对象；不存在的 ID 不返回记录。
func GetStorageObjects(ids []string) ([]model.StorageObject, error) {
	ids = uniqueTrimmedValues(ids...)
	if len(ids) == 0 {
		return []model.StorageObject{}, nil
	}
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var objects []model.StorageObject
	if err := db.Where("id IN ?", ids).Find(&objects).Error; err != nil {
		return nil, err
	}
	for i := range objects {
		if objects[i].Status == "" {
			objects[i].Status = "active"
		}
	}
	return objects, nil
}

// DeleteStorageObjectRecord marks an object as trash; physical deletion is handled separately.
func DeleteStorageObjectRecord(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	current := time.Now().UTC()
	return db.Model(&model.StorageObject{}).Where("id = ? AND (status IS NULL OR status = '' OR status = ?)", id, "active").Updates(map[string]any{
		"status": "trash", "trashed_at": current.Format(time.RFC3339Nano), "purge_after": current.Add(30 * 24 * time.Hour).Format(time.RFC3339Nano),
	}).Error
}
