package middleware

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/fzheng466/infinite-canvas/config"
	"github.com/fzheng466/infinite-canvas/service"
)

const CSRFTokenCookieName = "canvas_csrf"
const CSRFTokenHeaderName = "X-CSRF-Token"

func SeedCSRF(c *gin.Context) {
	EnsureCSRFToken(c.Writer, c.Request)
	c.Next()
}

func CSRF(c *gin.Context) {
	if c.Request.Method == http.MethodGet || c.Request.Method == http.MethodHead || c.Request.Method == http.MethodOptions {
		c.Next()
		return
	}
	path := c.Request.URL.Path
	if path == "/api/auth/login" || path == "/api/auth/register" || path == "/api/anonymous/files/session" || path == "/api/admin/login" {
		if !sameOrigin(c.Request) && strings.TrimSpace(c.GetHeader("Origin")) != "" {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"code": 1, "data": nil, "msg": "请求来源无效"})
			return
		}
		c.Next()
		return
	}
	if c.Request.Method == http.MethodGet || c.Request.Method == http.MethodHead || c.Request.Method == http.MethodOptions {
		c.Next()
		return
	}
	if strings.TrimSpace(c.GetHeader("Authorization")) != "" {
		c.Next()
		return
	}
	if !sameOrigin(c.Request) || !validCSRFToken(c.Request) {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"code": 1, "data": nil, "msg": "CSRF 校验失败"})
		return
	}
	c.Next()
}

func EnsureCSRFToken(w http.ResponseWriter, r *http.Request) string {
	if cookie, err := r.Cookie(CSRFTokenCookieName); err == nil && strings.TrimSpace(cookie.Value) != "" {
		return cookie.Value
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return ""
	}
	token := hex.EncodeToString(buf)
	secure := strings.HasPrefix(strings.ToLower(strings.TrimSpace(config.Cfg.PublicOrigin)), "https://")
	http.SetCookie(w, &http.Cookie{Name: CSRFTokenCookieName, Value: token, Path: "/", Secure: secure, SameSite: http.SameSiteLaxMode})
	return token
}

func sameOrigin(r *http.Request) bool {
	expected := service.RequestOrigin(r)
	for _, value := range []string{r.Header.Get("Origin"), r.Header.Get("Referer")} {
		if strings.TrimSpace(value) == "" {
			continue
		}
		parsed, err := url.Parse(value)
		if err == nil && parsed.Scheme+"://"+parsed.Host == expected {
			return true
		}
		return false
	}
	return false
}

func validCSRFToken(r *http.Request) bool {
	cookie, err := r.Cookie(CSRFTokenCookieName)
	if err != nil || strings.TrimSpace(cookie.Value) == "" {
		return false
	}
	header := strings.TrimSpace(r.Header.Get(CSRFTokenHeaderName))
	return header != "" && header == cookie.Value
}
