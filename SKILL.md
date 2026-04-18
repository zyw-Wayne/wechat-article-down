---
name: wechat-article-down
description: Download WeChat public account articles (微信公众号文章下载). Use when the user provides one or more WeChat article URLs (https://mp.weixin.qq.com/...) and wants to download the full content including body text, images, audio, and video to local files. Triggers include "下载微信文章", "保存公众号文章", "下载这篇文章", "wechat article download", or any request to save/archive a WeChat article.
---

# 微信公众号文章下载

## 依赖

- `Node.js` ≥ 16（无需 npm install）
- `yt-dlp`（可选，下载腾讯视频）：`brew install yt-dlp`
- `chrome-devtools MCP`（必须）

脚本目录：`~/.claude/skills/wechat-article-down/scripts/`

## 流程（每篇文章）

### 1. 验证链接
必须以 `https://mp.weixin.qq.com/` 开头，否则跳过。

### 2. 读取提取脚本（后续步骤直接使用）
读取 `references/extract.js`，后续步骤直接使用其中的 `WAIT_SCRIPT`、`SCROLL_SCRIPT`、`SAVE_SCRIPT`、`EXTRACT_SCRIPT`，无需重新读取。

### 3. 启动接收服务（打开页面前）
先 kill 旧进程，再后台启动：

```bash
lsof -ti:17329 | xargs kill -9 2>/dev/null; sleep 0.3
node ~/.claude/skills/wechat-article-down/scripts/receiver.js &
sleep 0.5 && echo "ready"
```

### 4. 打开页面
```
mcp__chrome-devtools__navigate_page  type=url  url=<文章URL>
```

### 5. 等待正文加载
执行 `WAIT_SCRIPT`（来自 extract.js）。

若返回 `loaded: false` 且 snippet 含"请在微信客户端打开" → 截图提示用户，跳过该篇。

### 6. 滚动触发懒加载
执行 `SCROLL_SCRIPT`（来自 extract.js）。**必须执行**，否则图片 `src` 为空（只有 `data-src`），导致图片缺失。

### 7. 提取并发送数据
执行 `SAVE_SCRIPT`（来自 extract.js）。脚本在浏览器内提取完整 JSON（含 contentHtml）并 POST 到本地接收服务。

返回 `{ saved: true }` → 成功，继续步骤 8。

**降级（`saved: false`）**：
1. 执行 `EXTRACT_SCRIPT`，获取完整 JSON 对象
2. **用 Write 工具**将工具结果中的完整 JSON 原样写入 `/tmp/wechat_article_data.json`
3. **严禁 Bash heredoc 手动重构 JSON**——contentHtml 巨大，手动重构必然丢失字段和图片

### 8. 调用下载脚本并清理

```bash
node ~/.claude/skills/wechat-article-down/scripts/download_article.js \
  --stdin --output ./downloads \
  < /tmp/wechat_article_data.json

rm /tmp/wechat_article_data.json
```

### 9. 报告结果

```
✅ <title>
📁 ./downloads/<title>/
   🖼️  图片 N/N  🎵 音频 N/N  🎬 视频 N/N
```

有 `failed.log` 时告知用户失败资源数及路径。

## 多篇文章

逐篇处理，每篇之间 `sleep 2`。

## 图片下载说明

微信 CDN（`mmbiz.qpic.cn`）要求：
- `Referer` 必须为文章完整 URL（脚本已处理）
- 扩展名从 `?wx_fmt=jpeg` 查询参数读取（脚本已处理）
