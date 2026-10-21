package model

const (
	PersistenceStatusPending    = "pending"
	PersistenceStatusProcessing = "processing"
	PersistenceStatusCompleted  = "completed"
	PersistenceStatusRetryWait  = "retry_wait"
	PersistenceStatusTrash      = "trash"
)

// GeneratedImageOutput tracks each generated image independently from generation status.
type GeneratedImageOutput struct {
	ID              string `json:"id" gorm:"primaryKey"`
	TaskID          string `json:"task_id" gorm:"uniqueIndex:idx_generated_output_task_position,priority:1;index"`
	Position        int    `json:"position" gorm:"uniqueIndex:idx_generated_output_task_position,priority:2"`
	CreatedBy       string `json:"created_by" gorm:"index"`
	SourceURL       string `json:"source_url" gorm:"type:text"`
	StorageObjectID string `json:"storage_object_id" gorm:"index"`
	StorageKey      string `json:"storage_key"`
	URL             string `json:"url" gorm:"type:text"`
	MimeType        string `json:"mime_type"`
	Bytes           int64  `json:"bytes"`
	Width           int    `json:"width"`
	Height          int    `json:"height"`
	// ThumbnailObjectID/ThumbnailURL 指向小尺寸预览图, 供网格/列表使用。
	ThumbnailObjectID string `json:"thumbnail_object_id" gorm:"index"`
	ThumbnailURL      string `json:"thumbnail_url" gorm:"type:text"`
	Status            string `json:"status" gorm:"index"`
	Error             string `json:"error" gorm:"type:text"`
	CreatedAt         string `json:"created_at"`
	UpdatedAt         string `json:"updated_at"`
}

// StorageTransferJob is an idempotent durable queue for moving a spooled output to storage.
type StorageTransferJob struct {
	ID            string `json:"id" gorm:"primaryKey"`
	OutputID      string `json:"output_id" gorm:"uniqueIndex"`
	TaskID        string `json:"task_id" gorm:"index"`
	CreatedBy     string `json:"created_by" gorm:"index"`
	ProviderID    string `json:"provider_id" gorm:"index"`
	ProviderType  string `json:"provider_type"`
	SpoolPath     string `json:"spool_path"`
	Status        string `json:"status" gorm:"index:idx_storage_jobs_ready,priority:1"`
	Attempts      int    `json:"attempts"`
	NextAttemptAt string `json:"next_attempt_at" gorm:"index:idx_storage_jobs_ready,priority:2"`
	LeaseUntil    string `json:"lease_until" gorm:"index"`
	LeaseOwner    string `json:"lease_owner"`
	LeaseToken    string `json:"lease_token"`
	Version       int64  `json:"version"`
	LastError     string `json:"last_error" gorm:"type:text"`
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`
	CompletedAt   string `json:"completed_at"`
}
