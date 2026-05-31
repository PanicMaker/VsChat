(function () {
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const textInput = document.getElementById('text-input');
  const sendBtn = document.getElementById('send-btn');
  const attachBtn = document.getElementById('attach-btn');
  const fileInput = document.getElementById('file-input');
  const loginScreen = document.getElementById('login-screen');
  const loginStatus = document.getElementById('login-status');
  const qrcodeImg = document.getElementById('qrcode');
  const chatContainer = document.getElementById('chat-container');
  const inputBar = document.getElementById('input-bar');
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightbox-img');
  const lightboxClose = document.getElementById('lightbox-close');

  const MODES = ['chat', 'log', 'git'];
  const MODE_LABELS = { chat: 'Chat', log: 'Output', git: 'Changes' };
  const MODE_PLACEHOLDERS = {
    chat: 'Type a message...',
    log: '> _',
    git: 'commit -m ""',
  };
  const MODE_SEND_LABELS = { chat: 'Send', log: '⏎', git: '⏎' };

  let currentMode = 'chat';
  let hasPartner = false;
  let allMessages = []; // keep messages for re-render on mode switch

  // Restore saved mode
  const saved = vscode.getState();
  if (saved && saved.mode && MODES.includes(saved.mode)) {
    currentMode = saved.mode;
  }
  applyMode(currentMode);

  // Notify extension that webview is ready
  vscode.postMessage({ command: 'ready' });

  // ---- Mode switching ----

  function applyMode(mode) {
    currentMode = mode;
    document.body.className = `mode-${mode}`;
    textInput.placeholder = MODE_PLACEHOLDERS[mode];
    sendBtn.textContent = MODE_SEND_LABELS[mode];
    vscode.setState({ mode });

    // Update toolbar button active state
    document.querySelectorAll('#toolbar .toolbar-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
  }

  function reRenderAll() {
    messagesEl.innerHTML = '';
    for (const msg of allMessages) {
      renderMessage(msg);
    }
    scrollToBottom();
  }

  // Toolbar click handler
  document.getElementById('toolbar').addEventListener('click', (e) => {
    const btn = e.target.closest('.toolbar-btn');
    if (!btn || !btn.dataset.mode) return;
    applyMode(btn.dataset.mode);
    reRenderAll();
  });

  // ---- Formatting helpers ----

  function formatTime(timestamp) {
    const date = new Date(timestamp * 1000);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function formatLogPrefix(msg) {
    const time = formatTime(msg.timestamp);
    const level = msg.direction === 'sent' ? 'OUT' : 'INF';
    return `[${time}] ${level} `;
  }

  function formatGitPrefix(msg) {
    const time = formatTime(msg.timestamp);
    const prefix = msg.direction === 'sent' ? '+' : ' ';
    return `${prefix} ${time} `;
  }

  // ---- Render ----

  function renderMessage(msg) {
    const div = document.createElement('div');
    div.className = `message ${msg.direction}`;
    div.dataset.id = msg.id;

    if (currentMode === 'chat') {
      renderChatMode(div, msg);
    } else if (currentMode === 'log') {
      renderLogMode(div, msg);
    } else if (currentMode === 'git') {
      renderGitMode(div, msg);
    }

    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function renderChatMode(div, msg) {
    if (msg.type === 1) {
      const textEl = document.createElement('div');
      textEl.textContent = msg.content;
      div.appendChild(textEl);
    } else if (msg.type === 2) {
      renderImageContent(div, msg);
    }
    const timeEl = document.createElement('div');
    timeEl.className = 'timestamp';
    timeEl.textContent = formatTime(msg.timestamp);
    div.appendChild(timeEl);
  }

  function renderLogMode(div, msg) {
    const prefixEl = document.createElement('span');
    prefixEl.className = 'timestamp';
    prefixEl.textContent = formatLogPrefix(msg);
    div.appendChild(prefixEl);

    if (msg.type === 1) {
      const textEl = document.createElement('span');
      textEl.className = 'msg-text';
      textEl.textContent = msg.content;
      div.appendChild(textEl);
    } else if (msg.type === 2) {
      renderImageContent(div, msg);
    }
  }

  function renderGitMode(div, msg) {
    const prefixEl = document.createElement('span');
    prefixEl.className = 'timestamp';
    prefixEl.textContent = formatGitPrefix(msg);
    div.appendChild(prefixEl);

    if (msg.type === 1) {
      const textEl = document.createElement('span');
      textEl.className = 'msg-text';
      textEl.textContent = msg.content;
      div.appendChild(textEl);
    } else if (msg.type === 2) {
      renderImageContent(div, msg);
    }
  }

  function renderImageContent(div, msg) {
    if (msg.direction === 'received' && msg.imageDataUrl) {
      const img = document.createElement('img');
      img.className = 'message-image';
      img.src = msg.imageDataUrl;
      img.alt = 'image';
      img.addEventListener('click', () => {
        lightboxImg.src = img.src;
        lightbox.classList.remove('hidden');
      });
      div.appendChild(img);
    } else if (msg.direction === 'received') {
      const isUrl = msg.content && msg.content.startsWith('http');
      const placeholder = document.createElement('div');
      placeholder.className = 'image-container';
      placeholder.textContent = currentMode === 'chat' ? '[Image]' : '<binary data>';
      if (isUrl) {
        placeholder.addEventListener('click', () => {
          vscode.postMessage({ command: 'openExternal', url: msg.content });
        });
      }
      div.appendChild(placeholder);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'image-container image-sent';
      placeholder.textContent = currentMode === 'chat' ? '[Image sent]' : '<binary 0x...>';
      div.appendChild(placeholder);
    }
  }

  function scrollToBottom() {
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  function loadHistory(messages) {
    allMessages = messages;
    messagesEl.innerHTML = '';
    for (const msg of messages) {
      renderMessage(msg);
    }
    scrollToBottom();
  }

  // ---- Events ----

  sendBtn.addEventListener('click', () => {
    const text = textInput.value.trim();
    if (text) {
      vscode.postMessage({ command: 'sendMessage', text });
      textInput.value = '';
    }
  });

  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  attachBtn.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        vscode.postMessage({
          command: 'sendImage',
          imageData: event.target.result,
          fileName: file.name,
        });
      };
      reader.readAsDataURL(file);
    }
    fileInput.value = '';
  });

  lightboxClose.addEventListener('click', () => {
    lightbox.classList.add('hidden');
  });

  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) {
      lightbox.classList.add('hidden');
    }
  });

  // ---- Messages from extension host ----

  window.addEventListener('message', (event) => {
    const message = event.data;

    switch (message.command) {
      case 'loadHistory':
        loadHistory(message.messages || []);
        hasPartner = message.messages && message.messages.length > 0;
        loginScreen.classList.add('hidden');
        chatContainer.classList.remove('hidden');
        inputBar.classList.remove('hidden');
        break;

      case 'newMessage':
        if (message.message) {
          if (!loginScreen.classList.contains('hidden')) {
            loginScreen.classList.add('hidden');
            chatContainer.classList.remove('hidden');
            inputBar.classList.remove('hidden');
          }
          allMessages.push(message.message);
          renderMessage(message.message);
          hasPartner = true;
        }
        break;

      case 'clearHistory':
        allMessages = [];
        messagesEl.innerHTML = '';
        break;

      case 'qrcode':
        loginScreen.classList.remove('hidden');
        chatContainer.classList.add('hidden');
        inputBar.classList.add('hidden');
        if (message.qrcode) {
          qrcodeImg.src = message.qrcode;
          qrcodeImg.classList.remove('hidden');
        }
        break;

      case 'status':
        loginScreen.classList.remove('hidden');
        loginStatus.textContent = message.status || '';
        break;

      case 'error':
        if (message.error) {
          const errDiv = document.createElement('div');
          errDiv.className = 'message received';
          errDiv.style.color = '#f44747';
          errDiv.textContent = currentMode === 'chat'
            ? `Error: ${message.error}`
            : `[ERR] ${message.error}`;
          messagesEl.appendChild(errDiv);
          scrollToBottom();
        }
        break;
    }
  });
})();
