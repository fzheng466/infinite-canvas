package repository

import (
	"errors"
	"testing"
	"time"
)

func TestWithSQLitePragmas(t *testing.T) {
	tests := []struct {
		name string
		dsn  string
		want string
	}{
		{name: "empty unchanged", dsn: "", want: ""},
		{name: "memory unchanged", dsn: ":memory:", want: ":memory:"},
		{
			name: "plain path becomes file uri",
			dsn:  "/app/data/infinite-canvas.db",
			want: "file:/app/data/infinite-canvas.db?_pragma=journal_mode(WAL)&_pragma=busy_timeout(15000)&_pragma=synchronous(NORMAL)&_pragma=cache_size(-20000)&_txlock=immediate",
		},
		{
			name: "existing file uri without query",
			dsn:  "file:/data/test.db",
			want: "file:/data/test.db?_pragma=journal_mode(WAL)&_pragma=busy_timeout(15000)&_pragma=synchronous(NORMAL)&_pragma=cache_size(-20000)&_txlock=immediate",
		},
		{
			name: "existing pragmas are kept and missing appended",
			dsn:  "file:/data/test.db?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)",
			want: "file:/data/test.db?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)&_pragma=cache_size(-20000)&_txlock=immediate",
		},
		{
			name: "existing txlock is not duplicated",
			dsn:  "file:/data/test.db?_txlock=deferred",
			want: "file:/data/test.db?_txlock=deferred&_pragma=journal_mode(WAL)&_pragma=busy_timeout(15000)&_pragma=synchronous(NORMAL)&_pragma=cache_size(-20000)",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := withSQLitePragmas(test.dsn); got != test.want {
				t.Fatalf("withSQLitePragmas(%q) = %q, want %q", test.dsn, got, test.want)
			}
		})
	}
}

func TestRetryOnSQLiteBusy(t *testing.T) {
	t.Run("success passthrough", func(t *testing.T) {
		calls := 0
		err := retryOnSQLiteBusy(func() error {
			calls++
			return nil
		})
		if err != nil || calls != 1 {
			t.Fatalf("calls=%d err=%v", calls, err)
		}
	})

	t.Run("non busy error returned immediately", func(t *testing.T) {
		calls := 0
		want := errors.New("not a busy error")
		err := retryOnSQLiteBusy(func() error {
			calls++
			return want
		})
		if err != want || calls != 1 {
			t.Fatalf("calls=%d err=%v", calls, err)
		}
	})

	t.Run("busy error retried until success", func(t *testing.T) {
		calls := 0
		err := retryOnSQLiteBusy(func() error {
			calls++
			if calls < 3 {
				return errors.New("database is locked (5) (SQLITE_BUSY)")
			}
			return nil
		})
		if err != nil || calls != 3 {
			t.Fatalf("calls=%d err=%v", calls, err)
		}
	})

	t.Run("persistent busy gives up after attempts", func(t *testing.T) {
		calls := 0
		start := time.Now()
		err := retryOnSQLiteBusy(func() error {
			calls++
			return errors.New("database is locked (5) (SQLITE_BUSY)")
		})
		if err == nil || calls != 3 {
			t.Fatalf("calls=%d err=%v", calls, err)
		}
		if elapsed := time.Since(start); elapsed > 2*time.Second {
			t.Fatalf("retry took too long: %v", elapsed)
		}
	})

	t.Run("nil operation", func(t *testing.T) {
		if err := retryOnSQLiteBusy(nil); err != nil {
			t.Fatalf("err=%v", err)
		}
	})

	t.Run("detector covers known messages", func(t *testing.T) {
		for _, message := range []string{"SQLITE_BUSY", "database is locked"} {
			if !isSQLiteBusyError(errors.New(message)) {
				t.Fatalf("message %q not detected", message)
			}
		}
		// 嵌套事务报错不再视为可重试：驱动层已修复，重试会掩盖连接池污染。
		if isSQLiteBusyError(errors.New("cannot start a transaction within a transaction")) {
			t.Fatal("nested transaction error should not be treated as busy")
		}
		if isSQLiteBusyError(errors.New("unique constraint")) || isSQLiteBusyError(nil) {
			t.Fatal("false positive detection")
		}
	})
}
