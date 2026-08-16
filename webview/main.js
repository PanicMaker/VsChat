(function () {
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const textInput = document.getElementById('text-input');
  const sendBtn = document.getElementById('send-btn');
  const emojiBtn = document.getElementById('emoji-btn');
  const emojiPanel = document.getElementById('emoji-panel');
  const attachBtn = document.getElementById('attach-btn');
  const fileInput = document.getElementById('file-input');
  const loginScreen = document.getElementById('login-screen');
  const loginStatus = document.getElementById('login-status');
  const qrcodeImg = document.getElementById('qrcode');
  const chatContainer = document.getElementById('chat-container');
  const inputBar = document.getElementById('input-bar');
  const quoteBar = document.getElementById('quote-bar');
  const quotePreview = document.getElementById('quote-preview');
  const quoteCancel = document.getElementById('quote-cancel');
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightbox-img');
  const lightboxClose = document.getElementById('lightbox-close');
  const lightboxZoomLabel = document.getElementById('lightbox-zoom');

  // Lightbox zoom / pan state
  let lightboxZoom = 1;
  let lightboxPanX = 0;
  let lightboxPanY = 0;
  let lightboxDragging = false;
  let lightboxDragStartX = 0;
  let lightboxDragStartY = 0;
  let lightboxStartPanX = 0;
  let lightboxStartPanY = 0;

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
  let quoteTarget = null; // { messageId, type, text, timestamp }

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
    emojiPanel?.classList.add('hidden');
    updateQuoteBar();
    vscode.setState({ mode });

    // Update toolbar button active state
    document.querySelectorAll('#toolbar .toolbar-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
  }

  function reRenderAll() {
    lastRenderedDate = '';
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

  let lastRenderedDate = ''; // track for date separators

  function getDateKey(timestamp) {
    const d = new Date(timestamp * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function formatDateLabel(timestamp) {
    const msgDate = new Date(timestamp * 1000);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const msgDay = new Date(msgDate.getFullYear(), msgDate.getMonth(), msgDate.getDate());

    if (msgDay.getTime() === today.getTime()) return '今天';
    if (msgDay.getTime() === yesterday.getTime()) return '昨天';

    const diffDays = Math.floor((today.getTime() - msgDay.getTime()) / 86400000);
    if (diffDays < 7) {
      return ['周日','周一','周二','周三','周四','周五','周六'][msgDate.getDay()];
    }

    if (msgDate.getFullYear() === now.getFullYear()) {
      return `${msgDate.getMonth() + 1}月${msgDate.getDate()}日`;
    }
    return `${msgDate.getFullYear()}/${msgDate.getMonth() + 1}/${msgDate.getDate()}`;
  }

  function formatTime(timestamp) {
    const date = new Date(timestamp * 1000);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatLogPrefix(msg) {
    const date = new Date(msg.timestamp * 1000);
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const level = msg.direction === 'sent' ? 'OUT' : 'INF';
    return `[${time}] ${level} `;
  }

  function formatGitPrefix(msg) {
    const date = new Date(msg.timestamp * 1000);
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const prefix = msg.direction === 'sent' ? '+' : ' ';
    return `${prefix} ${time} `;
  }

  // ---- Quote / reply helpers ----

  function parseReplyTo(msg) {
    if (!msg || !msg.reply_to) return null;
    try {
      const parsed = JSON.parse(msg.reply_to);
      return parsed && (parsed.messageId || parsed.text) ? parsed : null;
    } catch {
      return null;
    }
  }

  function replyPreviewLabel(reply) {
    if (!reply) return '';
    if (reply.text) return reply.text;
    const typeLabel = { 2: '[图片]', 3: '[语音]', 4: '[文件]', 5: '[视频]' }[reply.type];
    return typeLabel || '[消息]';
  }

  function normalizeMsgId(id) {
    return String(id || '').replace(/^v1:/, '');
  }

  // Resolve quoted text from locally stored messages when the server omitted it
  function localQuoteText(messageId) {
    if (!messageId) return '';
    const found = allMessages.find(
      (m) => m.message_id && normalizeMsgId(m.message_id) === normalizeMsgId(messageId)
    );
    return found && found.type === 1 ? found.content : '';
  }

  function setQuote(msg) {
    if (!msg || !msg.message_id) return;
    quoteTarget = {
      messageId: msg.message_id,
      type: msg.type,
      text: msg.type === 1 ? msg.content : '',
      timestamp: msg.timestamp,
    };
    updateQuoteBar();
    textInput.focus();
  }

  function clearQuote() {
    quoteTarget = null;
    updateQuoteBar();
  }

  function updateQuoteBar() {
    const visible = currentMode === 'chat' && quoteTarget;
    quoteBar.classList.toggle('hidden', !visible);
    if (visible) {
      quotePreview.textContent = `回复: ${replyPreviewLabel(quoteTarget)}`;
    }
  }

  function scrollToMessage(messageId) {
    if (!messageId) return;
    let targetEl = messagesEl.querySelector(`[data-msgid="${CSS.escape(String(messageId))}"]`);
    if (!targetEl) {
      const found = allMessages.find(
        (m) => m.message_id && normalizeMsgId(m.message_id) === normalizeMsgId(messageId)
      );
      if (found) targetEl = messagesEl.querySelector(`[data-id="${found.id}"]`);
    }
    if (targetEl) {
      targetEl.scrollIntoView({ block: 'center' });
      targetEl.classList.add('highlight-flash');
      setTimeout(() => targetEl.classList.remove('highlight-flash'), 1200);
    }
  }

  function insertDateSeparator(timestamp) {
    const dateKey = getDateKey(timestamp);
    if (dateKey !== lastRenderedDate) {
      lastRenderedDate = dateKey;
      const sep = document.createElement('div');
      sep.className = 'date-separator';
      sep.textContent = formatDateLabel(timestamp);
      messagesEl.appendChild(sep);
    }
  }

  // ---- Render ----

  function renderMessage(msg) {
    // Insert date separator if day changed
    insertDateSeparator(msg.timestamp);

    const div = document.createElement('div');
    div.className = `message ${msg.direction}`;
    div.dataset.id = msg.id;
    if (msg.message_id) div.dataset.msgid = msg.message_id;

    if (currentMode === 'chat') {
      renderChatMode(div, msg);
    } else if (currentMode === 'log') {
      renderLogMode(div, msg);
    } else if (currentMode === 'git') {
      renderGitMode(div, msg);
    }

    // Quote-reply action (Chat mode only, needs a server-side message id)
    if (currentMode === 'chat' && msg.message_id) {
      const quoteBtn = document.createElement('button');
      quoteBtn.className = 'quote-action';
      quoteBtn.title = '引用回复';
      quoteBtn.textContent = '↩';
      quoteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setQuote(msg);
      });
      div.appendChild(quoteBtn);
    }

    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function renderChatMode(div, msg) {
    const reply = parseReplyTo(msg);
    if (reply) {
      const quoteEl = document.createElement('div');
      quoteEl.className = 'quote-preview';
      quoteEl.textContent = replyPreviewLabel({
        ...reply,
        text: reply.text || localQuoteText(reply.messageId),
      });
      quoteEl.title = '跳转到被引用的消息';
      quoteEl.addEventListener('click', (e) => {
        e.stopPropagation();
        scrollToMessage(reply.messageId);
      });
      div.appendChild(quoteEl);
    }

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

    const reply = parseReplyTo(msg);
    if (reply) {
      const refEl = document.createElement('span');
      refEl.className = 'quote-inline';
      refEl.textContent = `[引用: ${replyPreviewLabel(reply)}] `;
      div.appendChild(refEl);
    }

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

    const reply = parseReplyTo(msg);
    if (reply) {
      const refEl = document.createElement('span');
      refEl.className = 'quote-inline';
      refEl.textContent = `[引用: ${replyPreviewLabel(reply)}] `;
      div.appendChild(refEl);
    }

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
        openLightbox(img.src);
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

  // ---- Lightbox zoom & pan ----

  function applyLightboxTransform() {
    lightboxImg.style.transform = `translate(${lightboxPanX}px, ${lightboxPanY}px) scale(${lightboxZoom})`;
    if (lightboxZoomLabel) {
      lightboxZoomLabel.textContent = Math.round(lightboxZoom * 100) + '%';
    }
  }

  function resetLightboxTransform() {
    lightboxZoom = 1;
    lightboxPanX = 0;
    lightboxPanY = 0;
    applyLightboxTransform();
  }

  function openLightbox(src) {
    lightboxImg.src = src;
    resetLightboxTransform();
    lightbox.classList.remove('hidden');
  }

  function closeLightbox() {
    lightbox.classList.add('hidden');
    resetLightboxTransform();
  }

  function loadHistory(messages) {
    allMessages = messages;
    lastRenderedDate = '';
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
      const replyTo = quoteTarget ? {
        messageId: quoteTarget.messageId,
        type: quoteTarget.type,
        text: quoteTarget.text,
        timestamp: quoteTarget.timestamp,
      } : undefined;
      vscode.postMessage({ command: 'sendMessage', text, replyTo });
      textInput.value = '';
      clearQuote();
    }
  });

  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  attachBtn.addEventListener('click', () => {
    clearQuote();
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

  // ---- Emoji picker ----

  const EMOJIS = [
    '😀', '😁', '😂', '🤣', '😊', '😉', '😍', '😘',
    '😜', '🤪', '🤔', '🤨', '😎', '🥳', '😭', '😡',
    '👍', '👎', '👏', '🙏', '🤝', '💪', '✌️', '🤞',
    '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💯',
    '🎉', '🎊', '🎂', '🌹', '🌸', '⭐', '🔥', '✨',
    '☀️', '🌈', '🍎', '🍺', '☕', '🐶', '🐱', '🐼',
  ];

  emojiPanel.innerHTML = EMOJIS.map((e) => `<span class="emoji">${e}</span>`).join('');

  function insertEmoji(emoji) {
    const start = textInput.selectionStart ?? textInput.value.length;
    const end = textInput.selectionEnd ?? textInput.value.length;
    textInput.value = textInput.value.slice(0, start) + emoji + textInput.value.slice(end);
    textInput.focus();
    const pos = start + emoji.length;
    textInput.setSelectionRange(pos, pos);
  }

  function closeEmojiPanel() {
    emojiPanel.classList.add('hidden');
  }

  emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    emojiPanel.classList.toggle('hidden');
  });

  emojiPanel.addEventListener('click', (e) => {
    const cell = e.target.closest('.emoji');
    if (!cell) return;
    insertEmoji(cell.textContent);
    closeEmojiPanel();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#emoji-panel') && !e.target.closest('#emoji-btn')) {
      closeEmojiPanel();
    }
  });

  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeEmojiPanel();
  });

  lightboxClose.addEventListener('click', () => {
    closeLightbox();
  });

  quoteCancel.addEventListener('click', () => {
    clearQuote();
  });

  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) {
      closeLightbox();
    }
  });

  // Mouse wheel zooms toward the cursor position
  lightbox.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = Math.pow(1.1, -e.deltaY / 100);
    const newZoom = Math.min(6, Math.max(1, lightboxZoom * factor));
    if (newZoom === lightboxZoom) return;

    const rect = lightboxImg.getBoundingClientRect();
    const offsetX = e.clientX - rect.left - rect.width / 2;
    const offsetY = e.clientY - rect.top - rect.height / 2;
    const ratio = newZoom / lightboxZoom - 1;
    lightboxPanX -= offsetX * ratio;
    lightboxPanY -= offsetY * ratio;
    lightboxZoom = newZoom;
    applyLightboxTransform();
  }, { passive: false });

  // Drag to pan when zoomed in
  lightboxImg.addEventListener('pointerdown', (e) => {
    if (lightboxZoom <= 1) return;
    lightboxDragging = true;
    lightboxDragStartX = e.clientX;
    lightboxDragStartY = e.clientY;
    lightboxStartPanX = lightboxPanX;
    lightboxStartPanY = lightboxPanY;
    lightboxImg.setPointerCapture(e.pointerId);
    lightboxImg.classList.add('dragging');
    e.preventDefault();
  });

  lightboxImg.addEventListener('pointermove', (e) => {
    if (!lightboxDragging) return;
    lightboxPanX = lightboxStartPanX + (e.clientX - lightboxDragStartX);
    lightboxPanY = lightboxStartPanY + (e.clientY - lightboxDragStartY);
    applyLightboxTransform();
  });

  function endLightboxDrag() {
    lightboxDragging = false;
    lightboxImg.classList.remove('dragging');
  }

  lightboxImg.addEventListener('pointerup', endLightboxDrag);
  lightboxImg.addEventListener('pointercancel', endLightboxDrag);

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
