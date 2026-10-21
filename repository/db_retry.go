package repository

import (
	"strings"
	"time"
)

// isSQLiteBusyError 判断是否为 SQLite 写锁竞争类错误。
// WAL 下偶发。嵌套事务报错（"cannot start a transaction within a transaction"）不再重试：
// 根因是旧驱动锁升级失败后连接残留事务状态，已通过切换驱动 + _txlock=immediate 修复，
// 重试只会掩盖连接池被污染的问题。
func isSQLiteBusyError(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	return strings.Contains(message, "SQLITE_BUSY") ||
		strings.Contains(message, "database is locked")
}

// retryOnSQLiteBusy 对写锁竞争错误做最多 2 次退避重试（100ms/200ms）；其余错误原样返回。
// 仅用于幂等写操作（按主键 Save/条件 Updates），重复执行不会产生副作用。
func retryOnSQLiteBusy(operation func() error) error {
	if operation == nil {
		return nil
	}
	var err error
	for attempt := 0; ; attempt++ {
		err = operation()
		if err == nil || !isSQLiteBusyError(err) || attempt >= 2 {
			return err
		}
		time.Sleep(time.Duration(100<<attempt) * time.Millisecond)
	}
}
