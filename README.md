<p align="center">
  <img src="web/public/logo.svg" width="96" alt="infinite-canvas logo">
</p>

<h1 align="center">无限画布 (infinite-canvas)</h1>

<p align="center">
  <a href="VERSION"><img src="https://img.shields.io/badge/version-v0.7.1-2563eb?style=flat-square" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-f97316?style=flat-square" alt="License"></a>
  <a href="https://www.docker.com/"><img src="https://img.shields.io/badge/Docker-ready-2496ed?style=flat-square&logo=docker&logoColor=white" alt="Docker ready"></a>
  <a href="https://nextjs.org/"><img src="https://img.shields.io/badge/Next.js-16.2-000000?style=flat-square&logo=nextdotjs" alt="Next.js"></a>
  <a href="https://go.dev/"><img src="https://img.shields.io/badge/Go-1.25-00add8?style=flat-square&logo=go&logoColor=white" alt="Go"></a>
</p>

无限画布是一款面向图片、视频、音频全能创作的开源工作台。它把画布编排、AI 图片、视频、音频生成、参考图编辑、对话助手、提示词库和素材沉淀放在同一个界面里，适合用来探索视觉方案并连续迭代图片结果。

> 本仓库为基于上游 infinite-canvas 开源架构（AGPL-3.0）的二次开发维护版，包含大量本地加固与优化：CSRF 防护、认证加固、数据库重试、图片持久化与备份调度、画布任务幂等与冲突合并等。

> [!NOTE]
> 项目处于持续开发阶段，不保证历史数据兼容，数据库结构和存储格式可能调整。

## 核心功能

- Agent：围绕选中节点和上游节点分析、规划并生成图片或视频，支持选择 Skill 指导当前创作任务，并将结果插回画布
- 全景图：支持文字生成、参考图生成和本地 2:1 全景图导入，可作为导演台的场景环境背景
- 导演台：在独立 3D 场景中布置角色、模型、全景环境和机位，支持镜头管理、截图，并将机位画面自动发送为连线图片节点
- 摄像机控制：图片、视频和生成配置节点支持独立设置相机、镜头、焦距和光圈，将镜头参数自动写入生成提示词，并随节点保存和复制
- 无限画布：多画布项目、节点拖拽缩放、连线、小地图、撤销重做、导入导出
- AI 创作：支持 OpenAI 兼容接口的 Images API、Responses API、图生图、参考图编辑、流式接收、Base64 图片返回；Seedance 2.0 可通过火山方舟 Agent Plan 接入
- 生图工作台：支持侧边/悬浮底部工作台、多任务并发、历史结果合并展示、分类管理、失败详情、参考图缩略图、图片体积展示和“我的素材”复用
- 创作工作流：支持公开/个人模板、变量表单、AI 创建工作流、单图/多图系列工作流、参考图输入和结果自动进入生图历史
- 画布助手：围绕选中节点和上游节点对话、生图，并把结果插回画布
- 提示词库：抓取多个 GitHub 开源项目，按案例整理数百个图片提示词
- 提示词与素材：提示词库、服务器素材库和“我的素材”可在生图、画布 AI 和工作流中复用

完整功能说明见 [docs/features.md](docs/overview/features.md)

## 技术栈

- 前端：Next.js、React、TypeScript、Tailwind CSS、Ant Design、Zustand、TanStack Query
- 后端：Go、Gin、GORM
- 存储：SQLite、本地 IndexedDB、S3 兼容对象存储、Cloudflare R2
- 部署：Docker

## 快速开始

```bash
git clone https://github.com/fzheng466/infinite-canvas.git
cd infinite-canvas
cp .env.example .env
# 修改默认账号密码等信息（生产环境务必修改 ADMIN_PASSWORD / JWT_SECRET / PUBLIC_ORIGIN）
docker compose up -d --build
```

本地非 Docker 开发运行：

```bash
cp .env.example .env
go run .

# 另开一个终端窗口
cd web
bun install
bun run dev
```

运行后默认端口 3000，可访问 `http://localhost:3000`

如需要拉取提示词，可前往 `http://localhost:3000/admin/prompts`

## New API 自动配置

如果使用 New API，可在 `系统设置 -> 聊天方式 -> 添加聊天设置` 中填入：

```text
https://infinite-canvas-cpco.onrender.com?apiKey={key}&baseUrl={address}
```

跳转后会自动打开配置弹窗并填入 API Key 和 Base URL。
建议自行部署该配置页并将地址替换为自己的实例，避免 API Key 经过第三方服务。

## 文档

- [功能介绍](docs/overview/features.md)
- [部署说明](docs/overview/docker.md)
- [画布节点操作手册](docs/canvas/canvas-node-manual.md)
- [画布快捷键](docs/canvas/canvas-shortcuts.md)
- [待办事项](docs/progress/todo.md)
- [后端数据库说明](docs/backend/backend-database.md)
- [系统配置数据结构](docs/backend/system-settings.md)
- [接口响应约定](docs/backend/api-response.md)

## 开源协议

本项目使用 GNU Affero General Public License v3.0，见 [LICENSE](LICENSE)。
