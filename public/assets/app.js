/* LAN Share 前端逻辑：无构建、无框架，原生 JS */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };

  // ---------- 本机身份 ----------
  // ?id= 可覆盖设备身份（仅当前标签页会话生效），用于同浏览器模拟多设备等场景。
  // 本地无 id 时不自造：交给服务端按来源 IP 恢复或分配，welcome 后再落盘。
  var urlId = (new URLSearchParams(location.search).get('id') || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
  var deviceId = urlId || localStorage.getItem('lanshare.id') || '';

  // URL ?name= 优先（测试机可用带名字的快捷方式），其次用户手动改过的名字，再次自动识别的名字
  var urlName = new URLSearchParams(location.search).get('name');
  var hasCustomName = !!localStorage.getItem('lanshare.name');
  var myName = (urlName || localStorage.getItem('lanshare.name') || localStorage.getItem('lanshare.autoname') || '').trim().slice(0, 30);
  if (urlName) {
    myName = urlName.trim().slice(0, 30) || myName;
    localStorage.setItem('lanshare.name', myName);
    hasCustomName = true;
  }
  if (!myName) myName = osTag() + (deviceId ? '·' + deviceId.slice(0, 4) : '');

  // 按浏览器 UA 识别系统类型，作为设备名兜底前缀
  function osTag() {
    var ua = navigator.userAgent;
    if (/Windows/i.test(ua)) return 'Windows';
    if (/Android/i.test(ua)) return 'Android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
    if (/Mac OS/i.test(ua)) return 'Mac';
    if (/Linux/i.test(ua)) return 'Linux';
    return '设备';
  }

  // 应用服务端推测的默认名（本机主机名 / 内网主机名）；用户手动命名后不再覆盖
  function applyAutoName(hint) {
    hint = String(hint || '').trim().slice(0, 30);
    if (!hint) return;
    // 命名弹窗开着时，只更新输入框预填（用户没动手改过的话），并重新校验
    if (!els.nameModal.classList.contains('hidden')) {
      if (!nameTouched && hint !== els.nameInput.value) {
        els.nameInput.value = hint;
        validateNameInput();
      }
      return;
    }
    if (hasCustomName || hint === myName) return;
    myName = hint;
    localStorage.setItem('lanshare.autoname', hint);
    renderMe();
    if (state.connected) send({ type: 'rename', name: hint });
  }

  // ---------- 首次使用引导（简介 + 命名） ----------
  var nameTouched = false;

  // 名称是否与其他设备（注册表内的在线/离线设备）重复
  function nameTaken(name) {
    var n = name.toLowerCase();
    var hit = function (d) { return d.deviceId !== deviceId && (d.name || '').toLowerCase() === n; };
    return state.devices.some(hit);
  }

  // 校验输入：空、重名都不允许提交
  function validateNameInput() {
    var v = els.nameInput.value.trim();
    var err = '';
    if (!v) err = '请输入设备名称';
    else if (nameTaken(v)) err = '该名称已被其他设备使用，请换一个';
    els.nameError.textContent = err;
    els.nameSubmit.disabled = !!err;
    return !err;
  }

  function showNameModal() {
    if (hasCustomName || !els.nameModal.classList.contains('hidden')) return;
    nameTouched = false;
    els.nameInput.value = myName;
    validateNameInput();
    els.nameModal.classList.remove('hidden');
    setTimeout(function () {
      els.nameInput.focus();
      els.nameInput.select();
    }, 50);
  }

  function submitName() {
    if (!validateNameInput()) return;
    var name = els.nameInput.value.trim().slice(0, 30);
    if (!name) return;
    myName = name;
    hasCustomName = true;
    localStorage.setItem('lanshare.name', name);
    els.nameModal.classList.add('hidden');
    renderMe();
    if (state.connected) send({ type: 'rename', name: name });
    toast('设备名已设置为 ' + name);
  }

  var state = {
    ws: null,
    connected: false,
    authed: false,
    target: 'all', // 当前会话：'all'=所有人（广播），否则为对方 deviceId
    devices: [],
    autoDl: localStorage.getItem('lanshare.autodl') === '1',
    msgs: [],      // 本地持有的消息（全部广播 + 与我的私聊双向）
    unread: {},    // 会话 id -> 未读条数
    isHost: false, // 是否服务器本机（决定是否显示移除/清空等管理入口）
    drafts: {},    // 会话 id -> 未发送草稿
    quoting: null, // 当前引用回复的原消息 {id, fromName, snippet}
    newMsgCount: 0, // 当前会话滚动离开底部时的新消息数
    _lastTs: 0,    // 当前视图最后一条消息时间（用于时间分隔线）
  };
  try {
    var drafts = JSON.parse(localStorage.getItem('lanshare.drafts') || '{}');
    if (drafts && typeof drafts === 'object') state.drafts = drafts;
  } catch (err) {
    state.drafts = {};
  }

  // ---------- DOM ----------
  var els = {
    myName: $('#myName'), myAvatar: $('#myAvatar'), meBox: $('#meBox'),
    meStatus: $('#meStatus'), meEditBtn: $('#meEditBtn'),
    meEdit: $('#meEdit'), meEditInput: $('#meEditInput'),
    meEditSave: $('#meEditSave'), meEditCancel: $('#meEditCancel'), meEditError: $('#meEditError'),
    deviceList: $('#deviceList'), rowAll: $('#rowAll'),
    autoDl: $('#autoDl'), clearFiles: $('#clearFiles'), storageInfo: $('#storageInfo'),
    connState: $('#connState'), connDot: null,
    targetLabel: $('#targetLabel'),
    messages: $('#messages'), emptyHint: $('#emptyHint'),
    input: $('#input'), sendBtn: $('#sendBtn'), attachBtn: $('#attachBtn'), fileInput: $('#fileInput'),
    pending: $('#pending'), offlineNotice: $('#offlineNotice'),
    attachHint: $('#attachHint'), attachHintText: $('#attachHintText'), attachHintClose: $('#attachHintClose'),
    saveLocation: $('#saveLocation'),
    newMsgBtn: $('#newMsgBtn'),
    quoteBar: $('#quoteBar'), quoteText: $('#quoteText'), quoteCancel: $('#quoteCancel'),
    inviteBtn: $('#inviteBtn'), inviteModal: $('#inviteModal'), inviteQrImg: $('#inviteQrImg'),
    inviteUrl: $('#inviteUrl'), inviteCopyUrl: $('#inviteCopyUrl'),
    inviteText: $('#inviteText'), inviteCopyText: $('#inviteCopyText'),
    inviteNotes: $('#inviteNotes'), inviteClose: $('#inviteClose'),
    saveLocationValue: $('#saveLocationValue'),
    menuBtn: $('#menuBtn'), sidebarBackdrop: $('#sidebarBackdrop'),
    sidebar: document.querySelector('.sidebar'),
    dropOverlay: $('#dropOverlay'), dropTargetName: $('#dropTargetName'),
    pinModal: $('#pinModal'), pinInput: $('#pinInput'), pinSubmit: $('#pinSubmit'), pinError: $('#pinError'),
    nameModal: $('#nameModal'), nameInput: $('#nameInput'), nameSubmit: $('#nameSubmit'), nameError: $('#nameError'),
    toast: $('#toast'),
  };

  // ---------- 小工具 ----------
  function toast(text) {
    els.toast.textContent = text;
    els.toast.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { els.toast.classList.add('hidden'); }, 2200);
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // 时间分隔线文案：今天只显示时分，昨天/更早带日期（微信风格）
  function fmtDivider(ts) {
    var d = new Date(ts);
    var now = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ts >= todayStart) return hm;
    if (ts >= todayStart - 86400000) return '昨天 ' + hm;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  }

  function nearBottom() {
    return els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 80;
  }

  // 标签页标题未读总数，如 "(3) LAN Share · 名称"
  function updateTitle() {
    var total = 0;
    Object.keys(state.unread).forEach(function (k) { total += state.unread[k] || 0; });
    document.title = (total > 0 ? '(' + total + ') ' : '') + 'LAN Share · ' + myName;
  }

  function fmtSize(n) {
    if (!Number.isFinite(n)) return '?';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 || n >= 100 ? n.toFixed(0) : n.toFixed(1)) + ' ' + units[i];
  }

  // 设备最后已知名字缓存：设备离线后（列表已移除）仍能显示其名字
  var nameCache = {};

  function deviceName(id) {
    if (id === 'all') return '所有人';
    for (var i = 0; i < state.devices.length; i++) {
      if (state.devices[i].deviceId === id) {
        nameCache[id] = state.devices[i].name;
        return state.devices[i].name;
      }
    }
    return nameCache[id] || '对方';
  }

  function escapelessNode(tag, text) {
    var el = document.createElement(tag);
    el.textContent = text;
    return el;
  }

  function scrollBottom() {
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  // ---------- WebSocket ----------
  var retryDelay = 1000;
  var RECALL_MS = 2 * 60 * 1000; // 消息发出后 2 分钟内可撤回

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var ws = new WebSocket(proto + location.host);
    state.ws = ws;

    ws.onopen = function () {
      retryDelay = 1000;
      if (!state.pinRequired || state.authed) hello();
      setConn(true);
    };
    ws.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      handle(msg);
    };
    ws.onclose = function () {
      setConn(false);
      if (state.pinRequired && !state.authed) return; // 等 PIN，不重连
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 5000);
    };
    ws.onerror = function () { /* onclose 会跟进 */ };
  }

  function hello() {
    // pending=true：还没通过命名校验的设备，服务端会在设备列表中隐藏它
    send({ type: 'hello', deviceId: deviceId || undefined, name: myName, pending: !hasCustomName });
  }

  function send(obj) {
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify(obj));
      return true;
    }
    toast('未连接到服务器');
    return false;
  }

  function setConn(on) {
    state.connected = on;
    els.connState.innerHTML = on
      ? '<i class="dot on"></i>已连接'
      : '<i class="dot off"></i>已断开，重连中…';
    renderMe();
    updateComposerState();
  }

  function handle(msg) {
    switch (msg.type) {
      case 'need-pin':
        state.pinRequired = true;
        var saved = sessionStorage.getItem('lanshare.pin');
        if (saved) { send({ type: 'auth', pin: saved }); }
        else { els.pinModal.classList.remove('hidden'); els.pinInput.focus(); }
        break;
      case 'pin-ok':
        state.authed = true;
        sessionStorage.setItem('lanshare.pin', els.pinInput.value.trim() || sessionStorage.getItem('lanshare.pin'));
        els.pinModal.classList.add('hidden');
        hello();
        break;
      case 'pin-bad':
        sessionStorage.removeItem('lanshare.pin');
        els.pinError.textContent = 'PIN 不正确，请重试';
        els.pinModal.classList.remove('hidden');
        break;
      case 'welcome':
        // 服务端确认的设备身份落地本地（首次/换浏览器后由服务端按 IP 恢复或分配）
        if (msg.you.deviceId && msg.you.deviceId !== deviceId) {
          deviceId = msg.you.deviceId;
          localStorage.setItem('lanshare.id', deviceId);
        }
        myName = msg.you.name;
        if (msg.adopted) {
          // 服务端按 IP 恢复了旧身份，视为已命名设备，不再弹引导
          hasCustomName = true;
          localStorage.setItem('lanshare.name', myName);
        }
        renderMe();
        state.isHost = !!msg.isHost;
        state.devices = msg.devices || [];
        state.msgs = msg.history || [];
        // "清空服务器文件"是管理操作，只对服务器本机开放
        els.clearFiles.classList.toggle('hidden', !msg.isHost);
        renderConversations();
        renderStream();
        // 首次使用且未设置过名字：强制命名后才能使用（hint 只用来预填输入框）
        showNameModal();
        if (msg.hint) applyAutoName(msg.hint);
        break;
      case 'name-hint':
        applyAutoName(msg.hint);
        break;
      case 'devices':
        state.devices = msg.devices || [];
        // 当前会话被移除时切回"所有人"
        if (state.target !== 'all' && !state.devices.some(function (d) { return d.deviceId === state.target; })) {
          state.target = 'all';
          clearQuoting();
          renderStream();
        }
        renderConversations();
        break;
      case 'msg':
        receiveMessage(msg.msg);
        break;
      case 'msg-recall':
        // 对方/自己撤回消息：更新本地记录并重绘当前会话（保持滚动位置）
        for (var ri = 0; ri < state.msgs.length; ri++) {
          if (state.msgs[ri].id === msg.id) {
            state.msgs[ri].recalled = true;
            break;
          }
        }
        var keepScrollPos = els.messages.scrollTop;
        renderStream();
        if (keepScrollPos > 0) els.messages.scrollTop = keepScrollPos;
        break;
    }
  }

  // ---------- 渲染：自己 / 设备列表 ----------
  function renderMe() {
    els.myName.textContent = myName;
    els.myAvatar.textContent = myName.slice(0, 1).toUpperCase();
    els.meStatus.classList.toggle('offline', !state.connected);
    els.meStatus.innerHTML = state.connected
      ? '<i class="dot on"></i>我的设备 · 在线'
      : '<i class="dot off"></i>我的设备 · 离线';
    updateTitle();
  }

  // 会话草稿：切换会话时保留未发送的内容（微信风格），列表显示"草稿"标记
  function persistDrafts() {
    try {
      localStorage.setItem('lanshare.drafts', JSON.stringify(state.drafts));
    } catch (err) {
      // 忽略
    }
  }

  function saveDraft(convId) {
    var v = els.input.value;
    if (v) state.drafts[convId] = v;
    else delete state.drafts[convId];
    persistDrafts();
  }

  function restoreDraft(convId) {
    els.input.value = state.drafts[convId] || '';
    autosize();
  }

  function setDraftMark(rowEl, show) {
    var old = rowEl.querySelector('.draft-mark');
    if (old) old.remove();
    if (!show) return;
    var mark = document.createElement('span');
    mark.className = 'draft-mark';
    mark.textContent = '草稿';
    rowEl.appendChild(mark);
  }

  // 切换会话：存草稿、清未读、取消引用、恢复目标会话草稿
  function switchConversation(id) {
    if (state.target !== id) saveDraft(state.target);
    state.target = id;
    state.unread[id] = 0;
    updateTitle();
    clearQuoting();
    renderConversations();
    restoreDraft(id);
    renderStream();
    closeSidebar(); // 移动端选完会话自动收起抽屉
  }

  // ---------- 移动端会话抽屉 ----------
  function openSidebar() {
    els.sidebar.classList.add('open');
    els.sidebarBackdrop.classList.add('show');
  }
  function closeSidebar() {
    els.sidebar.classList.remove('open');
    els.sidebarBackdrop.classList.remove('show');
  }
  els.menuBtn.addEventListener('click', function () {
    if (els.sidebar.classList.contains('open')) closeSidebar();
    else openSidebar();
  });
  els.sidebarBackdrop.addEventListener('click', closeSidebar);

  // ---------- 会话列表（侧栏） ----------
  // 列表来自服务端设备注册表（单一事实来源，所有人一致）：
  // 在线设备 + 见过但当前离线的设备（标"未连接"），自己的设备不在其中
  function conversationRows() {
    return state.devices
      .filter(function (d) { return d.deviceId !== deviceId; })
      .map(function (d) { return { id: d.deviceId, name: d.name, online: !!d.online }; });
  }

  function setUnreadBadge(rowEl, count) {
    var old = rowEl.querySelector('.unread-badge');
    if (old) old.remove();
    if (!count) return;
    var badge = document.createElement('span');
    badge.className = 'unread-badge';
    badge.textContent = count > 99 ? '99+' : String(count);
    rowEl.appendChild(badge);
  }

  function renderConversations() {
    els.targetLabel.textContent = deviceName(state.target);
    els.dropTargetName.textContent = deviceName(state.target);

    // 当前会话对方刚离线时提示一次（会话保留，可看历史，发送会被拦截）
    if (state.target !== 'all' && !state.devices.some(function (d) { return d.deviceId === state.target; })) {
      if (!state._targetOfflineWarned) {
        state._targetOfflineWarned = true;
        toast('「' + deviceName(state.target) + '」当前不在线，可查看历史，发送将被拦截');
      }
    } else {
      state._targetOfflineWarned = false;
    }

    els.deviceList.querySelectorAll('.device-row:not(#rowAll)').forEach(function (n) { n.remove(); });
    conversationRows().forEach(function (c) {
      var row = document.createElement('div');
      row.className = 'device-row' + (state.target === c.id ? ' active' : '') + (c.online ? '' : ' offline');
      row.dataset.id = c.id;

      var av = document.createElement('div');
      av.className = 'avatar';
      av.textContent = (c.name || '?').slice(0, 1).toUpperCase();

      var name = document.createElement('div');
      name.className = 'device-name';
      name.textContent = c.name;
      name.title = c.name;

      var tag = document.createElement('span');
      tag.className = 'status-tag ' + (c.online ? 'on' : 'off');
      tag.textContent = c.online ? '在线' : '未连接';

      row.appendChild(av);
      row.appendChild(name);
      row.appendChild(tag);
      setUnreadBadge(row, state.unread[c.id] || 0);
      setDraftMark(row, !!state.drafts[c.id]);
      // 离线会话仅服务器本机可移除（悬停出现 ✕，走服务端注册表删除并广播）
      if (!c.online && state.isHost) {
        var del = document.createElement('button');
        del.className = 'conv-del';
        del.textContent = '✕';
        del.title = '从设备列表移除（所有设备同步）';
        del.addEventListener('click', function (e) {
          e.stopPropagation();
          var headers = { 'Content-Type': 'application/json' };
          var pin = sessionStorage.getItem('lanshare.pin');
          if (pin) headers['x-pin'] = pin;
          fetch('/api/devices/purge', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({ names: [c.name] }),
          })
            .then(function (r) {
              return r.json().then(function (d) { return { status: r.status, d: d }; });
            })
            .then(function (res) {
              if (res.status >= 300 || !res.d.ok) {
                toast(res.d.error || '移除失败');
                return;
              }
              // devices 广播会带回新列表；这里先处理当前会话
              if (state.target === c.id) {
                state.target = 'all';
                clearQuoting();
                renderStream();
              }
              toast('已移除「' + c.name + '」');
            })
            .catch(function () { toast('移除失败'); });
        });
        row.appendChild(del);
      }
      row.addEventListener('click', function () {
        switchConversation(c.id);
      });
      els.deviceList.appendChild(row);
    });
    els.rowAll.classList.toggle('active', state.target === 'all');
    setUnreadBadge(els.rowAll, state.unread.all || 0);
    setDraftMark(els.rowAll, !!state.drafts.all);
    updateComposerState();
  }

  // 当前会话对方未连接时直接禁用输入区，避免打完字才发现发不出
  function updateComposerState() {
    var offline = state.target !== 'all' && !targetOnline();
    els.input.disabled = offline;
    els.attachBtn.disabled = offline;
    els.sendBtn.disabled = offline || !state.connected;
    els.input.placeholder = offline
      ? '对方未连接，不能发送'
      : '输入消息，回车发送（Shift+回车换行）；可直接粘贴截图';
    if (offline) {
      els.offlineNotice.textContent = '⚠️ 「' + deviceName(state.target) + '」未连接，暂不能发送新消息，可查看历史记录';
      els.offlineNotice.classList.remove('hidden');
    } else {
      els.offlineNotice.classList.add('hidden');
    }
  }

  // ---------- 消息（会话制） ----------
  // 一条消息属于哪个会话：广播 → 'all'；私聊 → 对方 deviceId
  function conversationOf(m) {
    if (m.to === 'all') return 'all';
    return m.from === deviceId ? m.to : m.from;
  }

  function msgBelongsToView(m) {
    return conversationOf(m) === state.target;
  }

  function receiveMessage(m) {
    state.msgs.push(m);

    // 自动下载：定向发给我、非自己发的文件（无论当前在哪个会话）
    if (state.autoDl && m.kind === 'file' && m.file && m.to === deviceId && m.from !== deviceId) {
      autoSaveFile(m.file);
    }

    if (msgBelongsToView(m)) {
      var wasNear = nearBottom();
      appendMessage(m);
      // 滚动离开底部时来了别人的新消息：不强制滚动，显示悬浮按钮
      if (!wasNear && m.from !== deviceId) {
        state.newMsgCount++;
        showNewMsgBtn();
      }
    } else {
      var conv = conversationOf(m);
      state.unread[conv] = (state.unread[conv] || 0) + 1;
      updateTitle();
      renderConversations();
    }
  }

  // 按当前会话过滤重绘整个消息区
  function renderStream() {
    els.messages.innerHTML = '';
    els.messages.appendChild(els.emptyHint); // 复用提示节点
    state._lastTs = 0;
    var list = state.msgs.filter(msgBelongsToView);
    if (!list.length) {
      els.emptyHint.classList.remove('hidden');
      els.emptyHint.firstChild.nodeValue = state.target === 'all'
        ? '暂无消息'
        : '和 ' + deviceName(state.target) + ' 暂无消息';
      return;
    }
    els.emptyHint.classList.add('hidden');
    list.forEach(function (m) { appendMessage(m, true); });
    scrollBottom();
    hideNewMsgBtn();
  }

  function snippetOf(m) {
    if (m.kind === 'text') return String(m.text || '').replace(/\s+/g, ' ').slice(0, 60);
    if (m.file) return '[文件] ' + m.file.name;
    return '';
  }

  function setQuoting(m) {
    state.quoting = { id: m.id, fromName: m.from === deviceId ? '我' : m.fromName, snippet: snippetOf(m) };
    els.quoteText.textContent = '↩ ' + state.quoting.fromName + '：' + state.quoting.snippet;
    els.quoteBar.classList.remove('hidden');
    els.input.focus();
  }

  function clearQuoting() {
    state.quoting = null;
    els.quoteBar.classList.add('hidden');
  }

  // 图片灯箱：页内放大预览
  function openLightbox(file) {
    var lb = document.createElement('div');
    lb.className = 'lightbox';
    var img = document.createElement('img');
    img.src = '/files/' + file.id + '?inline=1';
    var actions = document.createElement('div');
    actions.className = 'lb-actions';
    var dl = document.createElement('button');
    dl.textContent = '下载';
    dl.addEventListener('click', function () { downloadFile(file); });
    var close = document.createElement('button');
    close.textContent = '关闭';
    close.addEventListener('click', function () { lb.remove(); });
    actions.appendChild(dl);
    actions.appendChild(close);
    lb.appendChild(img);
    lb.appendChild(actions);
    lb.addEventListener('click', function (e) {
      if (e.target === lb) lb.remove();
    });
    document.body.appendChild(lb);
  }

  function hideNewMsgBtn() {
    state.newMsgCount = 0;
    els.newMsgBtn.classList.add('hidden');
  }

  function showNewMsgBtn() {
    els.newMsgBtn.textContent = '↓ 新消息' + (state.newMsgCount > 1 ? ' (' + state.newMsgCount + ')' : '');
    els.newMsgBtn.classList.remove('hidden');
  }

  // 只负责往消息区追加一条消息的 DOM
  function appendMessage(m, keepScroll) {
    els.emptyHint.classList.add('hidden');

    // 时间分隔线：首条或与上一条间隔超过 5 分钟时显示（微信风格）
    if (!state._lastTs || m.ts - state._lastTs > 5 * 60 * 1000) {
      var divider = document.createElement('div');
      divider.className = 'time-divider';
      divider.textContent = fmtDivider(m.ts);
      els.messages.appendChild(divider);
    }
    state._lastTs = m.ts;

    // 智能滚动：自己发的总是滚到底；别人的消息只在原本就在底部时跟随
    var shouldScroll = !keepScroll && (m.from === deviceId || nearBottom());

    var row = document.createElement('div');
    row.className = 'msg-row' + (m.from === deviceId ? ' mine' : '');

    var meta = escapelessNode('div', '');
    meta.className = 'msg-meta';
    meta.textContent = (m.from === deviceId ? '我' : m.fromName) + ' · ' + fmtTime(m.ts);

    row.appendChild(meta);

    // 引用回复条
    if (m.quote && m.quote.id) {
      var qb = document.createElement('div');
      qb.className = 'quote-bar';
      qb.textContent = '↩ ' + (m.quote.fromName || '?') + '：' + (m.quote.snippet || '');
      row.appendChild(qb);
    }

    // 已撤回：只显示提示文字
    if (m.recalled) {
      var rb = document.createElement('div');
      rb.className = 'bubble recalled';
      rb.textContent = (m.from === deviceId ? '你' : m.fromName) + ' 撤回了一条消息';
      row.appendChild(rb);
      els.messages.appendChild(row);
      if (shouldScroll) { scrollBottom(); hideNewMsgBtn(); }
      return;
    }

    var textBubble = null;
    if (m.kind === 'text') {
      var bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = m.text;
      row.appendChild(bubble);
      textBubble = bubble;
    } else if (m.kind === 'file' && m.file) {
      var isImage = (m.file.mime || '').indexOf('image/') === 0;
      if (isImage) {
        var bubble2 = document.createElement('div');
        bubble2.className = 'bubble';
        var img = document.createElement('img');
        img.className = 'pic';
        img.src = '/files/' + m.file.id + '?inline=1';
        img.alt = m.file.name;
        img.addEventListener('click', function () {
          openLightbox(m.file);
        });
        img.addEventListener('error', function () {
          var note = escapelessNode('div', '');
          note.className = 'file-name';
          note.textContent = '🖼 ' + m.file.name + '（文件已被清理）';
          img.replaceWith(note);
        });
        bubble2.appendChild(img);
        row.appendChild(bubble2);
      } else {
        row.appendChild(buildFileCard(m.file));
      }
    }

    // 操作按钮：文本可复制；任何消息可引用；自己发的限时可撤回
    var wantsCopy = m.kind === 'text';
    var recallLeft = m.from === deviceId ? RECALL_MS - (Date.now() - m.ts) : -1;
    {
      var actions = document.createElement('div');
      actions.className = 'msg-actions';
      if (wantsCopy) {
        var copy = document.createElement('button');
        copy.className = 'msg-copy';
        copy.textContent = '复制';
        copy.addEventListener('click', function () {
          copyText(m.text, copy);
        });
        actions.appendChild(copy);
      }
      var quoteBtn = document.createElement('button');
      quoteBtn.className = 'msg-copy';
      quoteBtn.textContent = '引用';
      quoteBtn.addEventListener('click', function () {
        setQuoting(m);
      });
      actions.appendChild(quoteBtn);
      if (recallLeft > 0) {
        var recallBtn = document.createElement('button');
        recallBtn.className = 'msg-copy msg-recall';
        recallBtn.textContent = '撤回';
        recallBtn.addEventListener('click', function () {
          if (send({ type: 'recall', id: m.id })) {
            recallBtn.textContent = '撤回中…';
            recallBtn.disabled = true;
          }
        });
        // 超过 2 分钟自动隐藏撤回按钮
        setTimeout(function () { recallBtn.remove(); }, recallLeft);
        actions.appendChild(recallBtn);
      }
      row.appendChild(actions);
    }

    els.messages.appendChild(row);

    // 长文本：超出最大高度自动折叠，手动展开/收起（需在插入 DOM 后测量）
    if (textBubble && textBubble.scrollHeight > 340) {
      textBubble.classList.add('collapsible');
      var toggle = document.createElement('button');
      toggle.className = 'bubble-toggle';
      toggle.textContent = '展开全文 ▾';
      toggle.addEventListener('click', function () {
        var expanded = textBubble.classList.toggle('expanded');
        toggle.textContent = expanded ? '收起 ▴' : '展开全文 ▾';
      });
      textBubble.appendChild(toggle);
    }

    if (shouldScroll) { scrollBottom(); hideNewMsgBtn(); }
  }

  function buildFileCard(file) {
    var card = document.createElement('div');
    card.className = 'file-card';

    var icon = document.createElement('div');
    icon.className = 'file-icon';
    icon.textContent = '📄';

    var info = document.createElement('div');
    info.className = 'file-info';
    var fn = escapelessNode('div', file.name);
    fn.className = 'file-name';
    var fs = escapelessNode('div', fmtSize(file.size));
    fs.className = 'file-size';
    info.appendChild(fn);
    info.appendChild(fs);

    var dl = document.createElement('a');
    dl.className = 'file-dl';
    dl.textContent = '下载';
    dl.href = 'javascript:void(0)';
    dl.addEventListener('click', function (e) {
      e.preventDefault();
      downloadFile(file, false);
    });

    card.appendChild(icon);
    card.appendChild(info);
    card.appendChild(dl);
    return card;
  }

  function downloadFile(file, auto) {
    fetch('/files/' + file.id)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      })
      .catch(function () {
        toast('下载失败: ' + file.name + '（文件可能已被清理）');
      });
  }

  // ---------- 自动下载的保存位置 ----------
  // 优先用 File System Access API 让用户选择文件夹（Chrome/Edge 支持，可记住授权）；
  // 不支持或未选择时，落到浏览器默认下载目录并明确告知。
  var saveDir = null; // FileSystemDirectoryHandle

  function idbOpen() {
    return new Promise(function (resolve, reject) {
      var r = indexedDB.open('lanshare', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  function idbSet(k, v) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(v, k);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  function idbGet(k) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('kv', 'readonly');
        var q = tx.objectStore('kv').get(k);
        q.onsuccess = function () { resolve(q.result); };
        q.onerror = function () { reject(q.error); };
      });
    });
  }

  function updateSaveLocationUI(needsAuth) {
    if (!els.saveLocation || !els.saveLocationValue) return;
    if (saveDir) {
      els.saveLocationValue.textContent = saveDir.name + (needsAuth ? '·需授权' : '');
      els.saveLocation.title = '自动下载保存到文件夹「' + saveDir.name + '」，点击重新选择';
    } else {
      els.saveLocationValue.textContent = '浏览器默认';
      els.saveLocation.title = window.showDirectoryPicker
        ? '当前保存到浏览器默认下载目录，点击选择文件夹'
        : '当前浏览器不支持选择文件夹，保存到默认下载目录';
    }
  }

  function pickSaveDir() {
    if (!window.showDirectoryPicker) {
      toast('当前浏览器不支持选择文件夹，文件将保存到浏览器默认下载目录');
      return;
    }
    window.showDirectoryPicker({ mode: 'readwrite' })
      .then(function (h) {
        saveDir = h;
        return idbSet('saveDir', h);
      })
      .then(function () {
        updateSaveLocationUI();
        toast('自动下载将保存到「' + saveDir.name + '」文件夹');
      })
      .catch(function () { /* 用户取消选择 */ });
  }

  function initSaveLocation() {
    if (!window.showDirectoryPicker) { updateSaveLocationUI(); return; }
    idbGet('saveDir')
      .then(function (h) {
        if (!h) return;
        saveDir = h;
        return h.queryPermission({ mode: 'readwrite' }).then(function (p) {
          updateSaveLocationUI(p !== 'granted');
        });
      })
      .catch(function () { updateSaveLocationUI(); });
  }

  function ensureDirPermission() {
    if (!saveDir) return Promise.resolve(false);
    return saveDir.queryPermission({ mode: 'readwrite' }).then(function (p) {
      if (p === 'granted') return true;
      return saveDir.requestPermission({ mode: 'readwrite' }).then(function (p2) {
        return p2 === 'granted';
      });
    }).catch(function () { return false; });
  }

  // 自动下载入口：优先写入所选文件夹，失败/未选则走浏览器下载
  function autoSaveFile(file) {
    ensureDirPermission().then(function (ok) {
      if (ok && saveDir) {
        return fetch('/files/' + file.id)
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.blob();
          })
          .then(function (blob) {
            return saveDir.getFileHandle(file.name, { create: true }).then(function (fh) {
              return fh.createWritable().then(function (w) {
                return w.write(blob).then(function () { return w.close(); });
              });
            });
          })
          .then(function () {
            toast('已自动保存到「' + saveDir.name + '」: ' + file.name);
          })
          .catch(function () {
            // 写入失败（如文件被占用），回退到浏览器下载
            downloadFile(file);
            toast('写入文件夹失败，已改存浏览器下载目录: ' + file.name);
          });
      }
      downloadFile(file);
      toast('已下载到浏览器下载目录: ' + file.name);
    });
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch (err) { /* 忽略 */ }
    ta.remove();
  }

  function copyText(text, btn) {
    var orig = btn ? btn.textContent : '';
    var done = function () {
      if (btn) {
        btn.textContent = '已复制 ✓';
        btn.classList.add('copied');
        setTimeout(function () {
          btn.textContent = orig;
          btn.classList.remove('copied');
        }, 1300);
      } else {
        toast('已复制');
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        legacyCopy(text);
        done();
      });
    } else {
      legacyCopy(text);
      done();
    }
  }

  // ---------- 发送：文本 ----------
  // 发送前校验：目标必须在线（或为群发），杜绝静默广播
  function targetOnline() {
    return state.target === 'all' || state.devices.some(function (d) { return d.deviceId === state.target; });
  }

  function sendText() {
    var text = els.input.value.trim();
    if (!text) return;
    if (!targetOnline()) {
      toast('目标设备「' + deviceName(state.target) + '」不在线，已取消发送');
      return;
    }
    var payload = { type: 'text', to: state.target, text: text };
    if (state.quoting) payload.quote = state.quoting;
    if (!send(payload)) return;
    els.input.value = '';
    autosize();
    delete state.drafts[state.target];
    persistDrafts();
    clearQuoting();
  }

  // ---------- 发送：文件 ----------
  function uploadFiles(files) {
    if (state.target !== 'all' && !targetOnline()) {
      toast('目标设备「' + deviceName(state.target) + '」不在线，已取消发送');
      return;
    }
    for (var i = 0; i < files.length; i++) uploadOne(files[i]);
  }

  function uploadOne(file) {
    if (!targetOnline()) {
      toast('目标设备「' + deviceName(state.target) + '」不在线，已取消发送');
      return;
    }
    var item = addPending(file.name, file.size);
    var xhr = new XMLHttpRequest();
    var q = new URLSearchParams({
      name: file.name,
      to: state.target,
      from: deviceId,
      fromName: myName,
    });
    xhr.open('POST', '/api/files?' + q.toString());
    var pin = sessionStorage.getItem('lanshare.pin');
    if (pin) xhr.setRequestHeader('x-pin', pin);

    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable) item.progress(e.loaded / e.total);
    };
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        item.done();
      } else {
        var reason = '上传失败';
        try { reason = JSON.parse(xhr.responseText).error || reason; } catch (err) { /* 忽略 */ }
        item.fail(reason);
      }
    };
    xhr.onerror = function () { item.fail('网络错误'); };
    xhr.send(file);
  }

  function addPending(name, size) {
    var wrap = document.createElement('div');
    wrap.className = 'pending-item';

    var top = document.createElement('div');
    top.className = 'p-name';
    var left = escapelessNode('span', '📤 ' + name + ' (' + fmtSize(size) + ')');
    var right = escapelessNode('span', '0%');
    top.appendChild(left);
    top.appendChild(right);

    var bar = document.createElement('div');
    bar.className = 'progress';
    var fill = document.createElement('i');
    bar.appendChild(fill);

    wrap.appendChild(top);
    wrap.appendChild(bar);
    els.pending.appendChild(wrap);

    return {
      progress: function (p) {
        var pct = Math.round(p * 100);
        fill.style.width = pct + '%';
        right.textContent = pct + '%';
      },
      done: function () {
        fill.style.width = '100%';
        right.textContent = '完成 ✓';
        setTimeout(function () { wrap.remove(); }, 1200);
      },
      fail: function (reason) {
        wrap.classList.add('fail');
        right.textContent = '失败';
        toast(reason);
      },
    };
  }

  // ---------- 事件绑定 ----------
  els.sendBtn.addEventListener('click', sendText);

  els.input.addEventListener('keydown', function (e) {
    if (isComposing(e)) return; // 拼音选字的回车不发送
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendText();
    }
  });

  // 输入框自动增高
  function autosize() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 140) + 'px';
  }
  els.input.addEventListener('input', autosize);

  // 粘贴截图/文件
  els.input.addEventListener('paste', function (e) {
    var items = (e.clipboardData && e.clipboardData.items) || [];
    var files = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        var f = items[i].getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      uploadFiles(files);
    }
  });

    // 隐藏目录快捷键提示：每次点 📎 都显示，选择文件完成（或手动 ✕）后消失
    var isMacUser = /Mac/i.test(navigator.platform || navigator.userAgent);

    function showAttachHint() {
      els.attachHintText.textContent = isMacUser
        ? '💡 选择弹窗内按 ⌘⇧. 显示隐藏文件，按 ⌘⇧G 可直接输入路径（选择完成后此提示消失）'
        : '💡 选择弹窗内在文件名框直接输入完整路径即可进入隐藏目录（选择完成后此提示消失）';
      els.attachHint.classList.remove('hidden');
    }
    function hideAttachHint() {
      els.attachHint.classList.add('hidden');
    }

    els.attachBtn.addEventListener('click', function () {
      els.fileInput.click();
      showAttachHint();
    });
    els.attachHintClose.addEventListener('click', hideAttachHint);
    els.fileInput.addEventListener('change', function () {
      if (els.fileInput.files && els.fileInput.files.length) {
        hideAttachHint(); // 选择完成，提示消失
      }
      uploadFiles(els.fileInput.files);
      els.fileInput.value = '';
    });

  // 全页拖拽
  var dragDepth = 0;
  window.addEventListener('dragenter', function (e) {
    e.preventDefault();
    dragDepth++;
    els.dropOverlay.classList.add('show');
  });
  window.addEventListener('dragleave', function (e) {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) els.dropOverlay.classList.remove('show');
  });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) {
    e.preventDefault();
    dragDepth = 0;
    els.dropOverlay.classList.remove('show');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      uploadFiles(e.dataTransfer.files);
    }
  });

  // 会话切换：所有人
  els.rowAll.addEventListener('click', function () {
    switchConversation('all');
  });

  // 引用回复：取消引用
  els.quoteCancel.addEventListener('click', clearQuoting);

  // 新消息悬浮按钮：点击回到底部；手动滚到底部自动消失
  els.newMsgBtn.addEventListener('click', function () {
    scrollBottom();
    hideNewMsgBtn();
  });
  els.messages.addEventListener('scroll', function () {
    if (nearBottom()) hideNewMsgBtn();
  });

  // 关闭/刷新页面前保存当前输入框草稿
  window.addEventListener('beforeunload', function () {
    saveDraft(state.target);
  });

  // 改名：悬停卡片点 ✏️ 进入行内编辑（拦截空名/重名）
  function enterEditName() {
    els.meBox.classList.add('editing');
    els.meEditInput.value = myName;
    els.meEditError.textContent = '';
    els.meEditSave.disabled = false;
    setTimeout(function () {
      els.meEditInput.focus();
      els.meEditInput.select();
    }, 30);
  }
  function exitEditName() {
    els.meBox.classList.remove('editing');
  }
  function validateMeEdit() {
    var v = els.meEditInput.value.trim();
    var err = '';
    if (!v) err = '请输入设备名称';
    else if (nameTaken(v)) err = '该名称已被其他设备使用';
    els.meEditError.textContent = err;
    els.meEditSave.disabled = !!err;
    return !err && v;
  }
  function saveMeEdit() {
    if (!validateMeEdit()) return;
    var name = els.meEditInput.value.trim().slice(0, 30);
    myName = name;
    hasCustomName = true;
    localStorage.setItem('lanshare.name', name);
    renderMe();
    if (state.connected) send({ type: 'rename', name: name });
    exitEditName();
    toast('设备名已设置为 ' + name);
  }
  els.meEditBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    enterEditName();
  });
  els.meEditSave.addEventListener('click', saveMeEdit);
  els.meEditCancel.addEventListener('click', exitEditName);
  els.meEditInput.addEventListener('input', validateMeEdit);
  els.meEditInput.addEventListener('keydown', function (e) {
    if (isComposing(e)) return;
    if (e.key === 'Enter') saveMeEdit();
    if (e.key === 'Escape') exitEditName();
  });

  // 自动下载开关
  els.autoDl.checked = state.autoDl;
  els.autoDl.addEventListener('change', function () {
    state.autoDl = els.autoDl.checked;
    localStorage.setItem('lanshare.autodl', state.autoDl ? '1' : '0');
    if (state.autoDl) toast('已开启：定向发给我的文件将自动下载');
  });

  // 保存位置选择
  els.saveLocation.addEventListener('click', pickSaveDir);

  // ---------- 邀请伙伴 ----------
  function openInvite() {
    fetch('/api/invite')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        // 优先用当前访问地址（只要不是 localhost，别人就能直接访问）
        var host = location.hostname;
        var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
        var url = !isLocal ? location.protocol + '//' + location.host : (d.urls && d.urls[0]) || location.origin;
        var ssid = d.ssid || '';
        var pin = d.pin || '';

        els.inviteQrImg.src = '/api/qr.svg?u=' + encodeURIComponent(url);
        els.inviteUrl.value = url;

        var wifiLine = ssid
          ? '① 连接 Wi-Fi：' + ssid + '（必须和服务机同网段才能互通）'
          : '① 连接与服务机相同的局域网 Wi-Fi（同网段才能互通）';
        els.inviteText.value =
          '📡 LAN Share 局域网互传邀请\n' +
          wifiLine + '\n' +
          '② 电脑/手机浏览器打开：' + url + '（手机可直接扫二维码）\n' +
          '③ 首次打开给设备起个名字，即可互发文本/截图/文件，免安装免登录\n' +
          (pin ? '④ 访问 PIN 码：' + pin + '\n' : '') +
          '提示：页面打不开时，请确认连的是同一个 Wi-Fi（公司多个 Wi-Fi 之间可能不互通，切换后重试）';

        var lines = [
          '📡 二维码 / 链接指向服务机当前地址：' + url,
          ssid ? '📶 服务机当前 Wi-Fi：' + ssid + '，加入的设备需连同一 Wi-Fi 或互通网段' : '📶 服务机 Wi-Fi 未知，请让对方连接与服务机相同的网络',
          '🏢 公司有多个 Wi-Fi 时可能相互隔离：打不开页面就换到服务机所在的 Wi-Fi 重试',
          (d.urls && d.urls.length > 1 ? '🔌 服务机多网卡地址：' + d.urls.join('、') : ''),
          pin ? '🔒 已启用 PIN：' + pin : '',
          '🛡️ 打不开还可能是防火墙拦截了 ' + location.port + ' 端口',
        ];
        els.inviteNotes.innerHTML = '';
        lines.forEach(function (l) {
          if (!l) return;
          var div = document.createElement('div');
          div.textContent = l;
          els.inviteNotes.appendChild(div);
        });

        els.inviteModal.classList.remove('hidden');
        // 文案框按内容自动撑高（上限 300px，超出内部滚动）
        els.inviteText.style.height = 'auto';
        els.inviteText.style.height = Math.min(els.inviteText.scrollHeight + 2, 300) + 'px';
      })
      .catch(function () { toast('获取邀请信息失败'); });
  }

  els.inviteBtn.addEventListener('click', openInvite);
  els.inviteClose.addEventListener('click', function () {
    els.inviteModal.classList.add('hidden');
  });
  els.inviteModal.addEventListener('click', function (e) {
    if (e.target === els.inviteModal) els.inviteModal.classList.add('hidden');
  });
  els.inviteCopyUrl.addEventListener('click', function () {
    copyText(els.inviteUrl.value, els.inviteCopyUrl);
  });
  els.inviteCopyText.addEventListener('click', function () {
    copyText(els.inviteText.value, els.inviteCopyText);
  });

  // 清空服务器文件
  els.clearFiles.addEventListener('click', function () {
    if (!confirm('清空服务器上保存的所有文件？消息记录会保留（图片会失效）。')) return;
    var headers = {};
    var pin = sessionStorage.getItem('lanshare.pin');
    if (pin) headers['x-pin'] = pin;
    fetch('/api/files', { method: 'DELETE', headers: headers })
      .then(function (r) {
        return r.json().then(function (d) { return { status: r.status, d: d }; });
      })
      .then(function (res) {
        if (res.status >= 300 || !res.d.ok) {
          toast(res.d.error || '操作失败');
          return;
        }
        toast('已清空');
        refreshStorage();
      })
      .catch(function () { toast('操作失败'); });
  });

  // PIN 提交
  function submitPin() {
    var v = els.pinInput.value.trim();
    if (!v) return;
    sessionStorage.setItem('lanshare.pin', v);
    els.pinError.textContent = '';
    if (state.ws && state.ws.readyState === 1) send({ type: 'auth', pin: v });
    else location.reload();
  }
  els.pinSubmit.addEventListener('click', submitPin);
  els.pinInput.addEventListener('keydown', function (e) {
    if (isComposing(e)) return;
    if (e.key === 'Enter') submitPin();
  });

  // 强制命名弹窗的输入与提交
  // 输入法组合中的按键（如拼音选字的回车）不作为功能键处理
  function isComposing(e) {
    return e.isComposing || e.keyCode === 229;
  }

  els.nameInput.addEventListener('input', function () {
    nameTouched = true;
    validateNameInput();
  });
  els.nameInput.addEventListener('keydown', function (e) {
    if (isComposing(e)) return;
    if (e.key === 'Enter') submitName();
  });
  els.nameSubmit.addEventListener('click', submitName);

  // ---------- 存储信息轮询 ----------
  function refreshStorage() {
    fetch('/api/devices')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.files) {
          els.storageInfo.textContent = '服务器文件: ' + d.files.count + ' 个 / ' + fmtSize(d.files.totalSize);
        }
      })
      .catch(function () { /* 忽略 */ });
  }
  setInterval(refreshStorage, 10000);

  // ---------- 启动 ----------
  renderMe();
  renderConversations();
  initSaveLocation();
  refreshStorage();
  connect();
})();
