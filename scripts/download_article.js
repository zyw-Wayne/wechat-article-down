#!/usr/bin/env node

/**
 * 微信公众号文章内容下载工具
 * 接收从 chrome-devtools MCP 提取的文章数据，下载图片/音频/视频并保存为 Markdown
 *
 * 用法:
 *   node download_article.js --data '<json>' [选项]
 *   echo '<json>' | node download_article.js --stdin [选项]
 *
 * JSON 数据格式（由 skill 中的 chrome-devtools evaluate_script 提取后传入）:
 * {
 *   "url": "https://mp.weixin.qq.com/...",
 *   "title": "文章标题",
 *   "author": "作者",
 *   "account": "公众号名称",
 *   "publishTime": "2024-01-15 10:30:00",
 *   "digest": "文章摘要",
 *   "contentHtml": "<div>...</div>",   // js_content 内部 HTML
 *   "images": ["https://mmbiz...", ...],
 *   "audios": [{"src":"...","name":"..."},...],
 *   "videos": [{"src":"...","poster":"...","vid":"..."},...]
 * }
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');

// ─── 工具函数（与 search_wechat.js 保持一致） ───────────────────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36',
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function decompressBody(buffer, contentEncoding) {
  if (!contentEncoding) return buffer;
  const encoding = String(contentEncoding).toLowerCase();
  try {
    if (encoding.includes('gzip')) return zlib.gunzipSync(buffer);
    if (encoding.includes('deflate')) return zlib.inflateSync(buffer);
    if (encoding.includes('br')) return zlib.brotliDecompressSync(buffer);
  } catch {
    // 解压失败返回原始数据
  }
  return buffer;
}

/**
 * 通用网络请求（支持 http / https 自动分发），带超时与重试
 * @param {{url:string, method?:string, headers?:Object, timeoutMs?:number, retries?:number}} options
 * @returns {Promise<{statusCode:number, headers:Object, body:Buffer}>}
 */
async function request(options) {
  const {
    url,
    method = 'GET',
    headers = {},
    timeoutMs = 30000,
    retries = 2,
  } = options;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const isHttps = urlObj.protocol === 'https:';
        const transport = isHttps ? https : http;

        const reqOptions = {
          hostname: urlObj.hostname,
          port: urlObj.port || (isHttps ? 443 : 80),
          path: urlObj.pathname + urlObj.search,
          method,
          headers,
        };

        const req = transport.request(reqOptions, (res) => {
          // 跟随重定向（最多 5 次）
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const redirectUrl = new URL(res.headers.location, url).toString();
            resolve(request({ ...options, url: redirectUrl, retries: Math.max(0, retries - attempt) }));
            return;
          }

          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks);
            const body = decompressBody(raw, res.headers['content-encoding']);
            resolve({ statusCode: res.statusCode || 0, headers: res.headers, body });
          });
        });

        req.on('error', reject);
        req.setTimeout(timeoutMs, () => {
          req.destroy();
          reject(new Error('Request timeout'));
        });
        req.end();
      });
      return result;
    } catch (e) {
      if (attempt >= retries) throw new Error(`Request failed: ${method} ${url}: ${e.message}`);
      await sleep(500 + attempt * 500);
    }
  }

  throw new Error(`Request failed: ${method} ${url}: unexpected`);
}

// ─── 文件系统工具 ───────────────────────────────────────────────────────────

/**
 * 将字符串安全化为文件名（去除非法字符）
 */
function sanitizeFilename(name, maxLen = 80) {
  return name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen) || 'untitled';
}

/**
 * 确保目录存在，不存在则创建
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * 从 URL 或 MIME 类型推断文件扩展名
 * 专门处理微信 CDN (mmbiz.qpic.cn) 的两种特有模式：
 *   - 查询参数：?wx_fmt=jpeg
 *   - 路径段：  /mmbiz_jpg/ /mmbiz_png/ /mmbiz_gif/ /mmbiz_webp/
 */
function guessExtension(url, mimeType = '') {
  try {
    const urlObj = new URL(url);

    // 1. 微信 CDN 查询参数（最常见）：?wx_fmt=jpeg|png|gif|webp
    const wxFmt = urlObj.searchParams.get('wx_fmt');
    if (wxFmt) {
      const fmt = wxFmt.toLowerCase();
      return fmt === 'jpeg' ? '.jpg' : `.${fmt}`;
    }

    // 2. 微信 CDN 路径段：/mmbiz_jpg/ /mmbiz_png/ /mmbiz_gif/ /mmbiz_webp/
    const pathFmt = urlObj.pathname.match(/\/mmbiz_(\w+)\//i);
    if (pathFmt) {
      const fmt = pathFmt[1].toLowerCase();
      if (fmt === 'jpg' || fmt === 'jpeg') return '.jpg';
      if (['png', 'gif', 'webp'].includes(fmt)) return `.${fmt}`;
    }

    // 3. 普通路径扩展名
    const extMatch = urlObj.pathname.match(/\.(\w{2,5})(?:\?|$)/i);
    if (extMatch) return `.${extMatch[1].toLowerCase()}`;
  } catch {
    // URL 解析失败时跳过
  }

  // 4. MIME 类型兜底
  const mimeMap = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'image/webp': '.webp', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
    'audio/ogg': '.ogg', 'video/mp4': '.mp4', 'video/webm': '.webm',
  };
  for (const [mime, ext] of Object.entries(mimeMap)) {
    if (mimeType.includes(mime)) return ext;
  }

  return '.bin';
}

// ─── 下载逻辑 ────────────────────────────────────────────────────────────────

const failedAssets = [];

/**
 * 下载单个资源文件
 * @param {string} assetUrl - 资源 URL
 * @param {string} destDir  - 保存目录
 * @param {string} prefix   - 文件名前缀（如 "img_001"）
 * @param {string} referer  - Referer 请求头
 * @returns {Promise<string|null>} 保存的相对文件名，失败返回 null
 */
async function downloadAsset(assetUrl, destDir, prefix, referer = '') {
  if (!assetUrl || assetUrl.startsWith('data:')) return null;

  // 微信 CDN 必须携带正确 Referer，否则返回 403
  // Referer 应为文章完整 URL（不能只写域名）
  const effectiveReferer = referer || 'https://mp.weixin.qq.com/';

  let hostname = '';
  try { hostname = new URL(assetUrl).hostname; } catch {}

  try {
    const resp = await request({
      url: assetUrl,
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Referer': effectiveReferer,
        'Host': hostname,
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
      },
      timeoutMs: 60000,
      retries: 2,
    });

    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      throw new Error(`HTTP ${resp.statusCode}`);
    }

    const contentType = resp.headers['content-type'] || '';
    const ext = guessExtension(assetUrl, contentType) || '.bin';
    const filename = `${prefix}${ext}`;
    const destPath = path.join(destDir, filename);

    fs.writeFileSync(destPath, resp.body);
    return filename;
  } catch (e) {
    failedAssets.push({ url: assetUrl, reason: e.message });
    return null;
  }
}

/**
 * 批量下载图片，返回 原URL => 本地相对路径 的映射
 * @param {string[]} imageUrls
 * @param {string} imagesDir
 * @param {string} articleUrl
 * @returns {Promise<Map<string,string>>}
 */
async function downloadImages(imageUrls, imagesDir, articleUrl) {
  ensureDir(imagesDir);
  const urlMap = new Map();

  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    const prefix = `img_${String(i + 1).padStart(3, '0')}`;
    console.error(`  [图片 ${i + 1}/${imageUrls.length}] 下载中...`);

    const filename = await downloadAsset(url, imagesDir, prefix, articleUrl);
    if (filename) {
      urlMap.set(url, `images/${filename}`);
    }

    // 短暂延迟，避免请求过快
    if (i < imageUrls.length - 1) {
      await sleep(100 + Math.random() * 200);
    }
  }

  return urlMap;
}

/**
 * 批量下载音频，返回 原URL => 本地相对路径 的映射
 * @param {{src:string, name?:string}[]} audioList
 * @param {string} audioDir
 * @param {string} articleUrl
 * @returns {Promise<Map<string,string>>}
 */
async function downloadAudios(audioList, audioDir, articleUrl) {
  ensureDir(audioDir);
  const urlMap = new Map();

  for (let i = 0; i < audioList.length; i++) {
    const { src, name } = audioList[i];
    const prefix = name ? sanitizeFilename(name, 40) : `audio_${String(i + 1).padStart(3, '0')}`;
    console.error(`  [音频 ${i + 1}/${audioList.length}] 下载中...`);

    const filename = await downloadAsset(src, audioDir, prefix, articleUrl);
    if (filename) {
      urlMap.set(src, `audio/${filename}`);
    }

    await sleep(200 + Math.random() * 300);
  }

  return urlMap;
}

/**
 * 下载视频 —— 优先尝试 yt-dlp，失败则直链下载
 * @param {{src:string, poster?:string, vid?:string}[]} videoList
 * @param {string} videoDir
 * @param {string} articleUrl
 * @returns {Promise<Map<string,string>>}
 */
async function downloadVideos(videoList, videoDir, articleUrl) {
  ensureDir(videoDir);
  const urlMap = new Map();

  // 检查 yt-dlp 是否可用
  let ytdlpAvailable = false;
  try {
    execSync('yt-dlp --version', { stdio: 'pipe' });
    ytdlpAvailable = true;
  } catch {
    console.error('  [提示] yt-dlp 未安装，将尝试直链下载视频（可能不完整）');
    console.error('  [提示] 安装方法: brew install yt-dlp 或 pip install yt-dlp');
  }

  for (let i = 0; i < videoList.length; i++) {
    const { src, poster, vid } = videoList[i];
    const prefix = `video_${String(i + 1).padStart(3, '0')}`;
    console.error(`  [视频 ${i + 1}/${videoList.length}] 下载中...`);

    let saved = false;

    // 优先使用 yt-dlp（处理腾讯视频、动态流等）
    if (ytdlpAvailable && src) {
      try {
        const outTemplate = path.join(videoDir, `${prefix}.%(ext)s`);
        execSync(
          `yt-dlp --no-playlist -o "${outTemplate}" "${src}"`,
          { stdio: 'pipe', timeout: 120000 }
        );
        // 查找生成的文件
        const files = fs.readdirSync(videoDir).filter(f => f.startsWith(prefix));
        if (files.length > 0) {
          urlMap.set(src, `video/${files[0]}`);
          saved = true;
        }
      } catch (e) {
        console.error(`  [视频] yt-dlp 失败: ${e.message}，尝试直链下载`);
      }
    }

    // 直链下载（降级方案）
    if (!saved && src) {
      const filename = await downloadAsset(src, videoDir, prefix, articleUrl);
      if (filename) {
        urlMap.set(src, `video/${filename}`);
        saved = true;
      }
    }

    // 下载封面图（如有）
    if (poster) {
      await downloadAsset(poster, videoDir, `${prefix}_poster`, articleUrl);
    }

    await sleep(500 + Math.random() * 500);
  }

  return urlMap;
}

// ─── HTML 转 Markdown ────────────────────────────────────────────────────────

/**
 * 预处理微信代码块：
 *   - 去掉"只含行号"的 section/p（微信代码块左列）
 *   - 把含 monospace 字体的 section / <pre> 包装为 <pre> 标签
 */
function preprocessWeChatCodeBlocks(html) {
  // 1. 删除代码块行号列表（微信代码块左列）
  //    形态 A：section 内只有 <p>1</p><p>2</p>... 纯数字
  //    形态 B：<ul class="code-snippet__line-index"> 内含空或数字 <li>
  html = html.replace(
    /<section[^>]*>((?:\s*<(?:p|span|li)[^>]*>\s*\d+\s*<\/(?:p|span|li)>\s*)+)<\/section>/gi,
    ''
  );
  html = html.replace(
    /<ul[^>]*class="[^"]*code-snippet__line-index[^"]*"[^>]*>[\s\S]*?<\/ul>/gi,
    ''
  );

  // 2. 把带 monospace 字体或深色背景的 section/div 转成 <pre>
  //    使用深度追踪正确匹配嵌套标签（旧实现用 [\s\S]*?<\/\1> 会匹配到内层闭合标签）
  const monoRe = /font-family[^;"']*(?:Consolas|Courier|SFMono|Monaco|monospace)/i;
  const darkBgRe = /background(?:-color)?\s*:\s*rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i;

  function shouldConvert(attrs) {
    if (monoRe.test(attrs)) return true;
    const m = attrs.match(darkBgRe);
    return !!(m && Number(m[1]) < 80 && Number(m[2]) < 80 && Number(m[3]) < 80);
  }

  // 深度追踪找到匹配的闭合标签
  function findMatchingClose(str, afterOpen, tagLower) {
    const openTag = '<' + tagLower;
    const closeTag = '</' + tagLower + '>';
    let depth = 1;
    let pos = afterOpen;
    while (depth > 0) {
      const nextOpen = str.indexOf(openTag, pos);
      const nextClose = str.indexOf(closeTag, pos);
      if (nextClose === -1) return -1;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        pos = nextOpen + openTag.length;
      } else {
        depth--;
        if (depth === 0) return nextClose;
        pos = nextClose + closeTag.length;
      }
    }
    return -1;
  }

  // 扫描所有 section/div 开标签，收集需要转换的区间
  const tagOpenRe = /<(section|div)(\s[^>]*?)>/gi;
  const replacements = [];
  let match;
  // 在小写副本上做 indexOf，保留原始大小写做属性检测
  const lowerHtml = html.toLowerCase();
  while ((match = tagOpenRe.exec(html)) !== null) {
    if (!shouldConvert(match[2] || '')) continue;
    const tag = match[1].toLowerCase();
    const openEnd = match.index + match[0].length;
    const closeStart = findMatchingClose(lowerHtml, openEnd, tag);
    if (closeStart === -1) continue;
    const closeEnd = closeStart + tag.length + 3; // </ + tag + >
    replacements.push({ start: match.index, end: closeEnd, openEnd, closeStart });
  }

  // 去除被外层包含的替换（仅保留最外层）
  const filtered = replacements.filter((r, i) =>
    !replacements.some((other, j) => j !== i && other.start <= r.start && other.end >= r.end)
  );

  // 从后往前替换，避免索引偏移
  for (let i = filtered.length - 1; i >= 0; i--) {
    const r = filtered[i];
    const inner = html.slice(r.openEnd, r.closeStart);
    html = html.slice(0, r.start) + `<pre>${inner}</pre>` + html.slice(r.end);
  }

  return html;
}

/**
 * 将 <table> 内容转为 Markdown 表格
 */
function convertTableToMarkdown(tableHtml) {
  const rows = [];
  tableHtml.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_, rowContent) => {
    const cells = [];
    rowContent.replace(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi, (__, cell) => {
      cells.push(stripTags(cell).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim());
    });
    if (cells.length) rows.push(cells);
  });
  if (!rows.length) return '';

  const colCount = Math.max(...rows.map(r => r.length));
  const pad = (row) => {
    while (row.length < colCount) row.push('');
    return row;
  };

  const lines = rows.map((row, i) => {
    const line = '| ' + pad(row).join(' | ') + ' |';
    if (i === 0) return line + '\n| ' + Array(colCount).fill('---').join(' | ') + ' |';
    return line;
  });
  return '\n' + lines.join('\n') + '\n';
}

/**
 * 将文章 HTML 转为 Markdown，替换图片/音频/视频为本地路径
 * @param {string} contentHtml   - js_content 内部 HTML
 * @param {Map<string,string>} imageMap
 * @param {Map<string,string>} audioMap
 * @param {Map<string,string>} videoMap
 * @returns {string} Markdown 文本
 */
function htmlToMarkdown(contentHtml, imageMap, audioMap, videoMap) {
  let md = preprocessWeChatCodeBlocks(contentHtml);

  // SVG 兜底：提取 <text>/<tspan> 文本，格式化为代码块（部分文章用 SVG 绘制图表）
  md = md.replace(/<svg[^>]*>([\s\S]*?)<\/svg>/gi, (svgBlock) => {
    const texts = [];
    svgBlock.replace(/<(?:text|tspan)[^>]*>([^<]*)<\/(?:text|tspan)>/gi, (_, t) => {
      const clean = t.trim();
      if (clean) texts.push(clean);
    });
    return texts.length ? '\n```\n' + texts.join('\n') + '\n```\n' : '';
  });

  // 替换图片：优先取 src（懒加载后的真实 CDN URL），data-src 兜底
  // 注意：微信图片标签通常 data-src 在前、src 在后，若用 (?:data-src|src) 会优先匹配
  // data-src（占位 URL），导致与 imageMap（以真实 src 为 key）对不上，图片引用丢失
  md = md.replace(/<img([^>]*)>/gi, (match, attrs) => {
    const srcM    = attrs.match(/\bsrc=["']([^"']+)["']/i);
    const dataSrcM = attrs.match(/\bdata-src=["']([^"']+)["']/i);
    const raw = (srcM || dataSrcM)?.[1];
    if (!raw || raw.startsWith('data:')) return '';
    const cleanSrc = raw.split('#')[0];
    const localPath = imageMap.get(cleanSrc) || imageMap.get(raw);
    if (localPath) return `![图片](./${localPath})`;
    return `![图片](${cleanSrc})`;
  });

  // 替换音频
  md = md.replace(/<audio[^>]*src=["']([^"']+)["'][^>]*>.*?<\/audio>/gis, (match, src) => {
    const localPath = audioMap.get(src);
    return localPath ? `\n🎵 [音频文件](./${localPath})\n` : `\n🎵 [音频](${src})\n`;
  });

  // 替换视频
  md = md.replace(/<video[^>]*src=["']([^"']+)["'][^>]*>.*?<\/video>/gis, (match, src) => {
    const localPath = videoMap.get(src);
    return localPath ? `\n🎬 [视频文件](./${localPath})\n` : `\n🎬 [视频](${src})\n`;
  });

  // 替换 iframe 内嵌视频
  md = md.replace(/<iframe[^>]*(?:data-src|src)=["']([^"']+)["'][^>]*>.*?<\/iframe>/gis, (match, src) => {
    const localPath = videoMap.get(src);
    return localPath ? `\n🎬 [视频文件](./${localPath})\n` : `\n🎬 [视频](${src})\n`;
  });

  // 处理表格（在其他转换之前，避免嵌套标签干扰）
  md = md.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, inner) =>
    convertTableToMarkdown(inner)
  );

  // 处理 <pre> 代码块
  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => {
    const code = inner
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<p[^>]*>/gi, '')
      // 块级闭合标签产生换行（微信代码块每行是独立的 <code>/<section>/<div>）
      .replace(/<\/(?:code|section|div|li)>/gi, '\n')
      .replace(/<(?:code|section|div|ul|ol|li)[^>]*>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{2,}/g, '\n')       // 合并代码块内多余空行
      .trim();
    return `\n\`\`\`\n${code}\n\`\`\`\n`;
  });

  // 处理行内 <code>
  md = md.replace(/<code[^>]*>(.*?)<\/code>/gis, (_, c) => `\`${stripTags(c)}\``);

  // 处理无序列表（过滤空列表项，如微信代码块行号列表残留）
  md = md.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, inner) => {
    const items = [];
    inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (__, item) => {
      const text = stripTags(item).replace(/\s+/g, ' ').trim();
      if (text) items.push(`- ${text}`);
    });
    return items.length ? '\n' + items.join('\n') + '\n' : '';
  });

  // 处理有序列表（过滤空列表项）
  md = md.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner) => {
    let i = 1;
    const items = [];
    inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (__, item) => {
      const text = stripTags(item).replace(/\s+/g, ' ').trim();
      if (text) items.push(`${i++}. ${text}`);
    });
    return items.length ? '\n' + items.join('\n') + '\n' : '';
  });

  // 基础 HTML 转 Markdown
  md = md
    .replace(/<h([1-6])[^>]*>(.*?)<\/h\1>/gis, (_, level, content) =>
      `\n${'#'.repeat(Number(level))} ${stripTags(content)}\n`)
    .replace(/<strong[^>]*>(.*?)<\/strong>/gis, (_, c) => `**${stripTags(c)}**`)
    .replace(/<b[^>]*>(.*?)<\/b>/gis, (_, c) => `**${stripTags(c)}**`)
    .replace(/<em[^>]*>(.*?)<\/em>/gis, (_, c) => `*${stripTags(c)}*`)
    .replace(/<i[^>]*>(.*?)<\/i>/gis, (_, c) => `*${stripTags(c)}*`)
    .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis, (_, href, text) =>
      `[${stripTags(text)}](${href})`)
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, c) => {
      const text = stripTags(c).replace(/\s+/g, ' ').trim();
      return '\n> ' + text.split('\n').join('\n> ') + '\n';
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<\/?(div|section|article|figure|figcaption)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')          // 清除剩余标签
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')       // 合并多余空行
    .trim();

  return md;
}

function stripTags(html) {
  return (html || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

// ─── 保存失败日志 ─────────────────────────────────────────────────────────────

function saveFailedLog(outputDir) {
  if (failedAssets.length === 0) return;
  const logPath = path.join(outputDir, 'failed.log');
  const lines = failedAssets.map(f => `[FAILED] ${f.url}\n  原因: ${f.reason}`);
  fs.writeFileSync(logPath, lines.join('\n\n'), 'utf-8');
  console.error(`  [警告] ${failedAssets.length} 个资源下载失败，详见: ${logPath}`);
}

// ─── 主逻辑 ──────────────────────────────────────────────────────────────────

/**
 * 处理单篇文章数据，下载所有资源并保存
 * @param {Object} articleData - 文章数据（格式见文件头注释）
 * @param {string} baseOutputDir - 根输出目录（默认 ./downloads）
 * @returns {Promise<{outputDir:string, stats:Object}>}
 */
async function processArticle(articleData, baseOutputDir = './downloads') {
  const {
    url = '',
    originalUrl = '',
    title = 'untitled',
    author = '',
    account = '',
    publishTime = '',
    digest = '',
    contentHtml = '',
    images = [],
    audios = [],
    videos = [],
  } = articleData;

  // 创建文章目录（以标题命名）
  const dirName = sanitizeFilename(title);
  const outputDir = path.join(baseOutputDir, dirName);
  ensureDir(outputDir);

  console.error(`\n📁 输出目录: ${outputDir}`);
  console.error(`📰 标题: ${title}`);

  const imagesDir = path.join(outputDir, 'images');
  const audioDir  = path.join(outputDir, 'audio');
  const videoDir  = path.join(outputDir, 'video');

  // ── 并行：图片可同时进行（已在函数内做延迟，不对服务器造成冲击）
  let imageMap = new Map();
  let audioMap = new Map();
  let videoMap = new Map();

  if (images.length > 0) {
    console.error(`\n⬇️  下载图片 (${images.length} 张)...`);
    imageMap = await downloadImages(images, imagesDir, url);
  }

  if (audios.length > 0) {
    console.error(`\n⬇️  下载音频 (${audios.length} 个)...`);
    audioMap = await downloadAudios(audios, audioDir, url);
  }

  if (videos.length > 0) {
    console.error(`\n⬇️  下载视频 (${videos.length} 个)...`);
    videoMap = await downloadVideos(videos, videoDir, url);
  }

  // ── 生成 Markdown
  let bodyMd = htmlToMarkdown(contentHtml, imageMap, audioMap, videoMap);

  // ── 检查遗漏图片：imageMap 中已下载但未出现在正文里的图片追加到末尾
  // 原因：contentHtml 若不含完整 <img> 标签（如被简化过），htmlToMarkdown 无法嵌入图片
  const missingImages = [];
  for (const [, localPath] of imageMap.entries()) {
    if (!bodyMd.includes(localPath)) {
      missingImages.push(localPath);
    }
  }
  if (missingImages.length > 0) {
    console.error(`\n  ⚠️  ${missingImages.length} 张图片在正文中无定位信息，已按下载顺序追加至末尾`);
    const appendSection =
      '\n\n---\n\n> ⚠️ 以下图片未能从正文 HTML 中定位，按下载顺序追加：\n\n' +
      missingImages.map(p => `![图片](./${p})`).join('\n\n');
    bodyMd += appendSection;
  }
  const frontmatter = [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    author      ? `author: "${author}"` : '',
    account     ? `account: "${account}"` : '',
    publishTime ? `date: "${publishTime}"` : '',
    digest      ? `digest: "${digest.replace(/"/g, '\\"')}"` : '',
    url         ? `source: "${url}"` : '',
    originalUrl ? `original_url: "${originalUrl}"` : '',
    '---',
  ].filter(Boolean).join('\n');

  // 正文开头可见的元信息区块
  const metaLines = [];
  if (author)      metaLines.push(`**作者**：${author}`);
  if (account)     metaLines.push(`**公众号**：${account}`);
  if (publishTime) metaLines.push(`**发布时间**：${publishTime}`);
  if (url)         metaLines.push(`**原文链接**：[${title}](${url})`);
  if (originalUrl) metaLines.push(`**转载来源**：[原文](${originalUrl})`);
  const metaBlock = metaLines.length > 0 ? metaLines.join('  \n') + '\n\n---\n' : '';

  // 若正文已以标题开头，不再重复添加
  const bodyStartsWithTitle = bodyMd.trimStart().startsWith(`# ${title}`);
  const markdown = bodyStartsWithTitle
    ? `${frontmatter}\n\n${metaBlock}${bodyMd}`
    : `${frontmatter}\n\n# ${title}\n\n${metaBlock}${bodyMd}`;
  const mdPath = path.join(outputDir, 'article.md');
  fs.writeFileSync(mdPath, markdown, 'utf-8');

  // ── 失败日志
  saveFailedLog(outputDir);

  const stats = {
    images: { total: images.length, saved: imageMap.size },
    audios: { total: audios.length, saved: audioMap.size },
    videos: { total: videos.length, saved: videoMap.size },
  };

  return { outputDir, stats };
}

// ─── CLI 入口 ────────────────────────────────────────────────────────────────

function parseCliArgs(args) {
  let dataStr = '';
  let outputDir = './downloads';
  let fromStdin = false;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-d' || args[i] === '--data') && args[i + 1]) {
      dataStr = args[++i];
    } else if ((args[i] === '-o' || args[i] === '--output') && args[i + 1]) {
      outputDir = args[++i];
    } else if (args[i] === '--stdin') {
      fromStdin = true;
    }
  }

  return { dataStr, outputDir, fromStdin };
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data.trim()));
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
微信公众号文章内容下载工具

用法:
  node download_article.js --data '<json>' [选项]
  echo '<json>' | node download_article.js --stdin [选项]

选项:
  -d, --data <json>    文章数据 JSON 字符串
  --stdin              从标准输入读取 JSON
  -o, --output <dir>   输出根目录（默认: ./downloads）
  -h, --help           显示帮助

JSON 格式:
  {
    "url": "https://mp.weixin.qq.com/...",
    "title": "文章标题",
    "author": "作者",
    "account": "公众号名称",
    "publishTime": "2024-01-15 10:30:00",
    "digest": "摘要",
    "contentHtml": "<div>...</div>",
    "images": ["url1", "url2"],
    "audios": [{"src":"url","name":"名称"}],
    "videos": [{"src":"url","poster":"封面url","vid":"腾讯视频id"}]
  }

示例:
  node download_article.js --data '{"url":"...","title":"测试","contentHtml":"<p>内容</p>","images":[]}'
`);
    process.exit(0);
  }

  const { dataStr, outputDir, fromStdin } = parseCliArgs(args);

  let jsonStr = dataStr;
  if (fromStdin || (!dataStr && !process.stdin.isTTY)) {
    jsonStr = await readStdin();
  }

  if (!jsonStr) {
    console.error('错误: 未提供文章数据，请使用 --data 或 --stdin');
    process.exit(1);
  }

  let articleData;
  try {
    articleData = JSON.parse(jsonStr);
  } catch (e) {
    console.error(`错误: JSON 解析失败: ${e.message}`);
    process.exit(1);
  }

  // 支持单篇或多篇（数组）
  const articles = Array.isArray(articleData) ? articleData : [articleData];
  const results = [];

  for (let i = 0; i < articles.length; i++) {
    console.error(`\n${'─'.repeat(50)}`);
    console.error(`处理第 ${i + 1}/${articles.length} 篇文章`);
    try {
      const result = await processArticle(articles[i], outputDir);
      results.push({ success: true, ...result });

      console.error(`\n✅ 完成!`);
      console.error(`   📝 article.md`);
      console.error(`   🖼️  图片: ${result.stats.images.saved}/${result.stats.images.total}`);
      console.error(`   🎵 音频: ${result.stats.audios.saved}/${result.stats.audios.total}`);
      console.error(`   🎬 视频: ${result.stats.videos.saved}/${result.stats.videos.total}`);
      console.error(`   📁 ${result.outputDir}`);
    } catch (e) {
      console.error(`❌ 处理失败: ${e.message}`);
      results.push({ success: false, error: e.message });
    }
  }

  // 输出结构化结果（供 skill 读取）
  console.log(JSON.stringify(results, null, 2));
}

module.exports = { processArticle, downloadAsset, sanitizeFilename };

if (require.main === module) {
  main();
}
