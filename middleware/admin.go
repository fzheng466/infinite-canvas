package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/fzheng466/infinite-canvas/handler"
	"github.com/fzheng466/infinite-canvas/model"
	"github.com/fzheng466/infinite-canvas/service"
)

func AdminAuth(c *gin.Context) {
	user, token, fromHeader, ok := authUserEx(c)
	if !ok || user.Role != model.UserRoleAdmin {
		handler.FailWithStatus(c.Writer, http.StatusUnauthorized, "未登录或权限不足")
		c.Abort()
		return
	}
	backfillAuthCookie(c, token, fromHeader)
	c.Request = c.Request.WithContext(service.WithUser(c.Request.Context(), user))
	c.Next()
}

func UserAuth(c *gin.Context) {
	user, token, fromHeader, ok := authUserEx(c)
	if !ok || user.Role == model.UserRoleGuest {
		handler.FailWithStatus(c.Writer, http.StatusUnauthorized, "未登录或权限不足")
		c.Abort()
		return
	}
	backfillAuthCookie(c, token, fromHeader)
	c.Request = c.Request.WithContext(service.WithUser(c.Request.Context(), user))
	c.Next()
}

// backfillAuthCookie 滑动修复：调用方持有效 Bearer 但缺少登录 Cookie（重装系统/
// 重开浏览器/清理 Cookie 后）时，自动补发与 token 同期到期的持久化 Cookie。
// 否则 <img>/<video> 私有文件请求会 401，画布图片全部不显示且需要手动重新登录。
func backfillAuthCookie(c *gin.Context, token string, fromHeader bool) {
	if !fromHeader || strings.TrimSpace(token) == "" {
		return
	}
	if cookie, err := c.Cookie(service.AuthCookieName); err == nil && strings.TrimSpace(cookie) != "" {
		return
	}
	service.SetAuthCookie(c.Writer, token)
}

func OptionalAuth(c *gin.Context) {
	user, token, fromHeader, ok := authUserEx(c)
	if ok {
		if user.Role != model.UserRoleGuest {
			backfillAuthCookie(c, token, fromHeader)
		}
		c.Request = c.Request.WithContext(service.WithUser(c.Request.Context(), user))
	}
	c.Next()
}

// OptionalFileAuth accepts only Authorization headers. File query access uses a scoped short-lived signature.
func OptionalFileAuth(c *gin.Context) {
	if user, ok := authUser(c); ok {
		c.Request = c.Request.WithContext(service.WithUser(c.Request.Context(), user))
	}
	c.Next()
}

func NotFoundJSON(c *gin.Context) {
	c.JSON(http.StatusNotFound, gin.H{"code": 1, "data": nil, "msg": "接口不存在"})
}

func authUser(c *gin.Context) (model.AuthUser, bool) {
	user, _, _, ok := authUserEx(c)
	return user, ok
}

func authUserEx(c *gin.Context) (model.AuthUser, string, bool, bool) {
	token := strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer ")
	fromHeader := strings.TrimSpace(token) != ""
	if !fromHeader {
		// 同源 Cookie 兜底：<img>/<video> 无法附加 Authorization 头，
		// 登录时由服务端写入的 HttpOnly Cookie 承载同一 JWT。
		cookie, err := c.Cookie(service.AuthCookieName)
		if err != nil || strings.TrimSpace(cookie) == "" {
			return model.AuthUser{}, "", false, false
		}
		token = cookie
	}
	user, ok := service.CurrentAuthUser(token)
	if !ok {
		return model.AuthUser{}, "", false, false
	}
	return user, token, fromHeader, true
}
