package middleware

import (
	"compress/gzip"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// GzipJSON 仅压缩 JSON 文本响应。不要套在 /files 上：图片已压缩，且会破坏 Range。
func GzipJSON() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !strings.Contains(c.GetHeader("Accept-Encoding"), "gzip") {
			c.Next()
			return
		}
		c.Header("Vary", "Accept-Encoding")
		writer := &gzipResponseWriter{ResponseWriter: c.Writer}
		c.Writer = writer
		c.Next()
		writer.close()
	}
}

type gzipResponseWriter struct {
	gin.ResponseWriter
	gz      *gzip.Writer
	started bool
	skip    bool
}

func (w *gzipResponseWriter) WriteHeader(status int) {
	w.prepare(status)
	w.ResponseWriter.WriteHeader(status)
}

func (w *gzipResponseWriter) Write(data []byte) (int, error) {
	if !w.started {
		w.WriteHeader(http.StatusOK)
	}
	if w.gz != nil {
		return w.gz.Write(data)
	}
	return w.ResponseWriter.Write(data)
}

func (w *gzipResponseWriter) WriteString(s string) (int, error) {
	return w.Write([]byte(s))
}

func (w *gzipResponseWriter) prepare(status int) {
	if w.started {
		return
	}
	w.started = true
	if status < 200 || status >= 300 {
		w.skip = true
		return
	}
	contentType := w.Header().Get("Content-Type")
	if contentType != "" && !strings.Contains(contentType, "json") && !strings.Contains(contentType, "text/") {
		w.skip = true
		return
	}
	w.Header().Del("Content-Length")
	w.Header().Set("Content-Encoding", "gzip")
	w.gz = gzip.NewWriter(w.ResponseWriter)
}

func (w *gzipResponseWriter) close() {
	if w.gz != nil {
		_ = w.gz.Close()
	}
}
