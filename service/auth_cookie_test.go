package service

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestAuthCookieMaxAgeAlignsWithTokenExpiry(t *testing.T) {
	user := model.User{ID: "cookie-user", Username: "cookie-user", Role: model.UserRoleUser, Status: model.UserStatusActive}
	token, err := newToken(user)
	if err != nil {
		t.Fatalf("newToken: %v", err)
	}
	maxAge := authCookieMaxAge(token)
	if maxAge <= 0 || maxAge > 168*3600+60 {
		t.Fatalf("maxAge out of token lifetime range: %d", maxAge)
	}

	recorder := httptest.NewRecorder()
	SetAuthCookie(recorder, token)
	cookies := recorder.Result().Cookies()
	var found *struct {
		maxAge int
		name   string
	}
	for _, cookie := range cookies {
		if cookie.Name == AuthCookieName {
			found = &struct {
				maxAge int
				name   string
			}{cookie.MaxAge, cookie.Name}
		}
	}
	if found == nil {
		t.Fatal("auth cookie not set")
	}
	if found.maxAge <= 0 {
		t.Fatalf("cookie must be persistent (MaxAge>0), got %d", found.maxAge)
	}

	// 无效 token：退回配置默认小时数（测试环境未配置时为 168h）。
	if authCookieMaxAge("garbage-token") != 168*3600 {
		t.Fatalf("fallback maxAge should be default 168h")
	}
	if !strings.HasPrefix(AuthCookieName, "canvas_") {
		t.Fatal("unexpected cookie name")
	}
	_ = time.Now()
}
