# 书源协议与书库模型

## 1. 文档目的

本文件定义 PDFreader 的书源模型、书库记录结构以及来源接入协议，目标是解决以下问题：

- 如何统一本地上传和远程书源
- 如何在“不存 PDF 副本”的前提下维护书库
- 如何表达书籍可用 / 不可用状态
- 如何为 `P2` 的局域网 URL 书源与后续 `OPDS` 兼容留出空间

## 2. 核心原则

- `来源与阅读解耦`
- `书籍记录长期存在`
- `文件可用性可以变化`
- `来源接入可扩展`
- `不把实现绑死在某一种浏览器文件能力上`

## 3. 术语定义

### 3.1 书籍记录

用户在产品中能看到的一本“书”。

它不等价于某个瞬时文件句柄，而是一个长期存在的产品对象，包含：

- 展示信息
- 来源信息
- 阅读进度
- 状态信息

### 3.2 书源

书籍内容来自哪里。

在当前规划中，至少有以下几类：

- `local_upload`
- `remote_url`
- `unavailable`

未来 `P4` 再扩展：

- `native_file`
- `share_import`

### 3.3 来源可用性

表示书籍当前是否还能被重新打开，而不是表示书籍记录是否存在。

这两个概念必须分开：

- 书籍记录可以长期存在
- 来源可用性可以随时变化

## 4. 统一书籍模型

## 4.1 书籍记录字段建议

### identity

- `bookId`
- `canonicalKey`
- `sourceType`
- `sourceInstanceId`

### display

- `title`
- `displayTitle`
- `coverRef`
- `pageCount`
- `primaryLanguage`（预留）

### fileInfo

- `fileName`
- `fileSize`
- `mimeType`
- `contentHashPreview`
- `firstPageWidth`
- `firstPageHeight`

### status

- `availabilityStatus`
- `availabilityReason`
- `lastValidatedAt`
- `lastOpenedAt`

### timestamps

- `createdAt`
- `updatedAt`

## 4.2 为什么需要 canonicalKey

书库里的一本书不能只靠“这次选到的文件对象”识别，否则以下情况会出问题：

- 同一本书多次导入
- 源文件重新选择
- 后续从远程 URL 书源导入相同作品
- 后续切换到 App 形态

建议：

- `bookId` 是内部主键
- `canonicalKey` 是尽可能稳定的内容身份标识

P1 可以先用以下组合近似生成：

- 文件名
- 文件大小
- 页数
- 首页尺寸

P2 再补更稳的内容特征策略。

## 5. 来源模型

## 5.1 SourceInstance

书源不只是类型，还应有实例级概念。

示例：

- 本地上传来源实例：`local-device-default`
- 局域网 URL 书源实例：`nas-home-1`
- 未来 App 原生文件来源实例：`ios-files`

建议字段：

- `sourceInstanceId`
- `sourceType`
- `name`
- `baseUrl`
- `authMode`
- `status`
- `createdAt`
- `updatedAt`

## 5.2 为什么要有 sourceInstance

如果以后接多个书源，不区分来源实例会导致：

- 无法知道书籍来自哪个 NAS
- 无法按来源做重试和校验
- 无法统一管理远程书源状态

因此即使 `P1` 只有本地上传，也建议从一开始保留 `sourceInstanceId`。

## 6. 本地上传来源

## 6.1 定位

`local_upload` 是 `P1` 的主路径，但不应被当作长期最强来源模型。

## 6.2 元数据策略

本地上传导入后，应保存：

- 文件基础信息
- PDF 元数据
- 封面缩略图
- 进度记录

不保存：

- PDF 正文副本

## 6.3 可用性判断

本地上传来源可能经历以下状态：

- `available`
- `needs_relink`
- `missing`
- `failed`

### available

当前仍可直接打开。

### needs_relink

应用里存在该书记录，但当前没有稳定的再次访问入口，需要用户重新选择文件。

### missing

用户明确取消、文件不存在或访问失败。

### failed

文档本身损坏或解析异常。

P1 可以先把 `needs_relink` 和 `missing` 合并显示为“不可用”，内部状态可细分。

## 7. 远程 URL 书源

## 7.1 定位

`remote_url` 是 `P2` 达到 80% 可用的关键来源模型。

它用于承接：

- NAS 暴露出的静态文件服务
- 局域网内电脑提供的书库服务
- 后续 OPDS 兼容书源

## 7.2 接入要求

建议最少支持：

- 基础 URL 配置
- 可访问性探测
- 远程书目获取
- 单本书详情获取
- PDF 读取

## 7.3 远程书源的两层模式

### 模式 A：静态 URL 列表源

适用阶段：

- P2 早期

特点：

- 实现快
- 可以直接消费一份书目 JSON
- 适合你自己控制的 NAS 或电脑服务

建议结构：

- `/library.json`
- `/books/{id}.pdf`
- `/covers/{id}.jpg`（可选）

### 模式 B：OPDS 兼容源

适用阶段：

- P2 后期或 P3

特点：

- 更标准
- 可对接现成生态，如 Komga / Kavita
- 更适合多书源和长期扩展

设计结论：

- `P2` 可先落静态 URL 列表源
- 协议抽象必须允许后续切到或兼容 OPDS

## 7.4 远程书源可用性

远程书源也可能离线。

需要区分：

- 书籍记录仍在
- 当前来源暂不可用

用户体验要求：

- 条目保留
- 进度保留
- 首页继续阅读显示不可用
- 书源恢复后可继续使用

## 8. SourceAdapter 接口建议

所有来源都通过统一接口接入阅读器与书库层。

建议能力如下：

### 元数据层

- `getSourceDescriptor()`
- `getAvailabilityStatus()`
- `validate()`

### 书目层

- `listBooks()`
- `getBookIdentity()`
- `getBookMetadata()`

### 内容层

- `openBook()`
- `getDocumentInput()`

### 恢复层

- `relink()`
- `refresh()`

## 9. 书库状态模型

## 9.1 书籍级状态

建议的主状态：

- `ready`
- `unavailable`
- `broken`
- `importing`

### ready

书籍当前可正常打开。

### unavailable

书籍记录存在，但来源当前不可访问。

### broken

书籍内容异常，无法正常解析。

### importing

当前还在导入或同步过程中。

## 9.2 继续阅读状态

首页继续阅读卡片建议单独维护状态判断：

- `continue_ready`
- `continue_unavailable`
- `continue_empty`

这样可以避免把首页逻辑绑死在书库列表状态上。

## 10. 重复导入与去重策略

## 10.1 P1 策略

P1 不追求百分百准确去重，但应避免最明显重复。

建议规则：

- 同来源实例下，若 `canonicalKey` 相同，则提示已存在
- 用户可选择覆盖显示信息或保留两份记录

## 10.2 P2-P3 策略

后续补：

- 更稳的内容特征比对
- 跨来源重复识别
- 手动合并记录

## 11. 删除与移除语义

产品已经明确：

- 从书库移除，不删除原文件

因此书库操作应明确区分：

### removeFromLibrary

删除书籍记录、封面缓存、进度缓存。

不会做：

- 删除本地原文件
- 删除远程源上的 PDF

### relinkBook

重新把现有书籍记录与一个新可访问来源绑定。

作用：

- 保留书籍身份
- 保留进度
- 保留封面和展示信息

## 12. P1-P3 演进策略

## P1

- 仅本地上传来源
- 先实现最小统一模型
- 不做多书源管理 UI

## P2

- 增加远程 URL 书源
- 开始支持来源实例管理
- 统一继续阅读恢复模型

## P3

- 完整书库管理
- 搜索、排序、去重、收藏
- 兼容 OPDS 或至少预留兼容层

## 13. 与 App 化的关系

本模型从一开始就要服务于 `P4` App 化，因此：

- 不把来源绑死在浏览器 File API
- 不把恢复能力绑死在一次性文件句柄
- 不把书籍身份建立在临时 URL 上

未来原生 App 只需新增来源适配器，不应推翻整个书库模型。

## 14. 当前建议结论

对 PDFreader 而言，最合理的书源策略是：

- `P1`：本地上传作为 MVP 入口
- `P2`：远程 URL 书源作为真正走向 80% 可用的核心能力
- `P3`：把书库管理做完整，并为 OPDS 兼容铺路

书库的本质不是“存文件”，而是：

`围绕不同来源维护一本书的长期身份、可用状态与阅读进度`
