#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const qrcode = require('qrcode-terminal');

const { FileStore } = require('./lib/files');
const { Hub } = require('./lib/hub');
const { qrSvg } = require('./lib/qrsvg');
const { mimeOf, getLanIps, formatBytes, safeFilename, isLoopbackIp } = require('./lib/util');

const PUBLIC_DIR = path.join(__dirname, 'public');
const VERSION = '0.1.0';

// ---------- 命令行参数 ----------
// 数据目录默认相对当前工作目录（兼容 pkg 单文件二进制：跟随运行位置）
function parseArgs(argv) {
  const out = { port: 8787, pin: '', dir: path.join(process.cwd(), 'data') };
  for (const a of argv.slice(2)) {
    const m = /^--(port|pin|dir)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  out.port = parseInt(out.port, 10) || 8787;
  return out;
}

const args = parseArgs(process.argv);

if (args.help) {
  console.log(`LAN Share v${VERSION} — 局域网文件/消息传输工具

用法:
  node server.js [--port=8787] [--pin=1234] [--dir=./data]

参数:
  --port   监听端口，默认 8787
  --pin    访问 PIN 码（可选），开启后网页和 API 都需要验证
  --dir    文件存储目录，默认 ./data

其他设备加入方式:
  浏览器打开 http://<本机局域网IP>:${args.port}
  可带名字参数: http://<IP>:${args.port}/?name=测试机A

脚本推文件 (CI/自动化):
  curl -T xxx.apk "http://<IP>:${args.port}/api/files?to=all"
`);
  process.exit(0);
}

// ---------- 核心对象 ----------
const fileStore = new FileStore(args.dir);
const hub = new Hub({
  pin: args.pin,
  hostsFile: path.join(args.dir, 'hosts.json'),
  registryFile: path.join(args.dir, 'devices.json'),
});

// ---------- 工具 ----------
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function checkPin(req, u) {
  if (!args.pin) return true;
  const supplied = req.headers['x-pin'] || u.searchParams.get('pin');
  return String(supplied) === String(args.pin);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': mimeOf(filePath),
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// Node 以 latin1 解码请求头，UTF-8 中文会变乱码，这里按原始字节重新解码
function headerUtf8(v) {
  if (!v) return '';
  const s = Buffer.from(v, 'latin1').toString('utf8');
  return s.includes('\uFFFD') ? v : s;
}

// ---------- 文件上传（原始流式 body）----------
async function handleUpload(req, res, u) {
  const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ct === 'multipart/form-data') {
    json(res, 400, {
      ok: false,
      error: '不支持 multipart，请用原始 body 上传，例如: curl -T 文件 "http://ip:port/api/files?name=文件名"',
    });
    return;
  }

  const name = safeFilename(u.searchParams.get('name') || headerUtf8(req.headers['x-filename']) || 'file');
  const to = u.searchParams.get('to') || 'all';
  const fromParam = u.searchParams.get('from') || ''; // 浏览器端传 deviceId；脚本可省略
  const fromName = (u.searchParams.get('fromName') || '脚本').slice(0, 30);
  // 脚本未提供 from 时，按 fromName 生成稳定身份（同名脚本/CI 在会话列表里是同一个发送者）
  const from = fromParam || 'api-' + require('crypto').createHash('md5').update(fromName).digest('hex').slice(0, 8);

  let mime = ct || '';
  if (!mime || mime === 'application/octet-stream' || mime === 'application/x-www-form-urlencoded') {
    mime = mimeOf(name); // curl -T 常不带准确 mime，按扩展名推断
  }

  const up = fileStore.beginUpload(name, mime);
  let aborted = false;
  const cleanup = () => {
    if (aborted) return;
    aborted = true;
    up.abort();
  };
  req.on('error', cleanup);
  res.on('close', () => {
    if (!res.writableEnded) cleanup();
  });

  req.on('data', c => up.count(c.length));
  req.pipe(up.stream);

  try {
    await up.finish();
  } catch (err) {
    cleanup();
    if (!res.writableEnded) json(res, 500, { ok: false, error: '保存失败: ' + err.message });
    return;
  }
  if (aborted) return;

  fileStore.register(up.info);
  const message = hub.createMessage({
    kind: 'file',
    from,
    fromName,
    to,
    file: { id: up.info.id, name: up.info.name, size: up.info.size, mime: up.info.mime },
  });
  json(res, 200, { ok: true, file: message.file, messageId: message.id });
}

// ---------- 文件下载 ----------
function handleDownload(res, u, id) {
  const info = fileStore.get(id);
  if (!info) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('文件不存在或已被清空');
    return;
  }
  const inline = u.searchParams.get('inline') === '1';
  const disposition = (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(info.name);
  let stream;
  try {
    stream = fs.createReadStream(fileStore.pathOf(info));
  } catch {
    res.writeHead(404);
    res.end('文件读取失败');
    return;
  }
  res.writeHead(200, {
    'Content-Type': inline ? info.mime : 'application/octet-stream',
    'Content-Length': info.size,
    'Content-Disposition': disposition,
  });
  stream.pipe(res);
  stream.on('error', () => res.destroy());
}

// 尽力探测服务机当前连接的 Wi-Fi 名称（邀请提示用），跨平台、超时兜底
const { execFile } = require('child_process');
let ssidCache = { value: '', ts: 0 };

// 过滤占位/无效值：新 macOS 的 ipconfig 会把 SSID 输出为字面 <redacted>
function cleanSsid(v) {
  v = String(v || '').trim();
  if (!v) return '';
  if (/redacted|not associated|not found|unknown/i.test(v)) return '';
  if (/^<.*>$/.test(v)) return '';
  return v.slice(0, 30);
}

function detectSsid() {
  if (Date.now() - ssidCache.ts < 30000) return Promise.resolve(ssidCache.value);
  const cache = v => {
    ssidCache = { value: v, ts: Date.now() };
    return v;
  };
  const run = (cmd, args) =>
    new Promise(res => {
      execFile(cmd, args, { timeout: 1500 }, (err, out) => res(err ? '' : String(out || '')));
    });

  return new Promise(resolve => {
    (async () => {
      if (process.platform === 'darwin') {
        // 找到 Wi-Fi 对应的网卡（不一定是 en0）
        const ports = await run('networksetup', ['-listallhardwareports']);
        let dev = 'en0';
        for (const block of ports.split(/(?=Hardware Port:)/)) {
          if (/^Hardware Port:\s*Wi-Fi\b/m.test(block)) {
            const m = /Device:\s*(\S+)/.exec(block);
            if (m) dev = m[1];
            break;
          }
        }
        // 优先 networksetup（真实 SSID；有线/未关联时不含该行）
        let ssid = cleanSsid((/Current Wi-Fi Network\s*:\s*(.+)/.exec(await run('networksetup', ['-getairportnetwork', dev])) || [])[1]);
        if (!ssid) {
          // ipconfig 兜底（新 macOS 会输出 <redacted>，cleanSsid 过滤）
          ssid = cleanSsid((/^\s*SSID\s*:\s*(.+)$/m.exec(await run('ipconfig', ['getsummary', dev])) || [])[1]);
        }
        resolve(cache(ssid));
      } else if (process.platform === 'win32') {
        const out = await run('netsh', ['wlan', 'show', 'interfaces']);
        resolve(cache(cleanSsid((/^\s*SSID\s*:\s*(.+)$/m.exec(out) || [])[1])));
      } else {
        const out = await run('nmcli', ['-t', '-f', 'active,ssid', 'dev', 'wifi']);
        const line = out.split('\n').find(l => l.startsWith('yes:'));
        resolve(cache(cleanSsid(line ? line.slice(4) : '')));
      }
    })().catch(() => resolve(cache('')));
  });
}

// ---------- HTTP 路由 ----------
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  try {
    // 静态页面不需要 PIN（需要先加载页面才能输 PIN）
    if (req.method === 'GET' && (p === '/' || p.startsWith('/assets/') || p === '/favicon.svg')) {
      serveStatic(res, p);
      return;
    }

    if (!checkPin(req, u)) {
      json(res, 401, { ok: false, error: 'PIN 错误，请通过 x-pin 请求头或 ?pin= 参数提供' });
      return;
    }

    if (req.method === 'GET' && p === '/api/health') {
      json(res, 200, { ok: true, version: VERSION, uptime: process.uptime(), pin: !!args.pin });
      return;
    }

    if (req.method === 'GET' && p === '/api/devices') {
      const s = fileStore.stats();
      json(res, 200, { ok: true, devices: hub.deviceList(), files: s });
      return;
    }

    // 从设备注册表移除（管理操作，仅服务器本机）
    if (req.method === 'POST' && p === '/api/devices/purge') {
      if (!isLoopbackIp(req.socket.remoteAddress)) {
        json(res, 403, { ok: false, error: '只有服务器本机才能移除设备' });
        return;
      }
      readBody(req)
        .then(buf => {
          let names = [];
          try {
            const b = JSON.parse(buf.toString('utf8') || '{}');
            if (Array.isArray(b.names)) names = b.names;
          } catch {
            // 忽略
          }
          const changed = hub.removeFromRegistry(names);
          json(res, 200, { ok: true, changed, devices: hub.deviceList() });
        })
        .catch(() => json(res, 400, { ok: false, error: '请求体解析失败' }));
      return;
    }

    // 邀请信息：加入地址、Wi-Fi 名称、PIN（公开接口，供邀请弹窗使用）
    if (req.method === 'GET' && p === '/api/invite') {
      const urls = getLanIps().map(ip => 'http://' + ip + ':' + args.port);
      if (!urls.length) urls.push('http://localhost:' + args.port);
      detectSsid().then(ssid => {
        json(res, 200, { ok: true, urls, ssid, pin: args.pin || '' });
      });
      return;
    }

    // 二维码 SVG
    if (req.method === 'GET' && p === '/api/qr.svg') {
      const target = (u.searchParams.get('u') || '').slice(0, 500);
      if (!target) {
        res.writeHead(400);
        res.end();
        return;
      }
      try {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(qrSvg(target));
      } catch (err) {
        res.writeHead(500);
        res.end();
      }
      return;
    }

    if ((req.method === 'POST' || req.method === 'PUT') && p === '/api/files') {
      handleUpload(req, res, u);
      return;
    }

    if (req.method === 'DELETE' && p === '/api/files') {
      // 清空文件属于管理操作，仅允许服务器本机调用，局域网其他设备一律拒绝
      if (!isLoopbackIp(req.socket.remoteAddress)) {
        json(res, 403, { ok: false, error: '只有服务器本机才能清空文件' });
        return;
      }
      fileStore.clear();
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && p === '/api/send-text') {
      readBody(req)
        .then(buf => {
          let text = u.searchParams.get('text') || '';
          let to = u.searchParams.get('to') || 'all';
          let fromName = u.searchParams.get('fromName') || '脚本';
          if (buf.length) {
            try {
              const b = JSON.parse(buf.toString('utf8'));
              if (b.text) text = b.text;
              if (b.to) to = b.to;
              if (b.fromName) fromName = b.fromName;
            } catch {
              text = buf.toString('utf8'); // 非 JSON body 直接当作文本
            }
          }
          if (!text.trim()) {
            json(res, 400, { ok: false, error: 'text 不能为空' });
            return;
          }
          const message = hub.createMessage({
            kind: 'text',
            from: 'api-' + require('crypto').createHash('md5').update(String(fromName)).digest('hex').slice(0, 8),
            fromName,
            to,
            text: text.slice(0, 64 * 1024),
          });
          json(res, 200, { ok: true, messageId: message.id });
        })
        .catch(() => json(res, 413, { ok: false, error: '请求体过大' }));
      return;
    }

    if (req.method === 'GET' && p.startsWith('/files/')) {
      handleDownload(res, u, p.slice('/files/'.length).split('/')[0]);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (err) {
    json(res, 500, { ok: false, error: String(err && err.message) });
  }
});

// WebSocket 挂载到同一端口
hub.attach(server);

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${args.port} 已被占用，换一个: node server.js --port=${args.port + 1}`);
    process.exit(1);
  }
  console.error('服务器错误:', err);
});

server.listen(args.port, '0.0.0.0', () => {
  const ips = getLanIps();
  const primary = ips[0] || '127.0.0.1';
  const mainUrl = `http://${primary}:${args.port}`;

  console.log('');
  console.log('  🚀 LAN Share v' + VERSION + ' 已启动');
  console.log('  ─────────────────────────────────────────');
  console.log(`  端口 : ${args.port}    PIN : ${args.pin || '未启用'}`);
  console.log(`  本机 : http://localhost:${args.port}`);
  if (ips.length) {
    console.log('  局域网地址（其他设备浏览器打开即可加入）:');
    for (const ip of ips) console.log(`      http://${ip}:${args.port}`);
    console.log('');
    qrcode.generate(mainUrl, { small: true }, q => {
      console.log('  扫码加入（' + mainUrl + '）:');
      console.log(
        q
          .split('\n')
          .map(l => '  ' + l)
          .join('\n')
      );
    });
    console.log(`  提示: 给测试机起名可用 ${mainUrl}/?name=测试机A`);
    console.log(`  脚本推文件: curl -T xxx.apk "${mainUrl}/api/files?to=all"`);
  } else {
    console.log('  ⚠️ 未检测到局域网 IP，当前只能本机访问');
  }
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\n正在关闭 LAN Share...');
  hub.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
});
