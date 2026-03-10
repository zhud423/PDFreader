# PDFreader

当前工程已从 `P1` 自用 MVP 进入 `P2` 公开测试版准备阶段，围绕以下主链路展开：

`导入 / 同步书源 -> 进入阅读 -> 保存进度 -> 首页继续阅读`

## 当前包含

- `React + TypeScript + Vite` 基础工程
- `vite-plugin-pwa` 的 App Shell 配置
- `IndexedDB + Dexie` 书库、进度、封面和来源实例存储
- 本地 PDF 导入、封面生成和基础进度保存链路
- 局域网 URL 书源接入与 `library.json` 同步
- 长竖页分段阅读器、热区 / 温区渲染和更稳的恢复定位
- 双击放大、缩放记忆、阅读错误重试和书源重试
- PWA 安装提示与页面生命周期保存桥接

## 启动

```bash
npm install
npm run dev
```

## 局域网 URL 书源

当前 `P2` 使用静态 `library.json` 协议。

最低要求：

- 书源根目录可访问 `library.json`
- `books[].pdfPath` 指向可直接读取的 PDF
- 推荐同时提供 `coverPath`
- 远程资源应支持 `HTTPS + CORS`

示例见：

- `doc/examples/remote-library.example.json`
- `doc/10_p2_beta_runbook.md`

## 当前限制

- 本地上传文件只在当前运行会话内可直接打开
- 远程书源暂只支持静态 `library.json`，还不支持 `OPDS`
- 还没有完整书库管理页、搜索、排序、收藏
- `pdf.js worker` 体积仍较大，后续还要继续做性能收尾
