'use strict';

const os = require('os');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.apk': 'application/vnd.android.package-archive',
  '.ipa': 'application/octet-stream',
  '.dmg': 'application/x-apple-diskimage',
  '.exe': 'application/x-msdownload',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
};

function mimeOf(filename) {
  return MIME[path.extname(String(filename)).toLowerCase()] || 'application/octet-stream';
}

// 取本机所有局域网 IPv4 地址（排除回环）
function getLanIps() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name] || []) {
      if (it.family === 'IPv4' && !it.internal) out.push(it.address);
    }
  }
  return out;
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return (i === 0 || n >= 100 ? n.toFixed(0) : n.toFixed(1)) + ' ' + units[i];
}

// 去掉路径部分和控制字符，只留文件名，防止目录穿越
function safeFilename(name) {
  const base = String(name || 'file').split(/[\\/]/).pop() || 'file';
  return base.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200) || 'file';
}

function randId(len = 12) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function normalizeIp(ip) {
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

function isLoopbackIp(ip) {
  const n = normalizeIp(ip);
  return n === '127.0.0.1' || n === '::1';
}

module.exports = { mimeOf, getLanIps, formatBytes, safeFilename, randId, normalizeIp, isLoopbackIp };
