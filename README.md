# wechat-article-down

微信公众号文章下载工具 —— Claude Code Skill，通过浏览器自动提取文章内容，下载图片、音频、视频并保存为 Markdown。

## 功能

- 自动提取文章标题、作者、公众号、发布时间、摘要等元信息
- 下载正文中的图片（处理微信 CDN 防盗链）、音频、视频（支持 yt-dlp）
- HTML 转 Markdown，保留代码块、表格、列表等格式
- 支持批量处理多篇文章

## 依赖

- **Node.js** >= 16（无需 npm install，纯标准库实现）
- **chrome-devtools MCP**（必须，用于浏览器自动化）
- **yt-dlp**（可选，下载腾讯视频等）：`brew install yt-dlp`

## 项目结构

```
wechat-article-down/
├── SKILL.md                    # Claude Code Skill 定义（流程说明）
├── README.md
├── scripts/
│   ├── receiver.js             # 本地 JSON 接收服务（端口 17329）
│   └── download_article.js     # 文章内容下载与 Markdown 转换
└── references/
    └── extract.js              # 浏览器端提取脚本（注入页面执行）
```

## 工作流程

```
验证链接 → 启动接收服务 → 打开文章页面 → 等待加载 → 滚动触发懒加载 → 提取数据并 POST → 下载资源 → 生成 Markdown
```

1. **验证链接**：URL 必须以 `https://mp.weixin.qq.com/` 开头
2. **启动接收服务**：`receiver.js` 监听 17329 端口，接收浏览器 POST 的文章数据
3. **打开页面**：通过 chrome-devtools MCP 导航到文章 URL
4. **等待加载**：执行 `WAIT_SCRIPT` 确认正文 `#js_content` 已渲染
5. **滚动触发懒加载**：执行 `SCROLL_SCRIPT`，确保所有图片 `src` 从 `data-src` 替换为真实 CDN 地址
6. **提取并发送数据**：执行 `SAVE_SCRIPT`，在浏览器内提取完整 JSON 并 POST 到本地接收服务
7. **下载资源**：`download_article.js` 读取 JSON，批量下载图片/音频/视频
8. **生成 Markdown**：HTML 转 Markdown，替换资源链接为本地路径，输出 `article.md`

## 输出结构

```
downloads/
└── 文章标题/
    ├── article.md          # Markdown 正文（含 YAML frontmatter）
    ├── images/
    │   ├── img_001.jpg
    │   ├── img_002.png
    │   └── ...
    ├── audio/
    │   └── audio_001.mp3
    ├── video/
    │   └── video_001.mp4
    └── failed.log          # 下载失败的资源记录（如有）
```

## 安装

```bash
npx skills add https://github.com/zyw-Wayne/wechat-article-down
```

## 使用方式

### 作为 Claude Code Skill

安装后，直接向 Claude 发送微信文章链接即可触发下载：

```
下载这篇文章：https://mp.weixin.qq.com/s/xxxxx
```

触发关键词：`下载微信文章`、`保存公众号文章`、`下载这篇文章`、`wechat article download`

### 独立使用 download_article.js

```bash
# 从标准输入读取 JSON
echo '<json>' | node scripts/download_article.js --stdin --output ./downloads

# 从文件读取
node scripts/download_article.js --stdin --output ./downloads < /tmp/wechat_article_data.json

# 直接传入 JSON 字符串
node scripts/download_article.js --data '{"url":"...","title":"测试","contentHtml":"<p>内容</p>","images":[]}'
```

### JSON 数据格式

```json
{
  "url": "https://mp.weixin.qq.com/...",
  "title": "文章标题",
  "author": "作者",
  "account": "公众号名称",
  "publishTime": "2024-01-15 10:30:00",
  "digest": "文章摘要",
  "contentHtml": "<div>...</div>",
  "images": ["https://mmbiz.qpic.cn/..."],
  "audios": [{"src": "https://...", "name": "音频名称"}],
  "videos": [{"src": "https://...", "poster": "封面URL", "vid": "腾讯视频ID"}]
}
```

## 技术细节

- **防盗链处理**：微信 CDN（`mmbiz.qpic.cn`）要求 `Referer` 为文章完整 URL，脚本自动设置
- **图片格式识别**：从 `?wx_fmt=jpeg` 查询参数或 `/mmbiz_jpg/` 路径段推断扩展名
- **懒加载处理**：通过模拟滚动触发图片懒加载，确保 `src` 属性为真实地址
- **数据完整性**：推荐使用 `SAVE_SCRIPT` 在浏览器内直接 POST，避免大型 `contentHtml` 经过 Claude 时被截断
- **降级机制**：接收服务不可用时，回退到 `EXTRACT_SCRIPT` 提取 + 文件写入方式
- **代码块识别**：自动识别微信代码块（monospace 字体或深色背景）并转为 Markdown 代码块
