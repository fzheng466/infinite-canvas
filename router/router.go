package router

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/fzheng466/infinite-canvas/handler"
	"github.com/fzheng466/infinite-canvas/middleware"
)

func New() *gin.Engine {
	router := gin.Default()
	router.RedirectTrailingSlash = false
	_ = router.SetTrustedProxies(nil)
	api := router.Group("/api")
	api.Use(middleware.SeedCSRF)
	api.GET("/health", func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})
	api.POST("/auth/register", middleware.LoginRateLimit, middleware.CSRF, gin.WrapF(handler.Register))
	api.POST("/auth/login", middleware.LoginRateLimit, middleware.CSRF, gin.WrapF(handler.Login))
	api.POST("/auth/logout", middleware.CSRF, gin.WrapF(handler.Logout))
	api.GET("/auth/linux-do/authorize", gin.WrapF(handler.LinuxDoAuthorize))
	api.GET("/auth/linux-do/callback", gin.WrapF(handler.LinuxDoCallback))
	api.GET("/auth/me", middleware.OptionalAuth, gin.WrapF(handler.CurrentUser))
	api.GET("/settings", gin.WrapF(handler.Settings))
	api.GET("/storage/config", gin.WrapF(handler.StorageConfig))
	api.GET("/files/:id", middleware.OptionalFileAuth, func(c *gin.Context) {
		handler.FileInfo(c.Writer, c.Request, c.Param("id"))
	})
	api.GET("/files/:id/content", middleware.OptionalFileAuth, func(c *gin.Context) {
		handler.FileContent(c.Writer, c.Request, c.Param("id"))
	})
	api.POST("/ai/direct-request", gin.WrapF(handler.PrepareDirectAIRequest))
	anonymousFiles := api.Group("/anonymous/files", middleware.AnonymousStorage, middleware.CSRF)
	anonymousFiles.POST("/session", func(c *gin.Context) { c.Status(http.StatusNoContent) })
	anonymousFiles.POST("", gin.WrapF(handler.UploadFile))
	anonymousFiles.DELETE("/:id", func(c *gin.Context) {
		handler.DeleteFile(c.Writer, c.Request, c.Param("id"))
	})
	v1 := api.Group("/v1", middleware.UserAuth, middleware.CSRF)
	v1.POST("/images/generations", gin.WrapF(handler.AIImagesGenerations))
	v1.POST("/images/edits", gin.WrapF(handler.AIImagesEdits))
	v1.POST("/responses", gin.WrapF(handler.AIResponses))
	v1.POST("/chat/completions", gin.WrapF(handler.AIChatCompletions))
	v1.POST("/audio/speech", gin.WrapF(handler.AIAudioSpeech))
	v1.GET("/tts/voices", gin.WrapF(handler.AITTSVoices))
	v1.POST("/canvas/tasks/delete", gin.WrapF(handler.DeleteUserCanvasTasks))
	// AutoDL 工作流代理会以服务端身份请求用户传入的任意 baseUrl，必须登录后才能调用。
	v1.POST("/ai/autodl/workflows", gin.WrapF(handler.AutoDLWorkflows))
	v1.POST("/canvas/image-tasks", gin.WrapF(handler.CreateCanvasImageTask))
	v1.GET("/canvas/image-tasks", gin.WrapF(handler.UserCanvasImageTasks))
	v1.POST("/canvas/image-tasks/status", gin.WrapF(handler.BatchCanvasImageTasks))
	v1.GET("/canvas/image-tasks/:id", func(c *gin.Context) {
		handler.GetCanvasImageTask(c.Writer, c.Request, c.Param("id"))
	})
	v1.DELETE("/canvas/image-tasks/:id", func(c *gin.Context) {
		handler.DeleteUserCanvasImageTask(c.Writer, c.Request, c.Param("id"))
	})
	v1.POST("/canvas/audio-tasks", gin.WrapF(handler.CreateCanvasAudioTask))
	v1.GET("/canvas/audio-tasks/:id", func(c *gin.Context) {
		handler.GetCanvasAudioTask(c.Writer, c.Request, c.Param("id"))
	})
	v1.POST("/ai-logs", gin.WrapF(handler.ClientAICallLog))
	v1.POST("/videos", gin.WrapF(handler.AIVideos))
	v1.GET("/video-tasks", gin.WrapF(handler.UserVideoTasks))
	v1.DELETE("/video-tasks/:id", func(c *gin.Context) {
		handler.DeleteUserVideoTask(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/videos/:id", func(c *gin.Context) {
		handler.AIVideo(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/videos/:id/content", func(c *gin.Context) {
		handler.AIVideoContent(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/workflows", gin.WrapF(handler.UserWorkflows))
	v1.POST("/workflows", gin.WrapF(handler.SaveUserWorkflow))
	v1.POST("/workflows/agent-draft", gin.WrapF(handler.DraftUserWorkflow))
	v1.DELETE("/workflows/:id", func(c *gin.Context) {
		handler.DeleteUserWorkflow(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/agent-skills", gin.WrapF(handler.UserAgentSkills))
	v1.POST("/agent-skills", gin.WrapF(handler.SaveUserAgentSkill))
	v1.DELETE("/agent-skills/:id", func(c *gin.Context) {
		handler.DeleteUserAgentSkill(c.Writer, c.Request, c.Param("id"))
	})
	v1.POST("/storage/measure", gin.WrapF(handler.MeasureUserStorageProvider))
	v1.POST("/files", gin.WrapF(handler.UploadFile))
	v1.POST("/files/direct", gin.WrapF(handler.RegisterDirectFile))
	v1.POST("/files/:id/sign", func(c *gin.Context) {
		handler.SignFileURL(c.Writer, c.Request, c.Param("id"))
	})
	v1.DELETE("/files/:id", func(c *gin.Context) {
		handler.DeleteFile(c.Writer, c.Request, c.Param("id"))
	})
	v1.DELETE("/files/:id/record", func(c *gin.Context) {
		handler.DeleteDirectFileRecord(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/user-config", gin.WrapF(handler.UserConfig))
	v1.POST("/user-config/model", gin.WrapF(handler.SaveUserModelConfig))
	v1.POST("/user-config/storage", gin.WrapF(handler.SaveUserStorageProvider))
		projects := v1.Group("/canvas/projects", middleware.GzipJSON())
		projects.GET("", gin.WrapF(handler.UserCanvasProjects))
		projects.POST("", gin.WrapF(handler.SaveUserCanvasProject))
		projects.GET("/check/:id", func(c *gin.Context) {
			handler.CheckUserCanvasProject(c.Writer, c.Request, c.Param("id"))
		})
		projects.POST("/sync", gin.WrapF(handler.SyncUserCanvasProjects))
		projects.POST("/delete", gin.WrapF(handler.DeleteUserCanvasProjects))
	v1.GET("/user-data/image-history", gin.WrapF(handler.UserImageHistory))
	v1.POST("/user-data/image-history", gin.WrapF(handler.SaveUserImageHistory))
	v1.GET("/generation-logs/videos", gin.WrapF(handler.UserVideoGenerationLogs))
	v1.POST("/generation-logs/videos", gin.WrapF(handler.SaveUserVideoGenerationLogs))
	v1.POST("/generation-logs/videos/delete", gin.WrapF(handler.DeleteUserVideoGenerationLogs))
	v1.DELETE("/generation-logs/videos/:id", func(c *gin.Context) {
		handler.DeleteUserVideoGenerationLog(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/generation-logs/images", gin.WrapF(handler.UserImageGenerationLogs))
	v1.POST("/generation-logs/images", gin.WrapF(handler.SaveUserImageGenerationLogs))
	v1.POST("/generation-logs/images/delete", gin.WrapF(handler.DeleteUserImageGenerationLogs))
	v1.DELETE("/generation-logs/images/:id", func(c *gin.Context) {
		handler.DeleteUserImageGenerationLog(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/user-data/assets", gin.WrapF(handler.UserAssetData))
	v1.POST("/user-data/assets", gin.WrapF(handler.SaveUserAssetData))
	api.GET("/proxy-image", gin.WrapF(handler.ProxyImage))
	api.GET("/prompts", middleware.OptionalAuth, gin.WrapF(handler.Prompts))
	api.GET("/agent-skills", gin.WrapF(handler.AgentSkills))
	api.GET("/agent-skills/:id/file", func(c *gin.Context) {
		handler.AgentSkillFile(c.Writer, c.Request, c.Param("id"))
	})
	api.GET("/assets", middleware.OptionalAuth, gin.WrapF(handler.Assets))
	api.POST("/admin/login", middleware.LoginRateLimit, middleware.CSRF, gin.WrapF(handler.AdminLogin))

	admin := api.Group("/admin", middleware.AdminAuth, middleware.CSRF)
	admin.GET("/users", gin.WrapF(handler.AdminUsers))
	admin.POST("/users", gin.WrapF(handler.AdminSaveUser))
	admin.POST("/users/:id/credits", func(c *gin.Context) {
		handler.AdminAdjustUserCredits(c.Writer, c.Request, c.Param("id"))
	})
	admin.DELETE("/users/:id", func(c *gin.Context) {
		handler.AdminDeleteUser(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/credit-logs", gin.WrapF(handler.AdminCreditLogs))
	admin.POST("/credit-logs", gin.WrapF(handler.AdminSaveCreditLog))
	admin.DELETE("/credit-logs/:id", func(c *gin.Context) {
		handler.AdminDeleteCreditLog(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/ai-logs", gin.WrapF(handler.AdminAICallLogs))
	admin.DELETE("/ai-logs", gin.WrapF(handler.AdminDeleteAICallLogs))
	admin.GET("/settings", gin.WrapF(handler.AdminSettings))
	admin.POST("/settings", gin.WrapF(handler.AdminSaveSettings))
	admin.POST("/settings/channel-models", gin.WrapF(handler.AdminChannelModels))
	admin.POST("/settings/channel-test", gin.WrapF(handler.AdminTestChannelModel))
	admin.POST("/storage/measure", gin.WrapF(handler.AdminMeasureStorageProvider))
	admin.GET("/prompt-categories", gin.WrapF(handler.AdminPromptCategories))
	admin.POST("/prompt-categories/sync", gin.WrapF(handler.AdminSyncPromptCategories))
	admin.POST("/prompt-categories/sync-all", gin.WrapF(handler.AdminSyncAllPromptCategories))
	admin.GET("/prompts", gin.WrapF(handler.AdminPrompts))
	admin.POST("/prompts", gin.WrapF(handler.AdminSavePrompt))
	admin.POST("/prompts/batch-delete", gin.WrapF(handler.AdminDeletePrompts))
	admin.DELETE("/prompts/:id", func(c *gin.Context) {
		handler.AdminDeletePrompt(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/agent-skills", gin.WrapF(handler.AdminAgentSkills))
	admin.GET("/agent-skills/:id/files", func(c *gin.Context) {
		handler.AdminAgentSkillFiles(c.Writer, c.Request, c.Param("id"))
	})
	admin.POST("/agent-skills", gin.WrapF(handler.AdminSaveAgentSkill))
	admin.DELETE("/agent-skills/:id", func(c *gin.Context) {
		handler.AdminDeleteAgentSkill(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/assets", gin.WrapF(handler.AdminAssets))
	admin.POST("/assets", gin.WrapF(handler.AdminSaveAsset))
	admin.DELETE("/assets/:id", func(c *gin.Context) {
		handler.AdminDeleteAsset(c.Writer, c.Request, c.Param("id"))
	})

	router.NoRoute(middleware.NotFoundJSON)

	return router
}
