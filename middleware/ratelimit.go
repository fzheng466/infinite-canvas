package middleware

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

const loginRateLimitPerMinute = 10

type loginRateLimiter struct {
	mu      sync.Mutex
	counters map[string]*loginRateCounter
}

type loginRateCounter struct {
	count int
	reset time.Time
}

var loginLimiter = &loginRateLimiter{counters: map[string]*loginRateCounter{}}

// LoginRateLimit 登录/注册类接口的粗粒度限流：单 IP 每分钟最多 10 次，超出返回 429，
// 用于阻挡口令暴力破解。反向代理后 ClientIP 取到的是代理地址时，会退化为全站共享计数；
// 生产环境建议同时在网关层做限流。
func LoginRateLimit(c *gin.Context) {
	key := c.ClientIP() + "|" + c.FullPath()
	now := time.Now()
	loginLimiter.mu.Lock()
	counter, ok := loginLimiter.counters[key]
	if !ok || now.After(counter.reset) {
		counter = &loginRateCounter{reset: now.Add(time.Minute)}
		loginLimiter.counters[key] = counter
		if len(loginLimiter.counters) > 65536 {
			for k, v := range loginLimiter.counters {
				if now.After(v.reset) {
					delete(loginLimiter.counters, k)
				}
			}
		}
	}
	counter.count++
	count := counter.count
	loginLimiter.mu.Unlock()
	if count > loginRateLimitPerMinute {
		c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"code": 1, "data": nil, "msg": "请求过于频繁，请稍后再试"})
		return
	}
	c.Next()
}
