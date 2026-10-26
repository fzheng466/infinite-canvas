package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/fzheng466/infinite-canvas/config"
)

func TestCSRFAllowsBearerMutation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(CSRF)
	r.POST("/write", func(c *gin.Context) { c.Status(http.StatusNoContent) })
	req := httptest.NewRequest(http.MethodPost, "/write", nil)
	req.Header.Set("Authorization", "Bearer test")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status=%d", rec.Code)
	}
}

func TestCSRFRejectsCookieMutationWithoutToken(t *testing.T) {
	previous := config.Cfg.PublicOrigin
	config.Cfg.PublicOrigin = "http://127.0.0.1:3100"
	t.Cleanup(func() { config.Cfg.PublicOrigin = previous })
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(CSRF)
	r.POST("/write", func(c *gin.Context) { c.Status(http.StatusNoContent) })
	req := httptest.NewRequest(http.MethodPost, "/write", nil)
	req.Header.Set("Origin", "http://127.0.0.1:3100")
	req.AddCookie(&http.Cookie{Name: CSRFTokenCookieName, Value: "token"})
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status=%d", rec.Code)
	}
}

func TestCSRFAllowsCookieMutationWithSameOriginToken(t *testing.T) {
	previous := config.Cfg.PublicOrigin
	config.Cfg.PublicOrigin = "http://127.0.0.1:3100"
	t.Cleanup(func() { config.Cfg.PublicOrigin = previous })
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(CSRF)
	r.POST("/write", func(c *gin.Context) { c.Status(http.StatusNoContent) })
	req := httptest.NewRequest(http.MethodPost, "/write", nil)
	req.Header.Set("Origin", "http://127.0.0.1:3100")
	req.AddCookie(&http.Cookie{Name: CSRFTokenCookieName, Value: "token"})
	req.Header.Set(CSRFTokenHeaderName, "token")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status=%d", rec.Code)
	}
}
