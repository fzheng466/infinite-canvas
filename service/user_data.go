package service

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/fzheng466/infinite-canvas/model"
	"github.com/fzheng466/infinite-canvas/repository"
)

type UserConfigPayload struct {
	ModelConfig          json.RawMessage       `json:"modelConfig,omitempty"`
	ModelConfigUpdatedAt string                `json:"modelConfigUpdatedAt,omitempty"`
	StorageProvider      *UserStorageProviders `json:"storageProvider,omitempty"`
	ImageHistory         json.RawMessage       `json:"imageHistory,omitempty"`
	AssetData            json.RawMessage       `json:"assetData,omitempty"`
	SyncCapabilities     map[string]bool       `json:"syncCapabilities,omitempty"`
}

type StorageObjectProviderInput struct {
	Enabled         *bool  `json:"enabled,omitempty"`
	Name            string `json:"name"`
	Type            string `json:"type"`
	Endpoint        string `json:"endpoint"`
	Region          string `json:"region"`
	Bucket          string `json:"bucket"`
	AccessKeyID     string `json:"accessKeyId"`
	SecretAccessKey string `json:"secretAccessKey"`
	PublicBaseURL   string `json:"publicBaseUrl"`
	PathPrefix      string `json:"pathPrefix"`
	Username        string `json:"username"`
	Password        string `json:"password"`
}

type UserStorageProviders struct {
	S3     *StorageObjectProviderInput `json:"s3,omitempty"`
	WebDAV *StorageObjectProviderInput `json:"webdav,omitempty"`
}

type userModelConfigInput struct {
	LocalChannels []userLocalModelChannelInput `json:"localChannels"`
}

type userLocalModelChannelInput struct {
	ID       string   `json:"id"`
	Protocol string   `json:"protocol"`
	Name     string   `json:"name"`
	BaseURL  string   `json:"baseUrl"`
	APIKey   string   `json:"apiKey"`
	Models   []string `json:"models"`
}

// ModelConfigSaveConflict 表示模型配置保存被拒：服务器上的渠道配置比客户端读取的更新，
// 且本次保存会把已有内容的渠道列表覆盖为空（典型场景：新浏览器携带空默认配置整包覆盖）。
type ModelConfigSaveConflict struct {
	Stored          json.RawMessage
	StoredUpdatedAt string
}

func (e *ModelConfigSaveConflict) Error() string {
	return "渠道配置已在其他窗口更新"
}

// localChannelInputsAreReal：渠道只要填了 Key 或声明过模型即视为"有内容"，
// 默认占位（空 Key、空模型列表）不算，避免占位渠道让保护误判。
func localChannelInputsAreReal(channels []userLocalModelChannelInput) bool {
	for _, channel := range channels {
		if strings.TrimSpace(channel.APIKey) != "" || len(channel.Models) > 0 {
			return true
		}
	}
	return false
}

func localChannelsHaveRealChannel(rawModelConfig string) bool {
	if strings.TrimSpace(rawModelConfig) == "" {
		return false
	}
	var modelConfig userModelConfigInput
	if err := json.Unmarshal([]byte(rawModelConfig), &modelConfig); err != nil {
		return false
	}
	return localChannelInputsAreReal(modelConfig.LocalChannels)
}

// modelConfigBaseIsStale：客户端没带基准时间、基准解析失败都按"过期"处理（保守拦截）；
// 服务器时间不可解析时放行，避免时间异常导致正常保存被误拦。
func modelConfigBaseIsStale(baseUpdatedAt string, storedUpdatedAt string) bool {
	if strings.TrimSpace(baseUpdatedAt) == "" {
		return true
	}
	base, err := time.Parse(time.RFC3339Nano, baseUpdatedAt)
	if err != nil {
		return true
	}
	stored, err := time.Parse(time.RFC3339Nano, storedUpdatedAt)
	if err != nil {
		return false
	}
	return stored.After(base)
}

func SelectUserLocalModelChannelForModel(userID string, modelName string, channelID string) (model.ModelChannel, error) {
	userID = strings.TrimSpace(userID)
	modelName = strings.TrimSpace(modelName)
	channelID = strings.TrimSpace(channelID)
	if userID == "" {
		return model.ModelChannel{}, errors.New("请先登录")
	}
	if modelName == "" {
		return model.ModelChannel{}, errors.New("缺少模型名称")
	}
	if channelID == "" {
		return model.ModelChannel{}, errors.New("缺少模型渠道")
	}
	config, ok, err := repository.GetUserConfig(userID)
	if err != nil {
		return model.ModelChannel{}, err
	}
	if !ok || strings.TrimSpace(config.ModelConfig) == "" {
		return model.ModelChannel{}, errors.New("本地渠道不存在")
	}
	var modelConfig userModelConfigInput
	if err := json.Unmarshal([]byte(config.ModelConfig), &modelConfig); err != nil {
		return model.ModelChannel{}, err
	}
	for _, channel := range modelConfig.LocalChannels {
		if strings.TrimSpace(channel.ID) != channelID {
			continue
		}
		baseURL := strings.TrimSpace(channel.BaseURL)
		apiKey := strings.TrimSpace(channel.APIKey)
		if baseURL == "" || apiKey == "" {
			return model.ModelChannel{}, errors.New("本地渠道配置不完整")
		}
		parsedURL, parseErr := url.Parse(baseURL)
		if parseErr != nil || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") || parsedURL.Host == "" || parsedURL.User != nil || parsedURL.RawQuery != "" || parsedURL.Fragment != "" {
			return model.ModelChannel{}, errors.New("本地渠道地址无效")
		}
		if hostResolvesToBlockedIP(parsedURL.Hostname()) {
			return model.ModelChannel{}, errors.New("本地渠道地址禁止访问内网")
		}
		models := userLocalChannelModels(channel.Models)
		if len(models) == 0 || !userLocalChannelHasModel(models, modelName) {
			return model.ModelChannel{}, errors.New("本地渠道未声明该模型")
		}
		protocol := strings.ToLower(strings.TrimSpace(channel.Protocol))
		if protocol == "" {
			protocol = "openai"
		}
		return model.ModelChannel{
			ID:       channelID,
			Protocol: protocol,
			Name:     firstVideoTaskValue(strings.TrimSpace(channel.Name), "本地直连"),
			BaseURL:  baseURL,
			APIKey:   apiKey,
			Models:   models,
			Weight:   1,
			Timeout:  600,
			Enabled:  true,
		}, nil
	}
	return model.ModelChannel{}, errors.New("本地渠道不存在")
}

func hostResolvesToBlockedIP(host string) bool {
	if ip := net.ParseIP(host); ip != nil {
		return isBlockedProxyIP(ip)
	}
	ips, err := net.LookupIP(host)
	if err != nil || len(ips) == 0 {
		return true
	}
	for _, ip := range ips {
		if isBlockedProxyIP(ip) {
			return true
		}
	}
	return false
}

func userLocalChannelModels(models []string) []string {
	result := make([]string, 0, len(models))
	seen := map[string]bool{}
	for _, item := range models {
		modelName := strings.TrimSpace(item)
		if modelName == "" || seen[modelName] {
			continue
		}
		result = append(result, modelName)
		seen[modelName] = true
	}
	return result
}

func userLocalChannelHasModel(models []string, modelName string) bool {
	for _, item := range models {
		if strings.EqualFold(strings.TrimSpace(item), modelName) {
			return true
		}
	}
	return false
}

func CurrentUserConfig(ctx context.Context) (UserConfigPayload, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return UserConfigPayload{}, errors.New("请先登录")
	}
	config, ok, err := repository.GetUserConfig(user.ID)
	if err != nil {
		return UserConfigPayload{}, err
	}
	result := UserConfigPayload{
		SyncCapabilities: map[string]bool{
			"userData":  true,
			"workflows": true,
			"assets":    true,
		},
	}
	if !ok {
		return result, nil
	}
	result.ModelConfigUpdatedAt = config.UpdatedAt
	if strings.TrimSpace(config.ModelConfig) != "" {
		result.ModelConfig = json.RawMessage(config.ModelConfig)
	}
	if strings.TrimSpace(config.StorageProvider) != "" {
		providers := readUserStorageProviders(config.StorageProvider)
		var syncFlags struct {
			SyncStorageConfig       bool `json:"syncStorageConfig"`
			SyncWebDAVStorageConfig bool `json:"syncWebDAVStorageConfig"`
		}
		_ = json.Unmarshal(result.ModelConfig, &syncFlags)
		if !syncFlags.SyncStorageConfig {
			providers.S3 = nil
		}
		if !syncFlags.SyncWebDAVStorageConfig {
			providers.WebDAV = nil
		}
		if providers.S3 != nil || providers.WebDAV != nil {
			result.StorageProvider = &providers
		}
	}
	if strings.TrimSpace(config.ImageHistory) != "" {
		result.ImageHistory = json.RawMessage(config.ImageHistory)
	}
	if strings.TrimSpace(config.AssetData) != "" {
		result.AssetData = json.RawMessage(config.AssetData)
	}
	return result, nil
}

func readUserStorageProviders(raw string) UserStorageProviders {
	var providers UserStorageProviders
	if strings.TrimSpace(raw) != "" {
		_ = json.Unmarshal([]byte(raw), &providers)
	}
	return providers
}

func SaveCurrentUserModelConfig(ctx context.Context, raw json.RawMessage, baseUpdatedAt string, force bool) (UserConfigPayload, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return UserConfigPayload{}, errors.New("请先登录")
	}
	public, err := PublicSettings()
	if err != nil {
		return UserConfigPayload{}, err
	}
	var incoming userModelConfigInput
	if err := json.Unmarshal(raw, &incoming); err != nil {
		return UserConfigPayload{}, errors.New("模型配置格式错误")
	}
	if user.Role != model.UserRoleAdmin && (public.ModelChannel.AllowCustomChannel == nil || !*public.ModelChannel.AllowCustomChannel) && len(incoming.LocalChannels) > 0 {
		return UserConfigPayload{}, errors.New("管理员未开放自定义渠道")
	}
	config, _, err := repository.GetUserConfig(user.ID)
	if err != nil {
		return UserConfigPayload{}, err
	}
	// 防误覆盖：服务器已有带内容的渠道、本次保存要把渠道清空、且客户端手里的版本比服务器旧，
	// 三个条件同时满足才拦截；客户端确认后可带 force 强制覆盖。
	if !force && config.UserID != "" &&
		localChannelsHaveRealChannel(config.ModelConfig) &&
		!localChannelInputsAreReal(incoming.LocalChannels) &&
		modelConfigBaseIsStale(baseUpdatedAt, config.UpdatedAt) {
		return UserConfigPayload{}, &ModelConfigSaveConflict{
			Stored:          json.RawMessage(config.ModelConfig),
			StoredUpdatedAt: config.UpdatedAt,
		}
	}
	current := now()
	if config.UserID == "" {
		config.UserID = user.ID
		config.CreatedAt = current
	}
	config.ModelConfig = string(raw)
	config.UpdatedAt = current
	if _, err := repository.SaveUserConfig(config); err != nil {
		return UserConfigPayload{}, err
	}
	return CurrentUserConfig(ctx)
}

func CurrentUserImageHistory(ctx context.Context) (json.RawMessage, error) {
	config, err := currentUserConfig(ctx)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(config.ImageHistory) == "" {
		return json.RawMessage(`{"logs":[],"categories":[]}`), nil
	}
	return json.RawMessage(config.ImageHistory), nil
}

func SaveCurrentUserImageHistory(ctx context.Context, raw json.RawMessage) (json.RawMessage, error) {
	config, err := saveCurrentUserConfigField(ctx, func(config *model.UserConfig) {
		config.ImageHistory = string(raw)
	})
	if err != nil {
		return nil, err
	}
	return json.RawMessage(config.ImageHistory), nil
}

func CurrentUserAssetData(ctx context.Context) (json.RawMessage, error) {
	config, err := currentUserConfig(ctx)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(config.AssetData) == "" {
		return json.RawMessage(`{"assets":[]}`), nil
	}
	return json.RawMessage(config.AssetData), nil
}

func SaveCurrentUserAssetData(ctx context.Context, raw json.RawMessage) (json.RawMessage, error) {
	config, err := saveCurrentUserConfigField(ctx, func(config *model.UserConfig) {
		config.AssetData = string(raw)
	})
	if err != nil {
		return nil, err
	}
	return json.RawMessage(config.AssetData), nil
}

func currentUserConfig(ctx context.Context) (model.UserConfig, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return model.UserConfig{}, errors.New("请先登录")
	}
	config, _, err := repository.GetUserConfig(user.ID)
	if err != nil {
		return model.UserConfig{}, err
	}
	if config.UserID == "" {
		config.UserID = user.ID
	}
	return config, nil
}

func saveCurrentUserConfigField(ctx context.Context, patch func(config *model.UserConfig)) (model.UserConfig, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return model.UserConfig{}, errors.New("请先登录")
	}
	config, _, err := repository.GetUserConfig(user.ID)
	if err != nil {
		return model.UserConfig{}, err
	}
	current := now()
	if config.UserID == "" {
		config.UserID = user.ID
		config.CreatedAt = current
	}
	patch(&config)
	config.UpdatedAt = current
	return repository.SaveUserConfig(config)
}
