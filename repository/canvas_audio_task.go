package repository

import "github.com/tigerowo/infinite-canvas/model"

func SaveCanvasAudioTask(task model.CanvasAudioTask) (model.CanvasAudioTask, bool, error) {
	db, err := DB()
	if err != nil {
		return task, false, err
	}
	var created bool
	err = retryOnSQLiteBusy(func() error {
		var opErr error
		created, opErr = saveOwnedCanvasTask(db, &model.CanvasAudioTask{}, task.ID, task.UserID, &task)
		return opErr
	})
	return task, created, err
}

func UpdateCanvasAudioTask(task model.CanvasAudioTask) (model.CanvasAudioTask, error) {
	db, err := DB()
	if err != nil {
		return task, err
	}

	return task, db.Model(&model.CanvasAudioTask{}).
		Where("user_id = ? AND id = ?", task.UserID, task.ID).
		Select("*").
		Updates(&task).Error
}

func GetCanvasAudioTaskByID(id string) (model.CanvasAudioTask, error) {
	db, err := DB()
	if err != nil {
		return model.CanvasAudioTask{}, err
	}
	var task model.CanvasAudioTask
	return task, db.First(&task, "id = ?", id).Error
}

func GetUserCanvasAudioTask(userID string, id string) (model.CanvasAudioTask, bool, error) {
	db, err := DB()
	if err != nil {
		return model.CanvasAudioTask{}, false, err
	}
	var task model.CanvasAudioTask
	err = db.First(&task, "user_id = ? AND id = ?", userID, id).Error
	if err != nil {
		return model.CanvasAudioTask{}, false, nil
	}
	return task, true, nil
}
