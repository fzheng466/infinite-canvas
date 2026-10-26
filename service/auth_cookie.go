package service

import (
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/fzheng466/infinite-canvas/config"
)

// AuthCookieName 是登录态的同源 HttpOnly Cookie，让 <img>/<video> 这类
// 无法附加 Authorization 头的浏览器请求也能通过私有文件鉴权。
const AuthCookieName = "canvas_auth"

func authCookieSecure() bool {
	parsed, err := url.Parse(strings.TrimSpace(config.Cfg.PublicOrigin))
	return err == nil && parsed.Scheme == "https"
}

// SetAuthCookie 登录/注册成功后写入持久化 Cookie，有效期与 JWT 对齐。
// 之前是会话 Cookie（浏览器关闭即失效），而 localStorage token 有 7 天：
// 重开浏览器后 API 正常（Bearer）但 <img>/<video> 私有文件 401，画布图片全部不显示。
func SetAuthCookie(w http.ResponseWriter, token string) {
	maxAge := authCookieMaxAge(token)
	http.SetCookie(w, &http.Cookie{
		Name:     AuthCookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   maxAge,
		Expires:  time.Now().Add(time.Duration(maxAge) * time.Second),
		HttpOnly: true,
		Secure:   authCookieSecure(),
		SameSite: http.SameSiteLaxMode,
	})
}

// authCookieMaxAge 与 token 的 exp 精确对齐；解析失败时退回配置的过期小时数（默认 168h）。
func authCookieMaxAge(token string) int {
	if claims, err := ParseToken(token); err == nil && claims.ExpiresAt != nil {
		if seconds := int(time.Until(claims.ExpiresAt.Time).Seconds()); seconds > 0 {
			return seconds
		}
	}
	expireHours := config.Cfg.JWTExpireHours
	if expireHours <= 0 {
		expireHours = 168
	}
	return expireHours * 3600
}

// ClearAuthCookie 登出时清除会话 Cookie。
func ClearAuthCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     AuthCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   authCookieSecure(),
		SameSite: http.SameSiteLaxMode,
		Expires:  time.Unix(0, 0),
	})
}
