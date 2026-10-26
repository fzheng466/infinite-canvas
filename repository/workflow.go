package repository

import (
	"errors"

	"github.com/fzheng466/infinite-canvas/model"
	"gorm.io/gorm"
)

func ListCreativeWorkflows(userID string) ([]model.CreativeWorkflow, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var workflows []model.CreativeWorkflow
	err = db.Where("scope = ? OR owner_user_id = ?", "public", userID).Order("updated_at DESC").Find(&workflows).Error
	return workflows, err
}

func GetCreativeWorkflow(id string) (model.CreativeWorkflow, bool, error) {
	db, err := DB()
	if err != nil {
		return model.CreativeWorkflow{}, false, err
	}
	var workflow model.CreativeWorkflow
	err = db.First(&workflow, "id = ?", id).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return model.CreativeWorkflow{}, false, nil
		}
		return model.CreativeWorkflow{}, false, err
	}
	return workflow, true, nil
}

func SaveCreativeWorkflow(workflow model.CreativeWorkflow) (model.CreativeWorkflow, error) {
	db, err := DB()
	if err != nil {
		return workflow, err
	}
	var count int64
	if err := db.Model(&model.CreativeWorkflow{}).Where("id = ?", workflow.ID).Count(&count).Error; err != nil {
		return workflow, err
	}
	if count == 0 {
		return workflow, db.Create(&workflow).Error
	}
	result := db.Model(&model.CreativeWorkflow{}).
		Where("id = ? AND owner_user_id = ?", workflow.ID, workflow.OwnerUserID).
		Select("*").Updates(&workflow)
	if result.Error != nil {
		return workflow, result.Error
	}
	if result.RowsAffected != 1 {
		return workflow, errors.New("只能编辑自己的工作流")
	}
	return workflow, nil
}

func DeleteCreativeWorkflow(id string, ownerUserID string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Delete(&model.CreativeWorkflow{}, "id = ? AND owner_user_id = ?", id, ownerUserID).Error
}
