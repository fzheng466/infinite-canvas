package handler

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/tigerowo/infinite-canvas/service"
)

const canvasProjectRequestBodyLimit int64 = 20 << 20

func decodeCanvasProjectRequest(w http.ResponseWriter, r *http.Request, target any, invalidMessage string) bool {
	r.Body = http.MaxBytesReader(w, r.Body, canvasProjectRequestBodyLimit)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(target); err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			FailWithStatus(w, http.StatusRequestEntityTooLarge, "画布项目数据不能超过 20MiB")
			return false
		}
		if errors.Is(err, io.EOF) {
			Fail(w, "画布项目数据不能为空")
			return false
		}
		Fail(w, invalidMessage)
		return false
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			FailWithStatus(w, http.StatusRequestEntityTooLarge, "画布项目数据不能超过 20MiB")
		} else {
			Fail(w, invalidMessage)
		}
		return false
	}
	return true
}

func UserCanvasProjects(w http.ResponseWriter, r *http.Request) {
	projects, err := service.CurrentUserCanvasProjects(r.Context())
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, projects)
}

// CheckUserCanvasProject 画布页定期对账：?since=<updatedAt>，仅当服务器更新时返回项目。
func CheckUserCanvasProject(w http.ResponseWriter, r *http.Request, id string) {
	project, err := service.GetCurrentUserCanvasProject(
		r.Context(),
		id,
		r.URL.Query().Get("since"),
	)
	if err != nil {
		FailError(w, err)
		return
	}
	if project == nil {
		OK(w, nil)
		return
	}
	OK(w, project)
}

func SaveUserCanvasProject(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Data json.RawMessage `json:"data"`
	}
	if !decodeCanvasProjectRequest(w, r, &request, "画布项目参数无效") {
		return
	}
	if len(request.Data) == 0 {
		Fail(w, "数据内容不能为空")
		return
	}

	project, err := service.SaveCurrentUserCanvasProject(r.Context(), request.Data)
	if err != nil {
		var conflict *service.ProjectSaveConflict
		if errors.As(err, &conflict) {
			// 409 携带服务器当前版本，客户端做节点级合并后重试。
			writeJSON(w, response{Code: 409, Data: conflict.Stored, Msg: "画布已在其他窗口更新，正在合并最新内容"})
			return
		}
		if writeProjectReferenceError(w, err) {
			return
		}
		FailError(w, err)
		return
	}
	// 成功时前端不读回包（canvas-tasks.ts saveCanvasProject），不再回传整份项目 JSON。
	_ = project
	OK(w, nil)
}

func SyncUserCanvasProjects(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Projects []json.RawMessage `json:"projects"`
	}
	if !decodeCanvasProjectRequest(w, r, &request, "画布项目参数无效") {
		return
	}

	projects, err := service.SyncCurrentUserCanvasProjects(r.Context(), request.Projects)
	if err != nil {
		if writeProjectReferenceError(w, err) {
			return
		}
		FailError(w, err)
		return
	}
	OK(w, projects)
}

func writeProjectReferenceError(w http.ResponseWriter, err error) bool {
	var referenceError *service.ProjectReferenceError
	if !errors.As(err, &referenceError) {
		return false
	}
	writeJSONWithStatus(w, http.StatusUnprocessableEntity, response{Code: 422, Data: nil, Msg: referenceError.SafeMessage()})
	return true
}
