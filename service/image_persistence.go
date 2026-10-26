package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
		_ "image/gif"
		"image/jpeg"
		"image/png"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/fzheng466/infinite-canvas/config"
	"github.com/fzheng466/infinite-canvas/model"
	"github.com/fzheng466/infinite-canvas/repository"
	xdraw "golang.org/x/image/draw"
)

const storageTransferLease = 15 * time.Minute

// storageTransferJobTimeout 单个转存 job 的整体超时，防止异常下载/上传无限占用租约。
const storageTransferJobTimeout = 10 * time.Minute

var storageTransferWorkerOnce sync.Once
var storageWorkerID = "storage-worker-" + uuid.NewString()

// persistenceKick 单飞锁：并发请求只允许一个触发处理循环，其余直接返回，
// 后台 5 秒轮询兜底。测试可通过 storageTransferTrigger 注入同步语义。
var persistenceKick sync.Mutex
var storageTransferTrigger = triggerStorageTransferWorkers

func triggerStorageTransferWorkers() {
	if !persistenceKick.TryLock() {
		return
	}
	go func() {
		defer persistenceKick.Unlock()
		ProcessStorageTransferJobs(context.Background())
	}()
}

// QueueGeneratedImagePersistence spools every output, then atomically exposes the complete batch to workers.
func QueueGeneratedImagePersistence(task model.CanvasImageTask, imageURLs []string) (model.CanvasImageTask, error) {
	if len(imageURLs) == 0 {
		return task, errors.New("没有可持久化的图片")
	}
	provider, err := selectPersistenceProvider(task.UserID)
	if err != nil {
		task.PersistenceStatus, task.PersistenceError = "not_configured", ""
		return SaveCanvasImageTask(task)
	}
	outputs := make([]model.GeneratedImageOutput, 0, len(imageURLs))
	jobs := make([]model.StorageTransferJob, 0, len(imageURLs))
	spooled := make([]string, 0, len(imageURLs))
	current := now()
	for position, sourceURL := range imageURLs {
		outputID := task.ID + "-" + fmt.Sprint(position)
		// 下载失败不放弃：建空 spool 的 job，worker 会重试下载(含重新拉取临时链接)。
		spoolPath, mimeType, size, width, height, spoolErr := spoolGeneratedImage(context.Background(), outputID, sourceURL)
		if spoolErr != nil {
			log.Printf("spool image failed task=%s output=%s err=%v (worker 将重试)", task.ID, outputID, spoolErr)
		}
		if spoolErr == nil {
			spooled = append(spooled, spoolPath)
		}
		output := model.GeneratedImageOutput{ID: outputID, TaskID: task.ID, Position: position, CreatedBy: task.UserID, SourceURL: sourceURL, Status: model.PersistenceStatusPending, CreatedAt: current, UpdatedAt: current}
		if spoolErr == nil {
			output.MimeType, output.Bytes, output.Width, output.Height = mimeType, size, width, height
		}
		outputs = append(outputs, output)
		jobs = append(jobs, model.StorageTransferJob{ID: "storage_transfer_" + outputID, OutputID: outputID, TaskID: task.ID, CreatedBy: task.UserID, ProviderID: provider.ID, ProviderType: provider.Type, SpoolPath: spoolPath, Status: model.PersistenceStatusPending, CreatedAt: current, UpdatedAt: current})
	}
	task.PersistenceStatus, task.PersistenceError, task.ExpectedOutputCount = model.PersistenceStatusPending, "", len(outputs)
	if err := repository.CreateImagePersistenceBatch(task, outputs, jobs); err != nil {
		for _, filename := range spooled {
			_ = os.Remove(filename)
		}
		return markPersistenceQueueFailure(task, err)
	}
	// 只负责入队并尽快唤醒后台处理，不再在生成请求内同步下载/上传。
	storageTransferTrigger()
	updated, found, err := repository.GetUserCanvasImageTask(task.UserID, task.ID)
	if err == nil && found {
		return updated, nil
	}
	return task, err
}

func selectPersistenceProvider(userID string) (model.StorageProvider, error) {
	if strings.TrimSpace(userID) != "" {
		if userConfig, found, err := repository.GetUserConfig(userID); err == nil && found {
			for _, provider := range userStorageProvidersForOwner(userConfig.StorageProvider, userID) {
				if provider.Enabled && storageProviderConfigured(provider) {
					return provider, nil
				}
			}
		}
	}
	settings, err := repository.GetSettings()
	if err == nil {
		if provider, selectErr := selectStorageProvider(normalizePrivateStorageSetting(settings.Private.Storage)); selectErr == nil {
			return provider, nil
		}
	}
	if local, enabled := localStorageProvider(); enabled {
		return local, nil
	}
	return model.StorageProvider{}, errors.New("没有可用对象存储配置")
}

func persistenceProvider(job model.StorageTransferJob) (model.StorageProvider, error) {
	if job.ProviderType == model.StorageProviderTypeLocal && job.ProviderID == "local" {
		if provider, enabled := localStorageProvider(); enabled {
			return provider, nil
		}
	}
	providers := []model.StorageProvider{}
	if job.CreatedBy != "" {
		if userConfig, found, err := repository.GetUserConfig(job.CreatedBy); err == nil && found {
			providers = append(providers, userStorageProvidersForOwner(userConfig.StorageProvider, job.CreatedBy)...)
		}
	}
	if settings, err := repository.GetSettings(); err == nil {
		providers = append(providers, normalizePrivateStorageSetting(settings.Private.Storage).Providers...)
	}
	for _, provider := range providers {
		if provider.ID == job.ProviderID && provider.Type == job.ProviderType && provider.Enabled && storageProviderConfigured(provider) {
			return provider, nil
		}
	}
	return model.StorageProvider{}, errors.New("任务指定的存储提供商不可用")
}

func markPersistenceQueueFailure(task model.CanvasImageTask, err error) (model.CanvasImageTask, error) {
	task.PersistenceStatus = model.PersistenceStatusRetryWait
	task.PersistenceError = err.Error()
	updated, saveErr := SaveCanvasImageTask(task)
	if saveErr != nil {
		return updated, saveErr
	}
	return updated, err
}

func spoolGeneratedImage(ctx context.Context, outputID, source string) (string, string, int64, int, int, error) {
	data, mimeType, err := downloadGeneratedImage(ctx, source)
	if err != nil {
		return "", "", 0, 0, 0, err
	}
	if err := os.MkdirAll(config.Cfg.StorageSpoolDir, 0750); err != nil {
		return "", "", 0, 0, 0, err
	}
	finalPath, err := safeStorageFile(config.Cfg.StorageSpoolDir, outputID+extensionForContentType(mimeType))
	if err != nil {
		return "", "", 0, 0, 0, err
	}
	temp, err := os.CreateTemp(config.Cfg.StorageSpoolDir, ".spool-*")
	if err != nil {
		return "", "", 0, 0, 0, err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if _, err = temp.Write(data); err == nil {
		err = temp.Sync()
	}
	if closeErr := temp.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(tempName, finalPath)
	}
	if err != nil {
		return "", "", 0, 0, 0, err
	}
	width, height := 0, 0
	if cfg, _, decodeErr := image.DecodeConfig(bytes.NewReader(data)); decodeErr == nil {
		width, height = cfg.Width, cfg.Height
	}
	return finalPath, mimeType, int64(len(data)), width, height, nil
}

// PersistRemoteGeneratedImage downloads an upstream image and publishes only a server object reference.
func PersistRemoteGeneratedImage(ctx context.Context, source string) (UploadedStorageObject, error) {
	data, mimeType, err := downloadGeneratedImage(ctx, source)
	if err != nil {
		return UploadedStorageObject{}, err
	}
	object, err := UploadStorageObject(ctx, "generated.png", mimeType, data)
	if err != nil {
		return UploadedStorageObject{}, err
	}
	object.URL = "/api/files/" + object.ID + "/content"
	return object, nil
}

func downloadGeneratedImage(ctx context.Context, source string) ([]byte, string, error) {
	limit := config.Cfg.StorageMaxImageBytes
	if limit <= 0 {
		limit = 32 << 20
	}
	var data []byte
	declared := ""
	if strings.HasPrefix(source, "http://") || strings.HasPrefix(source, "https://") {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
		if err != nil {
			return nil, "", err
		}
		// 同机自建网关等合法内网来源：命中显式配置的可信主机白名单时
		// 用直连客户端（禁重定向），其余仍走 SSRF 防护客户端。
		var client *http.Client
		if hostTrustedForDownload(request.URL.Hostname()) {
			client = &http.Client{Timeout: 120 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			}}
		} else {
			client = SafeProxyHTTPClient()
		}
		response, err := client.Do(request)
		if err != nil {
			return nil, "", err
		}
		defer response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return nil, "", fmt.Errorf("图片下载失败: %s", response.Status)
		}
		if response.ContentLength > limit {
			return nil, "", errors.New("图片超过大小限制")
		}
		declared = strings.ToLower(strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0]))
		data, err = io.ReadAll(io.LimitReader(response.Body, limit+1))
		if err != nil {
			return nil, "", err
		}
	} else {
		encoded := source
		if strings.HasPrefix(source, "data:") {
			parts := strings.SplitN(source, ",", 2)
			if len(parts) != 2 || !strings.Contains(parts[0], ";base64") {
				return nil, "", errors.New("图片 data URL 无效")
			}
			declared = strings.ToLower(strings.TrimPrefix(strings.Split(parts[0], ";")[0], "data:"))
			encoded = parts[1]
		}
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return nil, "", err
		}
		data = decoded
	}
	if int64(len(data)) > limit {
		return nil, "", errors.New("图片超过大小限制")
	}
	detected := strings.ToLower(strings.Split(http.DetectContentType(data), ";")[0])
	if !allowedGeneratedImageMIME(detected) || (declared != "" && !strings.HasPrefix(declared, "image/")) {
		return nil, "", errors.New("下载内容不是受支持的图片")
	}
	return data, detected, nil
}

func allowedGeneratedImageMIME(value string) bool {
	switch value {
	case "image/jpeg", "image/png", "image/gif", "image/webp":
		return true
	default:
		return false
	}
}

// hostTrustedForDownload 判断主机是否在显式配置的可信下载白名单中。
func hostTrustedForDownload(hostname string) bool {
	hostname = strings.ToLower(strings.TrimSpace(hostname))
	if hostname == "" {
		return false
	}
	for _, raw := range strings.Split(config.Cfg.TrustedDownloadHosts, ",") {
		if strings.ToLower(strings.TrimSpace(raw)) == hostname {
			return true
		}
	}
	return false
}

// StartStorageTransferWorker recovers pending and expired processing jobs.
// 不依赖 LocalStorageEnabled：只要配置了任意可用 Provider（local/S3/WebDAV），
// 队列都要运行；未配置 Provider 时任务在入队阶段就会被标记 not_configured。
// RescueOrphanPersistenceTasks 把"入队批写失败"留下的孤儿任务重新入队：
// 这类任务停在 retry_wait 且没有任何 job，转存 worker 永远不会认领它们。
// 在 worker 启动时和周期性执行；上游图片链接多半仍有效，重新入队即可续走转存链路。
func RescueOrphanPersistenceTasks(ctx context.Context) {
	now := time.Now().UTC()
	tasks, err := repository.ListOrphanRetryImageTasks(
		now.Add(-2*time.Minute).Format(time.RFC3339Nano),
		now.Add(-24*time.Hour).Format(time.RFC3339Nano),
		50,
	)
	if err != nil {
		log.Printf("rescue orphan persistence tasks scan failed: %v", err)
		return
	}
	rescued := 0
	for _, task := range tasks {
		if len(task.ImageURLs) == 0 && task.ImageURL == "" {
			continue
		}
		fresh, found, err := repository.GetUserCanvasImageTask(task.UserID, task.ID)
		if err != nil || !found {
			continue
		}
		// 单图协议的任务 URL 存在 image_url 单值字段（image_urls 数组为空），两者都兼容。
		rescueURLs := fresh.ImageURLs
		if len(rescueURLs) == 0 && fresh.ImageURL != "" {
			rescueURLs = []string{fresh.ImageURL}
		}
		if len(rescueURLs) == 0 {
			continue
		}
		if _, err := QueueGeneratedImagePersistence(fresh, rescueURLs); err != nil {
			log.Printf("rescue orphan persistence task failed: task=%s err=%v", fresh.ID, err)
			continue
		}
		rescued++
	}
	if rescued > 0 {
		log.Printf("rescued orphan persistence tasks: count=%d", rescued)
	}
}

func StartStorageTransferWorker() {
	if value := strings.TrimSpace(os.Getenv("STORAGE_TRANSFER_WORKER_DISABLED")); value == "true" || value == "1" {
		return
	}
	storageTransferWorkerOnce.Do(func() {
		go func() {
			CleanupStorageSpool()
			ProcessStorageTransferJobs(context.Background())
			RescueOrphanPersistenceTasks(context.Background())
			ticker := time.NewTicker(5 * time.Second)
			defer ticker.Stop()
			cleanupTicker := time.NewTicker(time.Hour)
			defer cleanupTicker.Stop()
			rescueTicker := time.NewTicker(time.Minute)
			defer rescueTicker.Stop()
			for {
				select {
				case <-ticker.C:
					ProcessStorageTransferJobs(context.Background())
				case <-cleanupTicker.C:
					CleanupStorageSpool()
				case <-rescueTicker.C:
					RescueOrphanPersistenceTasks(context.Background())
				}
			}
		}()
	})
}

func ProcessStorageTransferJobs(ctx context.Context) {
	handled := map[string]bool{}
	for {
		current := time.Now().UTC()
		jobs, err := repository.ClaimStorageTransferJobs(10, current, current.Add(storageTransferLease).Format(time.RFC3339Nano), storageWorkerID)
		if err != nil {
			log.Printf("claim storage transfer jobs failed: %v", err)
			return
		}
		if len(jobs) == 0 {
			return
		}
		processed := false
		for _, job := range jobs {
			// 失败任务带着退避后的 next_attempt 重新变得可认领时跳过：
			// 重试交给下一次调度，避免同一次调用把退避变成连续空转。
			if handled[job.ID] {
				continue
			}
			handled[job.ID] = true
			processed = true
			jobCtx, cancel := context.WithTimeout(ctx, storageTransferJobTimeout)
			err := processStorageTransferJob(jobCtx, job)
			cancel()
			if err != nil {
				log.Printf("storage transfer failed job=%s err=%v", job.ID, err)
			}
		}
		if !processed {
			return
		}
	}
}

func processStorageTransferJob(ctx context.Context, job model.StorageTransferJob) error {
	if err := ctx.Err(); err != nil {
		// 取消/超时不计失败：释放租约立即可重试，交给下一轮调度。
		return releaseStorageJobOnCancel(job, err)
	}
	output, err := repository.GetGeneratedImageOutput(job.OutputID)
	if err != nil {
		return cancelOrphanedStorageJob(job, err)
	}
	task, err := repository.GetCanvasImageTaskByID(job.TaskID)
	if err != nil {
		return cancelOrphanedStorageJob(job, err)
	}
	provider, err := persistenceProvider(job)
	if err != nil {
		return failStorageTransfer(job, output, task, err)
	}
	if strings.TrimSpace(job.SpoolPath) == "" {
		spoolPath, mimeType, size, width, height, spoolErr := spoolGeneratedImage(ctx, output.ID, output.SourceURL)
		if ctx.Err() != nil {
			return releaseStorageJobOnCancel(job, ctx.Err())
		}
		if spoolErr != nil {
			return failStorageTransfer(job, output, task, spoolErr)
		}
		job.SpoolPath = spoolPath
		output.MimeType, output.Bytes, output.Width, output.Height = mimeType, size, width, height
	}
	ext := extensionForContentType(output.MimeType)
	objectKey := path.Join(strings.Trim(provider.PathPrefix, "/"), output.CreatedBy, task.ID, output.ID+ext)
	objectID := "generated-" + output.ID
	objectID, objectKey, err = repository.AllocateStorageObjectIdentity(objectID, objectKey, output.CreatedBy)
	if err != nil {
		return failStorageTransfer(job, output, task, err)
	}
	data, err := os.ReadFile(job.SpoolPath)
	if err != nil {
		return failStorageTransfer(job, output, task, err)
	}
	if err := ctx.Err(); err != nil {
		return releaseStorageJobOnCancel(job, err)
	}
	if err := putStorageObject(provider, objectKey, output.MimeType, data); err != nil {
		return failStorageTransfer(job, output, task, err)
	}
	sum := sha256.Sum256(data)
	object := model.StorageObject{ID: objectID, ProviderID: provider.ID, ObjectKey: objectKey, MimeType: output.MimeType, Bytes: output.Bytes, Width: output.Width, Height: output.Height, SHA256: hex.EncodeToString(sum[:]), CreatedBy: output.CreatedBy, Status: "active", CreatedAt: now()}
	extraObjects := []model.StorageObject{}
	// 网格/列表用小缩略图(320px, JPEG), 原图只在点开时加载。
	if thumbData, thumbMime, thumbKey := generateThumbnail(data, objectKey); thumbKey != "" {
		thumbID := "thumb-" + output.ID
		thumbID, thumbKey, identityErr := repository.AllocateStorageObjectIdentity(thumbID, thumbKey, output.CreatedBy)
		if identityErr != nil {
			log.Printf("thumbnail identity allocation failed output=%s err=%v (回退使用原图)", output.ID, identityErr)
		} else if err := putStorageObject(provider, thumbKey, thumbMime, thumbData); err == nil {
			thumbSum := sha256.Sum256(thumbData)
			extraObjects = append(extraObjects, model.StorageObject{ID: thumbID, ProviderID: provider.ID, ObjectKey: thumbKey, MimeType: thumbMime, Bytes: int64(len(thumbData)), SHA256: hex.EncodeToString(thumbSum[:]), CreatedBy: output.CreatedBy, Status: "active", CreatedAt: now()})
			output.ThumbnailObjectID, output.ThumbnailURL = thumbID, "/api/files/"+thumbID+"/content"
		} else {
			log.Printf("thumbnail upload failed output=%s err=%v (回退使用原图)", output.ID, err)
		}
	}
	current := now()
	output.StorageObjectID, output.StorageKey, output.URL = objectID, "server:"+objectID, "/api/files/"+objectID+"/content"
	output.Status, output.Error, output.UpdatedAt = model.PersistenceStatusCompleted, "", current
	job.Status, job.LastError, job.LeaseUntil, job.CompletedAt, job.UpdatedAt = model.PersistenceStatusCompleted, "", "", current, current
	refreshTaskPersistence(&task, output)
	task.UpdatedAt = current
	if err := repository.CompleteStorageTransfer(job, output, task, object, extraObjects); err != nil {
		return err
	}
	_ = os.Remove(job.SpoolPath)
	return nil
}

// releaseStorageJobOnCancel job 因取消/超时中断时释放租约并把状态回到 pending，
// 让下一轮调度立即重新认领，而不是等 15 分钟租约过期。不计入失败次数。
func releaseStorageJobOnCancel(job model.StorageTransferJob, cause error) error {
	db, err := repository.DB()
	if err != nil {
		return err
	}
	result := db.Model(&model.StorageTransferJob{}).
		Where("id = ? AND status = ? AND lease_token = ? AND version = ?", job.ID, model.PersistenceStatusProcessing, job.LeaseToken, job.Version).
		Updates(map[string]any{
			"status":          model.PersistenceStatusPending,
			"lease_until":     "",
			"lease_owner":     "",
			"lease_token":     "",
			"next_attempt_at": time.Now().UTC().Format(time.RFC3339Nano),
			"version":         job.Version + 1,
			"updated_at":      now(),
		})
	if result.Error != nil {
		return result.Error
	}
	return cause
}

// thumbnailLongSide 缩略图长边：默认 340px 宽的图片节点在 2x 屏上约需 680 物理像素，320px 会糊。
const thumbnailLongSide = 640

// generateThumbnail 把生成图缩到最长边 640px（不透明编码为 JPEG，带透明通道编码为 PNG）；不需要缩放时返回空 key。
func generateThumbnail(data []byte, objectKey string) ([]byte, string, string) {
	source, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, "", ""
	}
	bounds := source.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width <= 0 || height <= 0 {
		return nil, "", ""
	}
	longSide := width
	if height > longSide {
		longSide = height
	}
	if longSide <= thumbnailLongSide*5/4 {
		return nil, "", "" // 原图已经很小, 缩略图没有意义
	}
	scale := float64(thumbnailLongSide) / float64(longSide)
	target := image.NewRGBA(image.Rect(0, 0, max(1, int(float64(width)*scale)), max(1, int(float64(height)*scale))))
	xdraw.CatmullRom.Scale(target, target.Bounds(), source, bounds, xdraw.Src, nil)
	buffer := &bytes.Buffer{}
	base := path.Join(path.Dir(objectKey), "thumb-"+path.Base(strings.TrimSuffix(objectKey, path.Ext(objectKey))))
	// 带透明通道的图（如分层拆解结果）用 PNG：JPEG 不支持 alpha，透明区域会变成黑底。
	if !target.Opaque() {
		if err := png.Encode(buffer, target); err != nil {
			return nil, "", ""
		}
		return buffer.Bytes(), "image/png", base + ".png"
	}
	if err := jpeg.Encode(buffer, target, &jpeg.Options{Quality: 82}); err != nil {
		return nil, "", ""
	}
	return buffer.Bytes(), "image/jpeg", base + ".jpg"
}

// cancelOrphanedStorageJob 任务或输出已被删除时，把 job 终止并清理 spool 文件。
func cancelOrphanedStorageJob(job model.StorageTransferJob, cause error) error {
	job.Status, job.LastError, job.LeaseUntil, job.UpdatedAt = "cancelled", cause.Error(), "", now()
	if strings.TrimSpace(job.SpoolPath) != "" {
		_ = os.Remove(job.SpoolPath)
	}
	db, err := repository.DB()
	if err != nil {
		return err
	}
	return db.Model(&model.StorageTransferJob{}).Where("id = ?", job.ID).
		Updates(map[string]any{"status": "cancelled", "last_error": job.LastError, "lease_until": "", "lease_owner": "", "lease_token": "", "spool_path": "", "updated_at": now()}).Error
}

// CleanupStorageSpool 清理 spool 目录中的孤儿文件和已终止(cancelled) job 的残留文件。
// 处于 pending/processing/retry_wait 的 job 引用的文件永远不会被删除，
// 避免长退避重试中的任务在临时 URL 过期后彻底无法恢复。
func CleanupStorageSpool() {
	entries, err := os.ReadDir(config.Cfg.StorageSpoolDir)
	if err != nil {
		return
	}
	referenced, refErr := repository.ReferencedSpoolPaths()
	if refErr != nil {
		log.Printf("scan referenced spool paths failed: %v", refErr)
		return
	}
	active, activeErr := repository.ActiveStorageSpoolPaths()
	if activeErr != nil {
		log.Printf("scan active spool paths failed: %v", activeErr)
		return
	}
	cutoff := time.Now().Add(-24 * time.Hour)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		// job.SpoolPath 由 filepath 语义生成（Windows 反斜杠/Linux 正斜杠），
		// 必须用 filepath.Join 对齐，否则引用判断在 Windows 下永远不匹配。
		full := filepath.Join(config.Cfg.StorageSpoolDir, entry.Name())
		if active[full] {
			// 仍被未完成 job 引用：无论文件多旧都保留，等待任务终态。
			continue
		}
		if !referenced[full] {
			_ = os.Remove(full)
			continue
		}
		if info, statErr := entry.Info(); statErr == nil && info.ModTime().Before(cutoff) {
			_ = os.Remove(full)
		}
	}
}

func failStorageTransfer(job model.StorageTransferJob, output model.GeneratedImageOutput, task model.CanvasImageTask, cause error) error {
	job.Attempts++
	delay := time.Second * time.Duration(1<<min(job.Attempts, 10))
	if delay > time.Hour {
		delay = time.Hour
	}
	current := now()
	job.Status, job.LastError, job.LeaseUntil, job.NextAttemptAt, job.UpdatedAt = model.PersistenceStatusRetryWait, cause.Error(), "", time.Now().UTC().Add(delay).Format(time.RFC3339Nano), current
	output.Status, output.Error, output.UpdatedAt = model.PersistenceStatusRetryWait, cause.Error(), current
	task.PersistenceStatus, task.PersistenceError, task.UpdatedAt = model.PersistenceStatusRetryWait, cause.Error(), current
	if err := repository.FailStorageTransfer(job, output, task); err != nil {
		return err
	}
	return cause
}

func refreshTaskPersistence(task *model.CanvasImageTask, completed model.GeneratedImageOutput) {
	outputs, err := repository.GetGeneratedImageOutputs(task.ID)
	if err != nil {
		task.PersistenceStatus, task.PersistenceError = model.PersistenceStatusRetryWait, err.Error()
		return
	}
	allComplete := true
	primary := model.GeneratedImageOutput{}
	for _, output := range outputs {
		if output.ID == completed.ID {
			output = completed
		}
		if output.Status != model.PersistenceStatusCompleted {
			allComplete = false
		}
		if output.Status == model.PersistenceStatusCompleted && output.URL != "" && (primary.ID == "" || output.Position < primary.Position) {
			primary = output
		}
	}
	if !allComplete {
		task.PersistenceStatus = model.PersistenceStatusProcessing
		return
	}
	task.PersistenceStatus, task.PersistenceError = model.PersistenceStatusCompleted, ""
	task.ImageURLs = make([]string, 0, len(outputs))
	for _, output := range outputs {
		if output.ID == completed.ID {
			output = completed
		}
		if output.URL != "" {
			task.ImageURLs = append(task.ImageURLs, output.URL)
		}
	}
	if primary.ID != "" {
		task.ImageURL = primary.URL
		task.StorageKey = primary.StorageKey
		task.MimeType, task.Bytes, task.Width, task.Height = primary.MimeType, primary.Bytes, primary.Width, primary.Height
	}
}
