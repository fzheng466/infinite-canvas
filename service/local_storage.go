package service

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/fzheng466/infinite-canvas/config"
	"github.com/fzheng466/infinite-canvas/model"
)

func localStorageProvider() (model.StorageProvider, bool) {
	if !config.Cfg.LocalStorageEnabled {
		return model.StorageProvider{}, false
	}
	root := strings.TrimSpace(config.Cfg.LocalStorageDir)
	if root == "" {
		return model.StorageProvider{}, false
	}
	return model.StorageProvider{ID: "local", Name: "Local", Type: model.StorageProviderTypeLocal, Endpoint: root, Enabled: true, Weight: 1}, true
}

func safeStorageFile(root, objectKey string) (string, error) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	key := filepath.FromSlash(strings.TrimSpace(objectKey))
	if key == "" || filepath.IsAbs(key) {
		return "", errors.New("本地存储路径无效")
	}
	target, err := filepath.Abs(filepath.Join(rootAbs, key))
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(rootAbs, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("本地存储路径越界")
	}
	return target, nil
}

func putLocalStorageData(provider model.StorageProvider, objectKey string, data []byte) error {
	spool, err := os.CreateTemp("", ".local-storage-*")
	if err != nil {
		return err
	}
	name := spool.Name()
	defer os.Remove(name)
	if _, err = spool.Write(data); err == nil {
		err = spool.Close()
	} else {
		_ = spool.Close()
	}
	if err != nil {
		return err
	}
	return putLocalStorageFile(provider, objectKey, name)
}

func putLocalStorageFile(provider model.StorageProvider, objectKey, spoolPath string) error {
	target, err := safeStorageFile(provider.Endpoint, objectKey)
	if err != nil {
		return err
	}
	input, err := os.Open(spoolPath)
	if err != nil {
		return err
	}
	defer input.Close()
	if err := os.MkdirAll(filepath.Dir(target), 0750); err != nil {
		return err
	}
	if info, statErr := os.Stat(target); statErr == nil && info.Mode().IsRegular() {
		return nil
	}
	temp, err := os.CreateTemp(filepath.Dir(target), ".storage-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if _, err = io.Copy(temp, input); err == nil {
		err = temp.Sync()
	}
	if closeErr := temp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err := os.Rename(tempName, target); err != nil {
		return err
	}
	return nil
}

func getLocalStorageStream(provider model.StorageProvider, objectKey string, size int64, rangeHeader string) (storageObjectStream, error) {
	filename, err := safeStorageFile(provider.Endpoint, objectKey)
	if err != nil {
		return storageObjectStream{}, err
	}
	file, err := os.Open(filename)
	if err != nil {
		return storageObjectStream{}, err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return storageObjectStream{}, err
	}
	if size <= 0 {
		size = info.Size()
	}
	stream := storageObjectStream{Body: file, StatusCode: http.StatusOK, ContentLength: size, AcceptRanges: true}
	if strings.TrimSpace(rangeHeader) == "" {
		return stream, nil
	}
	byteRange, ok := parseStorageByteRange(rangeHeader, size)
	if !ok {
		file.Close()
		return storageObjectStream{Body: io.NopCloser(strings.NewReader("")), StatusCode: http.StatusRequestedRangeNotSatisfiable, ContentLength: 0, ContentRange: fmt.Sprintf("bytes */%d", size), AcceptRanges: true}, nil
	}
	if _, err := file.Seek(byteRange.offset, io.SeekStart); err != nil {
		file.Close()
		return storageObjectStream{}, err
	}
	stream.Body = struct {
		io.Reader
		io.Closer
	}{Reader: io.LimitReader(file, byteRange.length), Closer: file}
	stream.StatusCode = http.StatusPartialContent
	stream.ContentLength = byteRange.length
	stream.ContentRange = fmt.Sprintf("bytes %d-%d/%d", byteRange.offset, byteRange.offset+byteRange.length-1, size)
	return stream, nil
}
