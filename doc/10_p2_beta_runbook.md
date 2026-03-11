# P2 公开测试版运行说明

## 1. 当前定位

当前版本已经进入 `P2` 主范围：

- 局域网 URL 书源
- 本地上传与远程来源统一书籍模型
- 双击放大与缩放记忆
- 分段热区 / 温区渲染
- 阅读错误重试与来源重试

本阶段目标不是“功能完备”，而是把核心阅读路径做成可对外试用的 `80% 可用`。

## 2. Beta 入口建议

公开测试时，优先让测试用户走以下路径：

1. 打开首页
2. 把应用添加到主屏幕
3. 添加一个局域网 URL 书源
4. 选择一本到两本长竖页 PDF 连续阅读
5. 退出、切后台、再次打开验证继续阅读

不要先把测试重点放在批量书库整理上。

## 3. 局域网书源要求

当前实现使用静态 `library.json` 协议。

最低要求：

- PDFreader 应用壳通过 `HTTPS` 访问
- 远程书源应支持 `CORS`
- 真机 / PWA 测试时，远程书源也优先通过 `HTTPS` 暴露
- 远程目录根路径下可访问 `library.json`
- `books[].contentHash` 建议直接填写 PDF 的 `SHA-256`
- PDF 和封面资源允许浏览器跨域读取

建议至少返回：

- `Access-Control-Allow-Origin`
- `Access-Control-Allow-Methods: GET, HEAD, OPTIONS`

当前示例文件：

- `doc/examples/remote-library.example.json`

### 3.1 通用 Mac 测试法

只要一台 Mac 能把静态目录通过局域网暴露出来，就能测试当前 remote source 协议，不依赖项目脚本。

定位说明：

- 本节仅用于开发验证与高级用户联调
- 不作为后续普通用户正式接入方案

建议目录结构：

- `library.json`
- `books/{file}.pdf`
- `covers/{file}.jpg`（可选）

桌面调试可先用 `Python 3` 起一个带 `CORS` 的静态服务：

```bash
cd /path/to/remote-library
python3 - <<'PY'
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

ThreadingHTTPServer(('0.0.0.0', 8000), partial(Handler, directory='.')).serve_forever()
PY
```

获取当前 Mac 的局域网 IP：

```bash
ipconfig getifaddr en0
```

然后在 PDFreader 里添加：

- `http://<Mac-IP>:8000`

补充说明：

- 如果机器走的是 Wi-Fi 以外网卡，可把 `en0` 换成对应网卡
- 若 macOS 防火墙弹窗，需允许 `Python` 接收入站连接
- iPhone / iPad Safari 或主屏 PWA 联调时，建议把同一目录切到 `HTTPS` 静态服务；目录结构和 `library.json` 协议不需要改

## 4. 测试重点

### 4.1 阅读体验

- 首开大 PDF 是否有明确加载反馈
- 连续滚动时是否还会出现明显“整屏重刷”
- 双击放大后是否还能稳定回到当前阅读位置
- 横竖屏切换后是否仍停留在接近原位置

### 4.2 书源稳定性

- 书源在线时是否可连续打开多本远程书
- 书源离线后首页是否保留条目并显示不可用
- 恢复在线后点击“立即同步 / 重试连接”是否能恢复

### 4.3 状态恢复

- 返回首页后再次进入是否仍在原位置
- 切后台 1 到 3 分钟后回来是否还能恢复
- PWA 主屏模式与 Safari 标签页模式是否表现一致

## 5. 当前已知限制

- 本地上传 PDF 仍只在当前运行会话内可直接打开
- 远程书源当前只支持静态 `library.json`，还不支持 `OPDS`
- 还没有多书源管理页、搜索、排序、收藏
- `pdf.js worker` 体积仍偏大
- 远程来源暂不支持鉴权

## 6. 发布前手工回归

每次准备给测试用户发版前，至少手工跑一遍：

1. 本地上传一本 PDF 并继续阅读
2. 添加一个远程书源并同步成功
3. 打开远程书，双击放大，再退出重进
4. 模拟书源离线，确认首页状态转为不可用
5. 书源恢复后点击“立即同步”并再次打开
6. iPhone Safari / iPad Safari / 主屏安装模式各跑一次主路径

## 7. 当前结论

`P2` 现在最重要的不是继续加书库功能，而是：

- 让远程书源连续可用
- 让缩放和恢复足够可信
- 让异常路径都有明确承接
