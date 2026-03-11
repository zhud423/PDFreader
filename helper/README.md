# PDFreader Helper Alpha

当前目录包含一个 `Mac helper alpha` 骨架，用于把指定文件夹扫描成 `remote_url` 兼容书源，并通过局域网只读共享出去。

## 当前能力

- 选择或手动添加共享文件夹
- 共享开启后自动监听文件变化并重扫
- 扫描 PDF 并提取：
  - `contentHash`
  - `pageCount`
  - `firstPageWidth`
  - `firstPageHeight`
  - 标题
- 封面优先走 Quick Look，超长页会自动切到高清 `sips` 渲染并裁剪，避免模糊
- 生成兼容当前客户端的 `library.json`
- 默认按“一级子文件夹=作品，递归 PDF=章节”生成作品与章节映射
- 提供：
  - 管理页 `/manage`
  - 连接页 `/connect`
  - 书源根路径 `/source`
- 默认同时启动：
  - HTTP 管理服务（默认 `48321`）
  - HTTPS 书源服务（默认 `48322`）
- 管理页提供“安装 helper 证书”入口，方便手机首次信任 HTTPS 书源
- 默认使用 `https://pdfreader.gensstudio.com` 生成预填好的“添加局域网书源”链接
- 可生成一个自包含 macOS `.app`

## 普通用户用法

```bash
npm run helper:app
```

生成后可在：

- `helper/dist/PDFreader Helper.app`

拿到这个 `.app` 之后，普通用户只需要：

- 把它放到任意目录或 `Applications`
- 双击打开
- 在管理页里选择要共享的文件夹
- 点击“开始共享”
- 让手机扫描管理页里的二维码继续连接

这个 `.app` 当前会：

- 内置 Node 运行时
- 内置 helper 代码和所需依赖
- 不再依赖当前仓库路径
- 默认按通用包思路构建，不再携带架构相关的原生 `canvas` 模块
- 默认把数据写到 `~/Library/Application Support/PDFreaderHelper`
- 自动打开管理页
- 默认把首次连接二维码指向 `https://pdfreader.gensstudio.com/add?...`（自动预填书源地址）
- 如需覆盖该默认地址，可设置 `PDFREADER_HELPER_APP_URL`

## 作品识别规则（当前默认）

- 共享根目录下的“一级子文件夹”视为一个作品
- 作品文件夹内递归扫描到的所有 PDF 都作为该作品章节
- 根目录下直接放置的 PDF，按“单文件单作品”处理

## 生成 unsigned DMG

```bash
npm run helper:dmg
```

生成后可在：

- `helper/dist/PDFreader Helper.dmg`

这个 DMG 当前会包含：

- `PDFreader Helper.app`
- `/Applications` 快捷方式
- `README.txt`
- `首次打开失败怎么办.txt`

## 开发调试

```bash
npm run helper
```

启动后终端会打印：

- 管理页地址
- 书源地址
- 当前主机名

## 运行方式

helper 服务默认：

- 监听端口 `48321`
- HTTPS 书源端口 `48322`（可改）
- 把状态文件写到 macOS 的 `~/Library/Application Support/PDFreaderHelper`

可用环境变量覆盖：

- `PDFREADER_HELPER_PORT`
- `PDFREADER_HELPER_TLS_PORT`
- `PDFREADER_HELPER_ENABLE_TLS`（默认开启，设为 `0` 可关闭）
- `PDFREADER_HELPER_DATA_DIR`
- `PDFREADER_HELPER_APP_URL`
- `PDFREADER_HELPER_OPEN_BROWSER`

示例：

```bash
PDFREADER_HELPER_PORT=48330 PDFREADER_HELPER_DATA_DIR=/tmp/pdfreader-helper npm run helper
```

## HTTPS 首次连接提示

- helper 会在 `~/Library/Application Support/PDFreaderHelper/tls` 生成本地 CA 和服务器证书
- 手机第一次连接时，若出现 `Load failed` 或证书不受信任：
  - 先在 helper 管理页点击“安装 helper 证书”
  - 安装后回到 PDFreader 再同步
- CA 会复用，不会每次重启 helper 都变更

## 当前限制

- 当前还是 `alpha`，但已经能打成自包含 `.app`
- “选择文件夹”按钮当前走 macOS `osascript`
- 当前 `.app` 和 `.dmg` 都是未签名构建，分发后首次打开可能需要用户在 macOS 安全提示里手动确认
- `helper:app` 现在要求构建机上的 Node 本身是 `x86_64 + arm64` 的 universal binary；若不是，会直接构建失败
- 更深的 iOS / PWA 直接唤起能力和正式签名 / notarization 还要继续补
