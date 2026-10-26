package service

import (
	"net/http/httptest"
	"testing"

	"github.com/fzheng466/infinite-canvas/config"
	"github.com/fzheng466/infinite-canvas/model"
)

func TestRequestOriginUsesConfiguredOrigin(t *testing.T) {
	previous := config.Cfg.PublicOrigin
	config.Cfg.PublicOrigin = "https://canvas.example.test"
	t.Cleanup(func() { config.Cfg.PublicOrigin = previous })
	r := httptest.NewRequest("GET", "http://attacker.test/", nil)
	r.Host = "attacker.test"
	r.Header.Set("X-Forwarded-Host", "attacker.test")
	r.Header.Set("X-Forwarded-Proto", "http")
	if got := RequestOrigin(r); got != "https://canvas.example.test" {
		t.Fatalf("RequestOrigin=%q", got)
	}
}

func TestOAuthStateIsRandomAndOneTime(t *testing.T) {
	first, err := NewOAuthState()
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewOAuthState()
	if err != nil {
		t.Fatal(err)
	}
	if first == second || len(first) < 32 || len(second) < 32 {
		t.Fatalf("states are not sufficiently random: %q %q", first, second)
	}
	request := httptest.NewRequest("GET", "https://canvas.example.test/api/auth/linux-do/callback", nil)
	recorder := httptest.NewRecorder()
	previous := config.Cfg.PublicOrigin
	config.Cfg.PublicOrigin = "https://canvas.example.test"
	t.Cleanup(func() { config.Cfg.PublicOrigin = previous })
	SetOAuthStateCookie(recorder, first, "/canvas/1")
	request.Header.Set("Cookie", recorder.Header().Get("Set-Cookie"))
	redirect, err := ConsumeOAuthState(request, first)
	if err != nil || redirect != "/canvas/1" {
		t.Fatalf("consume state redirect=%q err=%v", redirect, err)
	}
	if _, err := ConsumeOAuthState(request, second); err == nil {
		t.Fatal("wrong state should fail")
	}
}

func TestTokenClaimsUseConfiguredIssuerAudience(t *testing.T) {
	previous := config.Cfg
	config.Cfg.JWTSecret = "01234567890123456789012345678901"
	config.Cfg.JWTIssuer = "canvas-test"
	config.Cfg.JWTAudience = "canvas-web-test"
	t.Cleanup(func() { config.Cfg = previous })
	token, err := newToken(model.User{ID: "u1", Username: "u1", Role: model.UserRoleUser})
	if err != nil {
		t.Fatal(err)
	}
	claims, err := ParseToken(token)
	if err != nil {
		t.Fatal(err)
	}
	if claims.Issuer != "canvas-test" || len(claims.Audience) != 1 || claims.Audience[0] != "canvas-web-test" || claims.TokenUse != "user" {
		t.Fatalf("claims=%+v", claims)
	}
}
