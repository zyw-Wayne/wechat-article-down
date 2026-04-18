#!/usr/bin/env node
/**
 * 本地 JSON 接收服务
 * 监听 17329 端口，接收浏览器 POST 的文章数据，写入 /tmp/wechat_article_data.json
 * 支持 Chrome Private Network Access CORS 策略（OPTIONS preflight）
 *
 * 用法: node receiver.js [port]
 */
const http = require('http');
const fs = require('fs');

const PORT = parseInt(process.argv[2]) || 17329;
const OUT = '/tmp/wechat_article_data.json';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Private-Network': 'true',
};

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, CORS);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    fs.writeFileSync(OUT, body);
    res.writeHead(200, CORS);
    res.end('saved');
    server.close();
    process.stderr.write(`saved ${body.length} bytes to ${OUT}\n`);
  });
});

server.listen(PORT, () => {
  process.stderr.write(`receiver ready on :${PORT}\n`);
});
