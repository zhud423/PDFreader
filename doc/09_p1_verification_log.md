# P1 验证记录

## 1. 记录范围

本文档记录 `2026-03-09` 在当前开发机上完成的 `P1` 本地验证结果，并明确哪些项目已经确认，哪些仍需 iPhone / iPad 真机验收。

## 2. 已完成的本机验证

### 2.1 构建验证

- 执行：`npm run build`
- 结果：通过
- 结论：`TypeScript` 编译、`Vite` 构建和 `vite-plugin-pwa` 的 `generateSW` 输出正常

### 2.2 本地预览服务验证

- 执行：`npm run preview -- --host 127.0.0.1 --port 4173`
- 结果：服务正常启动
- 说明：由于运行环境沙箱限制，验证请求使用了允许访问本地预览端口的提权命令

### 2.3 关键路由与 PWA 资源响应

已确认以下响应状态：

- `GET /` -> `200 OK`
- `GET /reader/demo-book` -> `200 OK`
- `GET /manifest.webmanifest` -> `200 OK`
- `GET /sw.js` -> `200 OK`

结论：

- 首页可被正常提供
- `SPA` 阅读路由有回退，不会在直达时返回 `404`
- manifest 与 service worker 构建产物被正常提供

### 2.4 构建产物检查

已确认：

- `dist/index.html` 注入了主脚本、主样式和 manifest 链接
- `dist/sw.js` 内包含 `NavigationRoute` 到 `index.html`
- `dist/sw.js` 已预缓存首页、路由 chunk、样式、manifest、图标等资源

### 2.5 当前包体观察

当前构建输出主要体积点：

- `dist/assets/index-BtrH6ggB.js` 约 `166.71 KB`
- `dist/assets/pdf-C8DPCabo.js` 约 `364.11 KB`
- `dist/assets/pdf.worker.min-yatZIOMy.mjs` 约 `1.37 MB`
- `dist` 总体积约 `2.0 MB`

结论：

- 路由拆分已经生效
- `pdf.js worker` 仍是当前最大体积来源

## 3. 对照 P1 范围的当前判断

### 3.1 已基本具备

- 本地单本 / 多本导入
- 自动生成封面
- 首页继续阅读卡片
- 最近书籍列表
- 不可用条目分区展示
- 重新选择文件恢复
- 阅读页基础缩放
- 工具栏显隐
- 页面 + 段 + 偏移进度模型
- 生命周期触发保存
- PWA 安装提示

### 3.2 仍需真机确认

- iPhone Safari 下实际文件选择与返回流程
- iPad Safari 下横竖屏切换后的阅读恢复
- 主屏安装模式下的生命周期表现
- 双指缩放手感是否可接受
- 长时间连续阅读后的内存与卡顿情况

## 4. 当前未完成的验证

以下项目这轮没有在当前环境中自动确认：

- 真正导入一批大 PDF 的交互耗时
- 真实长竖页文件的分段参数是否合适
- iOS / iPadOS 的后台切换恢复
- 主屏模式下 `beforeinstallprompt` 以外的系统表现

## 5. 当前建议

`P1` 代码层面已经接近冻结。下一步不建议继续扩功能，应转入：

1. iPhone 真机连续自用
2. iPad 真机连续自用
3. 仅修阻塞阅读的问题
4. 通过后冻结 `P1`
