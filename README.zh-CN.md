# Codex Web

Codex Web 是一个非官方、自托管的 OpenAI Codex CLI 网页工作台。它提供持久化会话、未发送草稿、附件与交付文件、服务器端任务排队、实时引导、可续接的终止/中断记录、会话归档、完整工作记录、完成任务未读提示、引用提问、自动命名、字号调节以及可选的语音转写。

> 本项目由社区独立开发，与 OpenAI 没有关联，也未获得 OpenAI 的背书或支持。

## 开发分支说明

`feat/remote-worker-mvp` 分支正在开发可信 Remote Worker 扩展。它允许所有者在空白新任务中显式选择一台已登记电脑上的真实项目目录，默认仍使用隔离 Docker tenant。部署与限制见 [Remote Worker MVP](docs/REMOTE_WORKER_MVP.md)。

完整项目说明请查看上游主分支 README；本分支的功能改动正在 Draft PR 中审查。
