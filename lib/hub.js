'use strict';

const os = require('os');
const dns = require('dns');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const { randId, normalizeIp, isLoopbackIp } = require('./util');

const HISTORY_LIMIT = 200;
const NAME_MAX = 30;
const TEXT_MAX = 64 * 1024; // 单条文本上限 64KB
const RECALL_WINDOW = 2 * 60 * 1000; // 消息发出后 2 分钟内可撤回
const HOSTS_MAX = 500; // IP 身份记忆上限

// 为连接推测一个默认设备名：
// 1) 服务端本机连接 → 本机主机名（如 NicholeMac），取不到退回系统用户名；
// 2) 其他局域网机器 → 反查 DNS 主机名（尽力而为）
function lookupNameHint(ip) {
  return new Promise(resolve => {
    if (ip === '127.0.0.1' || ip === '::1') {
      const h = String(os.hostname() || '').split('.')[0].trim().slice(0, NAME_MAX);
      if (h) return resolve(h);
      try {
        const u = os.userInfo().username;
        if (u) return resolve(String(u).trim().slice(0, NAME_MAX));
      } catch {
        // 忽略
      }
      return resolve(null);
    }
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(null);
      }
    }, 1000);
    dns.reverse(ip, (err, hostnames) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err || !hostnames || !hostnames.length) return resolve(null);
      const h = String(hostnames[0]).split('.')[0].trim().slice(0, NAME_MAX);
      resolve(h && h !== ip ? h : null);
    });
  });
}

// 连接与消息中枢：设备注册、心跳、消息路由（群发/定向）、历史保留
// 同一设备允许多个连接（同机多标签页），消息会投递到该设备的所有连接
class Hub {
  constructor({ pin, hostsFile, registryFile }) {
    this.pin = pin ? String(pin) : null;
    this.devices = new Map(); // 在线连接：deviceId -> { deviceId, name, conns: Set<ws>, ts, hidden }
    this.history = [];        // 最近 HISTORY_LIMIT 条消息
    this.wss = null;
    this._heartbeatTimer = null;

    // IP -> { deviceId, name, ts } 身份记忆：换浏览器/无痕访问时按来源 IP 恢复设备身份
    this.hostsFile = hostsFile || null;
    this.knownHosts = new Map();
    if (this.hostsFile) {
      try {
        const arr = JSON.parse(fs.readFileSync(this.hostsFile, 'utf8'));
        if (Array.isArray(arr)) {
          arr.forEach(([ip, v]) => {
            if (ip && v && v.deviceId) this.knownHosts.set(ip, v);
          });
        }
      } catch {
        // 文件不存在或损坏则从零开始
      }
    }

    // 设备注册表（单一事实来源）：所有访问过的设备都在这里，
    // 所有人看到的设备列表 = 注册表（online 标记实时状态），仅服务机可移除条目
    this.registryFile = registryFile || null;
    this.registry = new Map(); // deviceId -> { deviceId, name, lastSeen }
    if (this.registryFile) {
      try {
        const arr = JSON.parse(fs.readFileSync(this.registryFile, 'utf8'));
        if (Array.isArray(arr)) {
          arr.forEach(v => {
            if (v && v.deviceId) {
              this.registry.set(v.deviceId, { deviceId: v.deviceId, name: String(v.name || '设备'), lastSeen: v.lastSeen || 0 });
            }
          });
        }
      } catch {
        // 忽略
      }
    }
  }

  _saveRegistry() {
    if (!this.registryFile) return;
    try {
      fs.writeFileSync(this.registryFile, JSON.stringify([...this.registry.values()]));
    } catch {
      // 忽略写盘失败
    }
  }

  // 注册/更新注册表条目（命名完成的设备才入表）
  _registerDevice(deviceId, name) {
    if (!deviceId) return;
    const prev = this.registry.get(deviceId);
    this.registry.set(deviceId, { deviceId, name, lastSeen: Date.now() });
    if (!prev || prev.name !== name) this._saveRegistry();
  }

  _touchRegistry(deviceId) {
    const r = this.registry.get(deviceId);
    if (r) r.lastSeen = Date.now();
  }

  // 从注册表移除（仅服务机本机可调用）
  removeFromRegistry(names) {
    let changed = false;
    for (const n of names || []) {
      const clean = String(n || '').trim().slice(0, NAME_MAX);
      if (!clean) continue;
      for (const [id, r] of [...this.registry.entries()]) {
        // 名字精确或前缀匹配（兼容截断显示的名字）
        if (r.name === clean || r.name.indexOf(clean) === 0) {
          this.registry.delete(id);
          changed = true;
        }
      }
    }
    if (changed) this._saveRegistry();
    this.broadcast({ type: 'devices', devices: this.deviceList() });
    return changed;
  }

  _rememberHost(ip, deviceId, name) {
    if (!ip) return;
    this.knownHosts.set(ip, { deviceId, name, ts: Date.now() });
    if (this.knownHosts.size > HOSTS_MAX) {
      const sorted = [...this.knownHosts.entries()].sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
      for (let i = 0; i < sorted.length - HOSTS_MAX; i++) this.knownHosts.delete(sorted[i][0]);
    }
    if (this.hostsFile) {
      try {
        fs.writeFileSync(this.hostsFile, JSON.stringify([...this.knownHosts.entries()]));
      } catch {
        // 忽略写盘失败
      }
    }
  }

  attach(httpServer) {
    this.wss = new WebSocketServer({ server: httpServer, maxPayload: 1 * 1024 * 1024 });
    this.wss.on('connection', (ws, req) => {
      ws.isAlive = true;
      ws.authed = !this.pin;
      ws.deviceId = null;
      ws.hint = null;
      ws.helloDone = false;
      // 是否服务器本机（用于前端只对本机开放"清空文件"等管理入口）
      ws.isHost = isLoopbackIp(req && req.socket && req.socket.remoteAddress);
      ws.ip = normalizeIp(req && req.socket && req.socket.remoteAddress);
      ws.on('pong', () => {
        ws.isAlive = true;
      });
      ws.on('message', raw => this._onMessage(ws, raw));
      ws.on('close', () => this._onClose(ws));
      ws.on('error', () => {});
      if (this.pin) this._send(ws, { type: 'need-pin' });

      // 异步推测默认设备名；若 hello 已完成则单独推送提示
      lookupNameHint(normalizeIp(req && req.socket && req.socket.remoteAddress)).then(hint => {
        if (!hint || ws.readyState !== ws.OPEN) return;
        if (ws.helloDone) {
          this._send(ws, { type: 'name-hint', hint });
        } else {
          ws.hint = hint;
        }
      });
    });

    this._heartbeatTimer = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch {
          // 忽略
        }
      }
    }, 30000);
  }

  close() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    for (const d of this.devices.values()) {
      for (const conn of d.conns) {
        try {
          conn.close(1001);
        } catch {
          // 忽略
        }
      }
    }
  }

  _send(ws, obj) {
    this._sendRaw(ws, JSON.stringify(obj));
  }

  _sendRaw(ws, payload) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(payload);
      } catch {
        // 忽略
      }
    }
  }

  _onMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (!ws.authed) {
      if (msg.type === 'auth') {
        if (String(msg.pin) === this.pin) {
          ws.authed = true;
          this._send(ws, { type: 'pin-ok' });
        } else {
          this._send(ws, { type: 'pin-bad' });
        }
      }
      return;
    }

    switch (msg.type) {
      case 'hello':
        this._onHello(ws, msg);
        break;
      case 'text':
        this._onText(ws, msg);
        break;
      case 'recall':
        this._onRecall(ws, msg);
        break;
      case 'rename':
        this._onRename(ws, msg);
        break;
      default:
        break;
    }
  }

  _onHello(ws, msg) {
    let deviceId = String(msg.deviceId || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
    let name = String(msg.name || '').trim().slice(0, NAME_MAX);
    let adopted = false;

    if (!deviceId) {
      // 新浏览器/无痕/清缓存访问：按来源 IP 恢复之前的设备身份
      const prev = this.knownHosts.get(ws.ip);
      if (prev) {
        deviceId = prev.deviceId;
        name = prev.name;
        adopted = true;
      } else {
        deviceId = randId(12);
      }
    }
    if (!name) name = '设备-' + deviceId.slice(0, 4);

    // 引导中（还没通过命名校验）的设备不出现在设备列表，视为未加入
    const hidden = !!msg.pending && !adopted;

    // 同一设备的多个连接（多标签页）共用一个设备条目
    let d = this.devices.get(deviceId);
    if (d) {
      d.name = name;
      d.hidden = hidden;
      d.conns.add(ws);
    } else {
      d = { deviceId, name, conns: new Set([ws]), ts: Date.now(), hidden };
      this.devices.set(deviceId, d);
    }

    ws.deviceId = deviceId;
    ws.helloDone = true;
    this._rememberHost(ws.ip, deviceId, name);
    // 命名完成的设备才进入注册表（对外可见）；引导中的设备不可见
    if (!hidden) this._registerDevice(deviceId, name);
    else this._touchRegistry(deviceId);
    this._send(ws, {
      type: 'welcome',
      you: { deviceId, name },
      devices: this.deviceList(),
      history: this.historyFor(deviceId),
      hint: ws.hint,
      isHost: !!ws.isHost,
      adopted,
    });
    this.broadcast({ type: 'devices', devices: this.deviceList() });
  }

  _onRename(ws, msg) {
    const d = this.devices.get(ws.deviceId);
    if (!d) return;
    const name = String(msg.name || '').trim().slice(0, NAME_MAX);
    if (!name) return;
    d.name = name;
    // rename 意味着命名完成/更新：入注册表并正式可见
    if (d.hidden) d.hidden = false;
    this._registerDevice(d.deviceId, name);
    this._rememberHost(ws.ip, d.deviceId, name);
    this.broadcast({ type: 'devices', devices: this.deviceList() });
  }

  _onText(ws, msg) {
    const d = this.devices.get(ws.deviceId);
    if (!d) return;
    const text = String(msg.text || '').slice(0, TEXT_MAX);
    if (!text.trim()) return;
    // 定向发送永不静默降级为群发：目标离线时保留定向并进历史，对方上线后可见
    const to = msg.to && msg.to !== 'all' ? String(msg.to) : 'all';
    let quote = null;
    if (msg.quote && msg.quote.id) {
      quote = {
        id: String(msg.quote.id).slice(0, 64),
        fromName: String(msg.quote.fromName || '').slice(0, NAME_MAX),
        snippet: String(msg.quote.snippet || '').slice(0, 80),
      };
    }
    this.createMessage({ kind: 'text', from: d.deviceId, fromName: d.name, to, text, quote });
  }

  // 撤回：仅发送者本人、发出 2 分钟内可撤回
  _onRecall(ws, msg) {
    const d = this.devices.get(ws.deviceId);
    if (!d) return;
    const m = this.history.find(h => h.id === String(msg.id || ''));
    if (!m || m.recalled) return;
    if (m.from !== d.deviceId) return; // 只能撤回自己发的
    if (Date.now() - m.ts > RECALL_WINDOW) return; // 超时不可撤回
    m.recalled = true;
    const payload = JSON.stringify({ type: 'msg-recall', id: m.id, byName: d.name });
    // 按原消息的路由范围通知（群发→所有人，定向→发送者与目标）
    for (const dev of this.devices.values()) {
      if (m.to !== 'all' && m.to !== dev.deviceId && m.from !== dev.deviceId) continue;
      for (const conn of dev.conns) this._sendRaw(conn, payload);
    }
  }

  // 供 REST API（脚本/CI）直接构造消息
  createMessage({ kind, from, fromName, to, text, file, quote }) {
    const msg = {
      id: randId(12),
      kind,
      from: from || 'api',
      fromName: String(fromName || '脚本').slice(0, NAME_MAX),
      to: to === 'all' ? 'all' : String(to),
      ts: Date.now(),
      text,
      file,
      quote: quote || undefined,
    };
    // API/脚本发送者登记进注册表：接收方的会话列表才能看到这个会话（含未读角标）
    if (msg.from && !this.registry.has(msg.from)) {
      this._registerDevice(msg.from, msg.fromName);
    }
    this.history.push(msg);
    if (this.history.length > HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - HISTORY_LIMIT);
    }
    this.route(msg);
    return msg;
  }

  // 定向消息只发给目标与发送者；群发发给所有人
  route(msg) {
    const payload = JSON.stringify({ type: 'msg', msg });
    for (const d of this.devices.values()) {
      if (msg.to !== 'all' && msg.to !== d.deviceId && msg.from !== d.deviceId) continue;
      for (const conn of d.conns) this._sendRaw(conn, payload);
    }
  }

  _onClose(ws) {
    if (!ws.deviceId) return;
    const d = this.devices.get(ws.deviceId);
    if (!d || !d.conns.delete(ws)) return;
    if (d.conns.size === 0) this.devices.delete(ws.deviceId);
    this.broadcast({ type: 'devices', devices: this.deviceList() });
  }

  broadcast(obj) {
    const payload = JSON.stringify(obj);
    for (const d of this.devices.values()) {
      for (const conn of d.conns) this._sendRaw(conn, payload);
    }
  }

  deviceList() {
    // 单一事实来源：注册表（全部见过的设备）+ 在线状态。
    // 在线设备优先；与在线设备同名的旧分身（换浏览器产生的重复身份）不展示。
    const out = [];
    const onlineNames = {};
    const online = [...this.devices.values()].filter(d => !d.hidden);
    for (const d of online) {
      out.push({ deviceId: d.deviceId, name: d.name, online: true, ts: d.ts });
      onlineNames[d.name] = true;
    }
    const offline = [];
    for (const r of this.registry.values()) {
      const d = this.devices.get(r.deviceId);
      if (d && !d.hidden) continue; // 已按在线条目输出
      if (onlineNames[r.name]) continue; // 同名在线设备已存在，跳过旧分身
      offline.push({ deviceId: r.deviceId, name: r.name, online: false, ts: r.lastSeen });
    }
    out.push(...offline);
    out.sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return (b.ts || 0) - (a.ts || 0);
    });
    return out.map(d => ({ deviceId: d.deviceId, name: d.name, online: d.online }));
  }

  historyFor(deviceId) {
    return this.history.filter(m => m.to === 'all' || m.to === deviceId || m.from === deviceId);
  }
}

module.exports = { Hub };
