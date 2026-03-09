# PDFreader

P1 阶段的 PWA 工程骨架，围绕以下闭环展开：

`导入 PDF -> 进入阅读 -> 保存进度 -> 首页继续阅读`

## 当前包含

- `React + TypeScript + Vite` 基础工程
- `vite-plugin-pwa` 的 App Shell 配置
- 领域模型、来源适配层和 Dexie 仓储骨架
- 首页与阅读页的首轮实现
- 本地 PDF 导入、封面生成和基础进度保存链路
- 长竖页分段渲染阅读器与更稳的恢复定位
- PWA 安装提示与页面生命周期保存桥接

## 启动

```bash
npm install
npm run dev
```

## 当前限制

- 本地上传文件只在当前运行会话内可直接打开
- 刷新后条目会保留，但需要重新选择文件才能继续阅读
- `pdf.js worker` 体积仍较大，后续应继续做性能和缓存优化
