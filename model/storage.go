package model

// StorageObject 存储对象（S3/R2、WebDAV 共用文件索引）。
type StorageObject struct {
	ID         string `json:"id" gorm:"primaryKey"`
	ProviderID string `json:"providerId" gorm:"index"`
	Bucket     string `json:"bucket"`
	ObjectKey  string `json:"objectKey" gorm:"uniqueIndex"`
	PublicURL  string `json:"publicUrl"`
	MimeType   string `json:"mimeType"`
	Bytes      int64  `json:"bytes"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	SHA256     string `json:"sha256"`
	Direct     bool   `json:"direct"`
	CreatedBy  string `json:"createdBy" gorm:"index"`
	CreatedAt  string `json:"created_at"`
	Status     string `json:"status" gorm:"index"`
	TrashedAt  string `json:"trashed_at" gorm:"index"`
	PurgeAfter string `json:"purge_after" gorm:"index"`
	DeletedAt  string `json:"deleted_at"`
}
