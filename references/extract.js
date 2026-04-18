/**
 * 微信文章浏览器提取脚本
 * 在 mcp__chrome-devtools__evaluate_script 中分步调用：
 *
 * Step A：等待正文加载（导航后第一步）
 * Step B：滚动触发懒加载（异步，A 完成后执行）
 * Step C：提取文章数据（同步，B 完成后执行）
 * Step D：SAVE_SCRIPT —— 提取 + 直接 POST 到本地接收服务（推荐，完全绕过 Claude 手写 JSON）
 *
 * ⚠️  推荐用 SAVE_SCRIPT（Step D）替代 EXTRACT_SCRIPT（Step C）+ 手动写文件：
 *    SAVE_SCRIPT 在浏览器内完成提取并 POST，不经过 Claude，contentHtml 不会被截断/简化。
 */

// ── Step A：滚动脚本 ──────────────────────────────────────────────────────────
// 粘贴到第一个 evaluate_script 调用中
const SCROLL_SCRIPT = `
async () => {
  const total = Math.max(document.body.scrollHeight, 3000);
  for (let y = 0; y <= total; y += 300) {
    window.scrollTo(0, y);
    await new Promise(r => setTimeout(r, 60));
  }
  window.scrollTo(0, 0);
  await new Promise(r => setTimeout(r, 1500));
  return { scrolled: true, height: total };
}
`;

// ── Step B：等待正文加载脚本 ──────────────────────────────────────────────────
// 在 navigate_page 之后、滚动之前调用，确认页面已加载
const WAIT_SCRIPT = `
async () => {
  for (let i = 0; i < 30; i++) {
    const el = document.querySelector('#js_content');
    if (el && el.innerText.trim().length > 50) return { loaded: true };
    await new Promise(r => setTimeout(r, 500));
  }
  return {
    loaded: false,
    title: document.title,
    bodySnippet: document.body?.innerText?.slice(0, 200) || ''
  };
}
`;

// ── Step C：数据提取脚本 ──────────────────────────────────────────────────────
// 滚动完成后调用，提取完整文章数据
const EXTRACT_SCRIPT = `
() => {
  const title = document.querySelector('#activity-name')?.innerText?.trim()
    || document.querySelector('.rich_media_title')?.innerText?.trim()
    || document.title.replace(/ - 微信.*$/, '').trim()
    || 'untitled';

  const author = document.querySelector('#js_author_name')?.innerText?.trim()
    || document.querySelector('.rich_media_meta_nickname')?.innerText?.trim()
    || document.querySelector('#js_name')?.innerText?.trim()
    || document.querySelector('.account_nickname_inner')?.innerText?.trim()
    || document.querySelector('meta[name="author"]')?.content?.trim()
    || '';

  const account = document.querySelector('#js_name')?.innerText?.trim()
    || document.querySelector('.account_nickname_inner')?.innerText?.trim()
    || '';

  const publishTime = document.querySelector('#publish_time')?.innerText?.trim()
    || document.querySelector('em#publish_time')?.innerText?.trim()
    || '';

  const digest = document.querySelector('meta[name="description"]')?.content?.trim() || '';

  // 原文链接（转载文章会有此字段）
  const originalUrl = document.querySelector('#js_origin_url')?.getAttribute('href')?.trim()
    || document.querySelector('a#js_origin_url')?.href?.trim()
    || '';

  const contentEl = document.querySelector('#js_content');
  const contentHtml = contentEl ? contentEl.innerHTML : '';

  // 图片：滚动后 src 已是真实 CDN 地址，data-src 作兜底
  // 过滤小图（w/h ≤ 200）跳过图标、头像、分隔线等装饰性图片
  // split('#')[0] 去掉 URL 锚点，防止 CDN 拒绝带 # 的请求
  const images = [];
  const imgSet = new Set();
  if (contentEl) {
    contentEl.querySelectorAll('img').forEach(img => {
      const raw = img.getAttribute('src') || img.getAttribute('data-src') || '';
      const src = raw.split('#')[0];
      const isContent = img.width > 200 || img.height > 200 || (img.width === 0 && img.height === 0);
      if (src && !src.startsWith('data:') && src.startsWith('http') && isContent && !imgSet.has(src)) {
        imgSet.add(src);
        images.push(src);
      }
    });
  }

  // 音频
  const audios = [];
  const audioSet = new Set();
  document.querySelectorAll('audio source, audio[src]').forEach((el, i) => {
    const src = el.tagName === 'SOURCE' ? el.getAttribute('src') : el.getAttribute('src');
    if (src && !audioSet.has(src)) {
      audioSet.add(src);
      audios.push({ src, name: 'audio_' + (i + 1) });
    }
  });
  document.querySelectorAll('[data-voicesrc]').forEach((el, i) => {
    const src = el.getAttribute('data-voicesrc') || '';
    if (src && !audioSet.has(src)) {
      audioSet.add(src);
      audios.push({ src, name: 'voice_' + (i + 1) });
    }
  });

  // 视频
  const videos = [];
  const vidSet = new Set();
  document.querySelectorAll('iframe.video_iframe, iframe[data-src*="v.qq.com"]').forEach(el => {
    const src = el.getAttribute('data-src') || el.getAttribute('src') || '';
    const vid = el.getAttribute('data-vid') || '';
    const poster = el.getAttribute('data-cover') || '';
    if (src && !vidSet.has(src)) { vidSet.add(src); videos.push({ src, poster, vid }); }
  });
  document.querySelectorAll('video').forEach(el => {
    const src = el.getAttribute('src') || el.querySelector('source')?.getAttribute('src') || '';
    const poster = el.getAttribute('poster') || '';
    if (src && src.startsWith('http') && !vidSet.has(src)) {
      vidSet.add(src); videos.push({ src, poster, vid: '' });
    }
  });

  return { url: window.location.href, originalUrl, title, author, account, publishTime, digest, contentHtml, images, audios, videos };
}
`;

// ── Step D：提取 + 直接 POST 到本地接收服务 ───────────────────────────────────
// 使用前先在本地启动接收服务（见 skill.md 步骤5），端口默认 17329
// 此脚本在浏览器内完成提取并 POST，contentHtml 原封不动传输，不经过 Claude
const SAVE_SCRIPT = `
async (port) => {
  port = port || 17329;

  const title = document.querySelector('#activity-name')?.innerText?.trim()
    || document.querySelector('.rich_media_title')?.innerText?.trim()
    || document.title.replace(/ - 微信.*$/, '').trim()
    || 'untitled';

  const author = document.querySelector('#js_author_name')?.innerText?.trim()
    || document.querySelector('.rich_media_meta_nickname')?.innerText?.trim()
    || document.querySelector('#js_name')?.innerText?.trim()
    || document.querySelector('.account_nickname_inner')?.innerText?.trim()
    || document.querySelector('meta[name="author"]')?.content?.trim()
    || '';

  const account = document.querySelector('#js_name')?.innerText?.trim()
    || document.querySelector('.account_nickname_inner')?.innerText?.trim()
    || '';

  const publishTime = document.querySelector('#publish_time')?.innerText?.trim()
    || document.querySelector('em#publish_time')?.innerText?.trim()
    || '';

  const digest = document.querySelector('meta[name="description"]')?.content?.trim() || '';

  const originalUrl = document.querySelector('#js_origin_url')?.getAttribute('href')?.trim()
    || document.querySelector('a#js_origin_url')?.href?.trim()
    || '';

  const contentEl = document.querySelector('#js_content');
  const contentHtml = contentEl ? contentEl.innerHTML : '';

  const images = [];
  const imgSet = new Set();
  if (contentEl) {
    contentEl.querySelectorAll('img').forEach(img => {
      const raw = img.getAttribute('src') || img.getAttribute('data-src') || '';
      const src = raw.split('#')[0];
      const isContent = img.width > 200 || img.height > 200 || (img.width === 0 && img.height === 0);
      if (src && !src.startsWith('data:') && src.startsWith('http') && isContent && !imgSet.has(src)) {
        imgSet.add(src);
        images.push(src);
      }
    });
  }

  const audios = [];
  const audioSet = new Set();
  document.querySelectorAll('audio source, audio[src]').forEach((el, i) => {
    const src = el.tagName === 'SOURCE' ? el.getAttribute('src') : el.getAttribute('src');
    if (src && !audioSet.has(src)) {
      audioSet.add(src);
      audios.push({ src, name: 'audio_' + (i + 1) });
    }
  });
  document.querySelectorAll('[data-voicesrc]').forEach((el, i) => {
    const src = el.getAttribute('data-voicesrc') || '';
    if (src && !audioSet.has(src)) {
      audioSet.add(src);
      audios.push({ src, name: 'voice_' + (i + 1) });
    }
  });

  const videos = [];
  const vidSet = new Set();
  document.querySelectorAll('iframe.video_iframe, iframe[data-src*="v.qq.com"]').forEach(el => {
    const src = el.getAttribute('data-src') || el.getAttribute('src') || '';
    const vid = el.getAttribute('data-vid') || '';
    const poster = el.getAttribute('data-cover') || '';
    if (src && !vidSet.has(src)) { vidSet.add(src); videos.push({ src, poster, vid }); }
  });
  document.querySelectorAll('video').forEach(el => {
    const src = el.getAttribute('src') || el.querySelector('source')?.getAttribute('src') || '';
    const poster = el.getAttribute('poster') || '';
    if (src && src.startsWith('http') && !vidSet.has(src)) {
      vidSet.add(src); videos.push({ src, poster, vid: '' });
    }
  });

  const data = { url: window.location.href, originalUrl, title, author, account, publishTime, digest, contentHtml, images, audios, videos };

  try {
    const resp = await fetch('http://localhost:' + port, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const text = await resp.text();
    return { saved: true, title, images: images.length, audios: audios.length, videos: videos.length, server: text };
  } catch (e) {
    return { saved: false, error: e.message, title, images: images.length };
  }
}
`;
