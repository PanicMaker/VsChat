(function () {
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const textInput = document.getElementById('text-input');
  const sendBtn = document.getElementById('send-btn');
  const emojiBtn = document.getElementById('emoji-btn');
  const emojiPanel = document.getElementById('emoji-panel');
  const attachBtn = document.getElementById('attach-btn');
  const fileDraftBar = document.getElementById('file-draft');
  const fileDraftName = document.getElementById('file-draft-name');
  const fileDraftCancel = document.getElementById('file-draft-cancel');
  const fileInput = document.getElementById('file-input');
  const loginScreen = document.getElementById('login-screen');
  const loginStatus = document.getElementById('login-status');
  const qrcodeImg = document.getElementById('qrcode');
  const chatContainer = document.getElementById('chat-container');
  const loadMoreHistoryBtn = document.getElementById('load-more-history');
  const inputBar = document.getElementById('input-bar');
  const quoteBar = document.getElementById('quote-bar');
  const quotePreview = document.getElementById('quote-preview');
  const quoteCancel = document.getElementById('quote-cancel');
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightbox-img');
  const lightboxClose = document.getElementById('lightbox-close');
  const lightboxZoomLabel = document.getElementById('lightbox-zoom');
  const draftBar = document.getElementById('paste-draft');
  const preview = document.getElementById('paste-preview');
  const status = document.getElementById('paste-status');
  const sendFeedback = document.getElementById('send-feedback');
  const sendStatusLabel = document.getElementById('send-status');
  const retrySendBtn = document.getElementById('retry-send');
  const confirmSendBtn = document.getElementById('confirm-send');
  const newMessagesBtn = document.getElementById('new-messages');
  const searchPanel = document.getElementById('search-panel');
  const searchQuery = document.getElementById('search-query');
  const searchType = document.getElementById('search-type');
  const searchFrom = document.getElementById('search-from');
  const searchTo = document.getElementById('search-to');
  const searchSubmit = document.getElementById('search-submit');
  const searchStatus = document.getElementById('search-status');
  const searchResults = document.getElementById('search-results');
  const searchMore = document.getElementById('search-more');
  const searchContext = document.getElementById('search-context');
  const searchContextTitle = document.getElementById('search-context-title');
  const searchContextMessages = document.getElementById('search-context-messages');
  const dataPanel = document.getElementById('data-panel');
  const dataFrom = document.getElementById('data-from');
  const dataTo = document.getElementById('data-to');
  const dataStatus = document.getElementById('data-status');
  const restorePreviewEl = document.getElementById('restore-preview');
  const restoreConfirmBtn = document.getElementById('restore-confirm');
  const storageSummary = document.getElementById('storage-summary');
  const cleanupSummary = document.getElementById('cleanup-summary');
  const cleanupConfirmBtn = document.getElementById('cleanup-confirm');
  const dataActionIds = ['export-markdown', 'export-json', 'backup-create', 'restore-select', 'storage-refresh', 'cleanup-preview'];
  const recipientBar = document.getElementById('recipient-bar');
  const recipientSelect = document.getElementById('recipient-select');
  const recipientStatus = document.getElementById('recipient-status');
  const connectionStatus = document.getElementById('connection-status');
  const fileDraftStatus = document.createElement('span');
  fileDraftStatus.className = 'file-draft-status';
  fileDraftStatus.setAttribute('role', 'status');
  fileDraftBar.appendChild(fileDraftStatus);
  const fileCapabilityStatus = document.createElement('span');
  fileCapabilityStatus.className = 'file-capability-status';
  fileCapabilityStatus.setAttribute('role', 'status');
  inputBar.appendChild(fileCapabilityStatus);

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
  let loadingHistory = false;
  let initialHistoryLoaded = false;
  let quoteTarget = null; // { messageId, type, text, timestamp }
  let pendingImage = null;
  let pendingImageRead = null;
  let pendingFile = null;
  let activeFileSelection = null;
  let fileSelectionLabel = '';
  const MAX_FILE_BYTES = 20 * 1024 * 1024;
  let fileCapabilities = { canSend: false, maxBytes: MAX_FILE_BYTES, reason: '正在确认当前通道的文件发送能力…' };
  let activeSend = null;
  let currentChannel = null;
  let recipientManaged = false;
  let recipients = [];
  let selectedRecipientId = null;
  let currentSelectionId = null;
  let pendingRecipientSelection = null;
  let recipientReason = '';
  let recipientSelectionError = '';
  let totalUnreadCount = 0;
  let pendingReadingRestore = null;
  let revealRecipientAfterSync = false;
  const conversationPositions = new Map();
  const restoredSelections = new Set();
  let unreadCount = 0;
  let followingMessages = true;
  let readingPosition = null;
  let preservedScrollTop = null;
  let lastSendLabel = '';
  let syncGeneration = null;
  const retiredGenerations = new Set();
  let hostFocused = false;
  let sharedReadThroughId = 0;
  let lastReadSent = 0;
  let applyingSync = false;
  let sendShortcut = 'enter';
  let searchOpen = false;
  let dataOpen = false;
  let activeData = null;
  let dataPreviewRevision = 0;
  let restorePreview = null;
  let cleanupPreview = null;
  let activeSearch = null;
  let completedSearch = null;
  let searchRows = [];
  let searchHasMore = false;
  let pendingContext = null;
  let contextGeneration = null;
  let contextSnapshot = null;
  let renderMarkdown = true;
  let presentationReadSuppressed = false;
  let presentationChange = 0;
  const pendingCopies = new Map();
  const attachmentStates = new Map();
  const pendingAttachments = new Map();
  const pendingFileSelectionScopes = new Map();

  // Restore saved mode
  const saved = vscode.getState() || {};
  const drafts = saved.drafts || {};
  const selectedRecipients = saved.selectedRecipients || {};
  const recipientAliases = Object.assign(Object.create(null), saved.recipientAliases || {});
  if (saved && saved.mode && MODES.includes(saved.mode)) {
    currentMode = saved.mode;
  }
  applyMode(currentMode);
  updateComposer();
  updateShortcutHints();
  updateDataControls();
  recipientBar.classList.add('hidden');
  connectionStatus.classList.add('hidden');

  // ---- Mode switching ----

  function applyMode(mode) {
    currentMode = mode;
    document.body.className = `mode-${mode}${searchOpen ? ' search-open' : ''}${dataOpen ? ' data-open' : ''}`;
    textInput.placeholder = MODE_PLACEHOLDERS[mode];
    sendBtn.textContent = activeSend?.status === 'sending' ? '发送中…' : MODE_SEND_LABELS[mode];
    emojiPanel?.classList.add('hidden');
    updateQuoteBar();
    persistDraft();
    resizeInput();

    // Update toolbar button active state
    document.querySelectorAll('#toolbar .toolbar-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
  }

  function reRenderAll(position = captureReadingPosition(), follow = isNearBottom() && !document.hidden) {
    lastRenderedDate = '';
    const fragment = document.createDocumentFragment();
    for (const msg of allMessages) {
      renderMessage(msg, fragment);
    }
    messagesEl.replaceChildren(fragment);
    if (follow) scrollToBottom();
    else restoreReadingPosition(position);
  }

  function currentDraftKey() {
    if (!currentChannel) return null;
    return recipientManaged ? selectedRecipientId ? JSON.stringify([currentChannel, selectedRecipientId]) : null : currentChannel;
  }

  function saveState() {
    vscode.setState({ mode: currentMode, drafts, selectedRecipients, recipientAliases });
  }

  function persistDraft() {
    const key = currentDraftKey();
    if (key) {
      drafts[key] = {
        text: textInput.value, quote: quoteTarget,
        image: pendingImage?.imageData ? pendingImage : null,
        file: pendingFile ? { fileId: pendingFile.fileId, fileName: pendingFile.fileName, size: pendingFile.size } : null,
        send: activeSend, lastSendLabel,
      };
    }
    saveState();
  }

  function viewScope() {
    if (!recipientManaged) return {};
    return selectedRecipientId && currentSelectionId && !pendingRecipientSelection
      ? { recipientId: selectedRecipientId, selectionId: currentSelectionId } : null;
  }

  function matchesViewScope(message) {
    if (!recipientManaged) return true;
    const scope = viewScope();
    return Boolean(scope && message.recipientId === scope.recipientId && message.selectionId === scope.selectionId);
  }

  function postScoped(message, scope = viewScope()) {
    if (!scope) return false;
    vscode.postMessage({ ...message, ...scope });
    return true;
  }

  function recipientCanSend() {
    return !recipientManaged || Boolean(recipientCanEdit()
      && recipients.find(option => option.id === selectedRecipientId)?.canSend === true);
  }

  function recipientCanEdit() {
    return !recipientManaged || Boolean(viewScope() && selectedRecipientId !== '__history__'
      && recipients.some(option => option.id === selectedRecipientId));
  }

  function resizeInput() {
    textInput.style.height = 'auto';
    const border = (textInput.offsetHeight - textInput.clientHeight) || 0;
    const maxHeight = Math.min(160, Math.max(80, (window.innerHeight || 640) * 0.25));
    textInput.style.height = Math.min(maxHeight, Math.max(50, textInput.scrollHeight + border)) + 'px';
  }

  function updateComposer() {
    const busy = activeSend?.status === 'sending';
    const locked = !currentChannel || busy || !recipientCanEdit();
    textInput.readOnly = locked;
    attachBtn.disabled = locked || Boolean(activeFileSelection) || Boolean(pendingImageRead);
    fileDraftCancel.disabled = locked;
    emojiBtn.disabled = locked;
    quoteCancel.disabled = locked;
    document.getElementById('paste-cancel').disabled = locked;
    sendBtn.disabled = locked || !recipientCanSend() || Boolean(activeSend) || Boolean(activeFileSelection) || Boolean(pendingImageRead)
      || Boolean(pendingImage && !pendingImage.imageData) || Boolean(pendingFile && !canSendFile());
    const blockedReason = !recipientCanSend()
      ? recipients.find(option => option.id === selectedRecipientId)?.reason || '请先选择可发送的联系人' : '';
    const blockedHint = (pendingImage || pendingFile || textInput.value.trim()) ? blockedReason : '';
    sendStatusLabel.textContent = activeSend
      ? ({ sending: '发送中…', failed: '发送失败，草稿已保留',
        uncertain: '发送结果待确认，请先检查对方是否收到；重发可能产生重复消息' }[activeSend.status]
        + (activeSend.error ? `：${activeSend.error}` : ''))
      : blockedHint || lastSendLabel;
    const successOnly = !activeSend && !blockedHint && ['已发送', '已确认对方收到'].includes(lastSendLabel);
    sendFeedback.classList.toggle('hidden', !sendStatusLabel.textContent || successOnly || busy);
    sendBtn.textContent = busy ? '发送中…' : MODE_SEND_LABELS[currentMode];
    sendBtn.title = busy ? '正在等待服务器确认' : blockedReason || (successOnly ? lastSendLabel : '发送消息');
    retrySendBtn.classList.toggle('hidden', !activeSend || busy);
    confirmSendBtn.classList.toggle('hidden', activeSend?.status !== 'uncertain');
    retrySendBtn.textContent = activeSend?.status === 'uncertain' ? '确认可能重复，重新发送' : '重试发送';
    retrySendBtn.disabled = locked || !recipientCanSend() || Boolean(activeFileSelection) || Boolean(pendingImageRead)
      || Boolean(pendingFile && !canSendFile())
      || (!pendingFile && !pendingImage?.imageData && !textInput.value.trim());
    confirmSendBtn.disabled = !recipientCanEdit();
    fileCapabilityStatus.textContent = fileSelectionLabel;
    fileCapabilityStatus.classList.toggle('hidden', !fileCapabilityStatus.textContent);
    showFileDraft();
  }

  function restoreDraft(channel) {
    if (!channel || channel === currentChannel) return;
    persistDraft();
    currentChannel = channel;
    if (recipientManaged) {
      selectedRecipientId = null;
      currentSelectionId = null;
      pendingRecipientSelection = null;
      resetConversationView();
    }
    loadCurrentDraft();
    if (recipientManaged) updateRecipientUI();
  }

  function loadCurrentDraft() {
    const draft = drafts[currentDraftKey()] || {};
    textInput.value = typeof draft.text === 'string' ? draft.text : '';
    quoteTarget = draft.quote || null;
    pendingImage = draft.image || null;
    pendingImageRead = null;
    activeFileSelection = null;
    fileSelectionLabel = '';
    pendingFile = draft.file?.fileId && typeof draft.file.fileId === 'string'
      ? { fileId: draft.file.fileId, fileName: String(draft.file.fileName || '文件'), size: draft.file.size, valid: false, checking: true }
      : null;
    if (pendingFile) pendingImage = null;
    activeSend = draft.send || null;
    lastSendLabel = draft.lastSendLabel || '';
    updateQuoteBar();
    showImageDraft();
    resizeInput();
    updateComposer();
    if (activeSend && (!recipientManaged || selectedRecipientId !== '__history__')) postScoped({ command: 'getSendStatus', requestId: activeSend.requestId });
    if (pendingFile) postScoped({ command: 'getFileDraft', fileId: pendingFile.fileId, requestId: crypto.randomUUID() });
  }

  function rememberConversationPosition() {
    const key = currentDraftKey();
    if (key && initialHistoryLoaded) conversationPositions.set(key, {
      generation: syncGeneration, position: captureReadingPosition(), follow: followingMessages,
    });
  }

  function resetConversationView() {
    if (searchOpen) setSearchOpen(false);
    invalidateSearch('联系人已切换，请重新搜索当前联系人的历史。');
    if (dataOpen) setDataOpen(false);
    else invalidateDataPreviews('联系人已切换，请重新预览。');
    allMessages = [];
    messagesEl.innerHTML = '';
    lastRenderedDate = '';
    initialHistoryLoaded = false;
    loadingHistory = false;
    hasPartner = false;
    loadMoreHistoryBtn.disabled = false;
    loadMoreHistoryBtn.classList.add('hidden');
    syncGeneration = null;
    retiredGenerations.clear();
    sharedReadThroughId = 0;
    lastReadSent = 0;
    unreadCount = 0;
    followingMessages = false;
    readingPosition = null;
    preservedScrollTop = null;
    pendingReadingRestore = null;
    revealRecipientAfterSync = false;
    pendingImageRead = null;
    activeFileSelection = null;
    closeLightbox();
    updateUnread();
  }

  function recipientAlias(id) {
    const value = recipientAliases[JSON.stringify([currentChannel, id])];
    return typeof value === 'string' ? value.slice(0, 40) : '';
  }

  document.getElementById('recipient-alias-save').addEventListener('click', () => {
    if (!currentSelectionId || !selectedRecipientId || selectedRecipientId === '__history__' || pendingRecipientSelection) return;
    const alias = document.getElementById('recipient-alias').value.trim().slice(0, 40);
    const key = JSON.stringify([currentChannel, selectedRecipientId]);
    if (alias) recipientAliases[key] = alias;
    else delete recipientAliases[key];
    saveState();
    updateRecipientUI();
    document.getElementById('recipient-alias-status').textContent = alias ? '备注已保存（当前窗口）' : '备注已清除';
  });

  function updateRecipientUI() {
    if (!recipientManaged) return;
    recipientBar.classList.remove('hidden');
    recipientSelect.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '请选择收件人或只读历史';
    recipientSelect.appendChild(placeholder);
    for (const option of recipients) {
      const element = document.createElement('option');
      element.value = option.id;
      element.textContent = `${recipientAlias(option.id) ? recipientAlias(option.id) + " · " : ""}${option.label}${option.unreadCount > 0 ? ` · ${option.unreadCount} 未读` : ''}`;
      recipientSelect.appendChild(element);
    }
    recipientSelect.value = pendingRecipientSelection?.recipientId || (currentSelectionId ? selectedRecipientId : '') || '';
    const selected = recipients.find(option => option.id === selectedRecipientId);
    const countLabel = totalUnreadCount ? ` · 全部未读 ${totalUnreadCount} 条` : '';
    recipientSelect.title = selected && currentSelectionId ? `发送给：${selected.label}${countLabel}` : '请选择明确收件人';
    recipientStatus.textContent = pendingRecipientSelection
      ? `正在切换到 ${recipients.find(option => option.id === pendingRecipientSelection.recipientId)?.label || '所选联系人'}，请稍候…`
      : recipientSelectionError || (selected && currentSelectionId
        ? selected.id === '__history__'
          ? `当前通道全部历史（只读）。旧版未绑定草稿仅供查看和复制，不能发送。${countLabel}`
          : selected.canSend ? '' : `${selected.reason || '此联系人当前不可发送'}${countLabel}`
        : `${recipientReason || '请明确选择收件人；新消息不会自动改变发送目标。'}${countLabel}`);
    recipientStatus.classList.toggle('hidden', !recipientStatus.textContent);
    const summary = document.getElementById('recipient-summary');
    summary.textContent = selected && currentSelectionId ? `给：${recipientAlias(selected.id) || selected.label}` : '选择收件人';
    summary.title = recipientStatus.textContent || recipientSelect.title;
    const aliasInput = document.getElementById('recipient-alias');
    const aliasDisabled = !selected || !currentSelectionId || selected.id === '__history__' || Boolean(pendingRecipientSelection);
    aliasInput.disabled = aliasDisabled;
    document.getElementById('recipient-alias-save').disabled = aliasDisabled;
    if (document.activeElement !== aliasInput || aliasInput.dataset.recipient !== selectedRecipientId) {
      aliasInput.value = selected ? recipientAlias(selected.id) : '';
      aliasInput.dataset.recipient = selectedRecipientId || '';
      document.getElementById('recipient-alias-status').textContent = '';
    }
    updateComposer();
  }

  function receiveRecipients(message) {
    if (!recipientManaged) {
      persistDraft();
      recipientManaged = true;
      if (currentChannel && drafts[currentChannel]) {
        const key = JSON.stringify([currentChannel, '__history__']);
        if (!drafts[key]) drafts[key] = JSON.parse(JSON.stringify(drafts[currentChannel]));
      }
      resetConversationView();
      loadCurrentDraft();
    }
    recipients = Array.isArray(message.recipients)
      ? message.recipients.filter(option => option && typeof option.id === 'string' && option.id
        && typeof option.label === 'string').map(option => ({ ...option })) : [];
    recipientReason = typeof message.recipientReason === 'string' ? message.recipientReason : '';
    totalUnreadCount = Math.max(0, Number(message.totalUnreadCount) || 0);
    updateRecipientUI();
    const previous = selectedRecipients[currentChannel];
    if (!selectedRecipientId && !pendingRecipientSelection && currentChannel
      && !restoredSelections.has(currentChannel) && recipients.some(option => option.id === previous)) {
      restoredSelections.add(currentChannel);
      selectRecipient(previous);
    }
    saveState();
  }

  function selectRecipient(recipientId, revealLatest = false) {
    if (!recipientManaged || !currentChannel || !recipients.some(option => option.id === recipientId)) return;
    persistDraft();
    rememberConversationPosition();
    pendingImageRead = null;
    showImageDraft();
    const requestId = crypto.randomUUID();
    pendingRecipientSelection = { requestId, recipientId, revealLatest };
    recipientSelectionError = '';
    updateRecipientUI();
    vscode.postMessage({ command: 'selectRecipient', requestId, recipientId });
  }

  function receiveRecipientSelected(message) {
    const pending = pendingRecipientSelection;
    if (!pending || message.requestId !== pending.requestId || message.recipientId !== pending.recipientId
      || message.selectionId !== pending.requestId) return;
    persistDraft();
    resetConversationView();
    selectedRecipientId = message.recipientId;
    document.getElementById('recipient-picker').open = false;
    currentSelectionId = message.selectionId;
    pendingRecipientSelection = null;
    selectedRecipients[currentChannel] = selectedRecipientId;
    pendingReadingRestore = pending.revealLatest ? null : conversationPositions.get(currentDraftKey()) || null;
    revealRecipientAfterSync = pending.revealLatest;
    loadCurrentDraft();
    saveState();
    updateRecipientUI();
  }

  function invalidateRecipient(error) {
    persistDraft();
    rememberConversationPosition();
    selectedRecipientId = null;
    currentSelectionId = null;
    pendingRecipientSelection = null;
    delete selectedRecipients[currentChannel];
    resetConversationView();
    recipientSelectionError = error || '收件人身份已变化，请重新选择。';
    loadCurrentDraft();
    saveState();
    updateRecipientUI();
  }

  recipientSelect.addEventListener('change', () => selectRecipient(recipientSelect.value));
  document.getElementById('recipient-refresh').addEventListener('click', () => {
    vscode.postMessage({ command: 'refreshRecipients' });
  });

  // Toolbar click handler
  document.getElementById('toolbar').addEventListener('click', (e) => {
    const btn = e.target.closest('.toolbar-btn');
    if (!btn || !btn.dataset.mode) return;
    // Capture geometry before applying the new mode's fonts and spacing.
    const position = captureReadingPosition();
    const follow = isNearBottom() && !document.hidden;
    applyMode(btn.dataset.mode);
    reRenderAll(position, follow);
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
      (m) => (m.message_id && normalizeMsgId(m.message_id) === normalizeMsgId(messageId))
        || (m.reference_id && m.reference_id === messageId)
    );
    return found && found.type === 1 ? found.content : '';
  }

  function setQuote(msg) {
    if (!msg || msg.restored || !msg.message_id || activeSend?.status === 'sending' || !recipientCanEdit()) return;
    quoteTarget = {
      messageId: msg.message_id,
      referenceId: msg.reference_id,
      direction: msg.direction,
      type: msg.type,
      text: msg.type === 1 ? msg.content : '',
      timestamp: msg.timestamp,
    };
    updateQuoteBar();
    persistDraft();
    textInput.focus();
  }

  function clearQuote() {
    quoteTarget = null;
    updateQuoteBar();
    persistDraft();
  }

  function updateQuoteBar() {
    const visible = Boolean(quoteTarget);
    quoteBar.classList.toggle('hidden', !visible);
    if (visible) {
      quotePreview.textContent = `回复: ${replyPreviewLabel(quoteTarget)}`;
    }
  }

  function scrollToMessage(messageId) {
    if (!messageId) return;
    let targetEl = Array.from(messagesEl.children).find(el => el.dataset.msgid === String(messageId));
    if (!targetEl) {
      const found = allMessages.find(
        (m) => (m.message_id && normalizeMsgId(m.message_id) === normalizeMsgId(messageId))
          || (m.reference_id && m.reference_id === messageId)
      );
      if (found) targetEl = Array.from(messagesEl.children).find(el => String(el.dataset.id) === String(found.id));
    }
    if (targetEl) {
      targetEl.scrollIntoView({ block: 'center' });
      targetEl.classList.add('highlight-flash');
      setTimeout(() => targetEl.classList.remove('highlight-flash'), 1200);
    } else {
      requestMessageContext({ messageId: String(messageId) });
    }
  }

  function insertDateSeparator(timestamp, target = messagesEl) {
    const dateKey = getDateKey(timestamp);
    if (dateKey !== lastRenderedDate) {
      lastRenderedDate = dateKey;
      const sep = document.createElement('div');
      sep.className = 'date-separator';
      sep.dataset.date = dateKey;
      sep.textContent = formatDateLabel(timestamp);
      target.appendChild(sep);
    }
  }

  // ---- Render ----

  function renderMessage(msg, target = messagesEl) {
    // Insert date separator if day changed
    insertDateSeparator(msg.timestamp, target);

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

    // Quote-reply action in every display mode; only verified live records qualify.
    if (msg.message_id && !msg.restored && recipientCanEdit()) {
      const scope = viewScope();
      const quoteBtn = document.createElement('button');
      quoteBtn.className = 'quote-action';
      quoteBtn.title = '引用回复';
      quoteBtn.textContent = '↩';
      quoteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!matchesViewScope(scope || {})) return;
        setQuote(msg);
      });
      div.appendChild(quoteBtn);
    }

    target.appendChild(div);
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

    renderMessageContent(div, msg, false, true);
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
      const refEl = document.createElement('button');
      refEl.type = 'button';
      refEl.title = '跳转到被引用的消息';
      refEl.addEventListener('click', () => scrollToMessage(reply.messageId));
      refEl.className = 'quote-inline';
      refEl.textContent = `[引用: ${replyPreviewLabel(reply)}] `;
      div.appendChild(refEl);
    }

    renderMessageContent(div, msg, true, false);
  }

  function renderGitMode(div, msg) {
    const prefixEl = document.createElement('span');
    prefixEl.className = 'timestamp';
    prefixEl.textContent = formatGitPrefix(msg);
    div.appendChild(prefixEl);

    const reply = parseReplyTo(msg);
    if (reply) {
      const refEl = document.createElement('button');
      refEl.type = 'button';
      refEl.title = '跳转到被引用的消息';
      refEl.addEventListener('click', () => scrollToMessage(reply.messageId));
      refEl.className = 'quote-inline';
      refEl.textContent = `[引用: ${replyPreviewLabel(reply)}] `;
      div.appendChild(refEl);
    }

    renderMessageContent(div, msg, true, false);
  }

  function safeExternalUrl(value) {
    return window.VsChatRichContent?.safeExternalUrl(value);
  }

  function openExternal(url) {
    const safe = safeExternalUrl(url);
    if (safe) vscode.postMessage({ command: 'openExternal', url: safe });
  }

  function safeImageUrl(value) {
    if (typeof value !== 'string') return undefined;
    if (/^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[a-z\d+/]+={0,2}$/i.test(value)) return value;
    const safe = safeExternalUrl(value);
    // The webview CSP allows HTTPS images; HTTP remains an explicit external
    // action rather than weakening the image policy or silently loading it.
    return safe && /^https:\/\//i.test(safe) ? safe : undefined;
  }

  function copyText(text, button) {
    if (button.disabled) return;
    if (typeof text !== 'string' || text.length > 1_000_000) {
      button.textContent = '内容过长，无法复制';
      return;
    }
    const requestId = crypto.randomUUID();
    pendingCopies.set(requestId, { button, text });
    button.disabled = true;
    button.textContent = '复制中…';
    button.setAttribute('aria-live', 'polite');
    vscode.postMessage({ command: 'copyText', requestId, text });
  }

  function receiveCopyResult(message) {
    const pending = pendingCopies.get(message.requestId);
    if (!pending) return;
    pendingCopies.delete(message.requestId);
    pending.button.disabled = false;
    pending.button.textContent = message.error ? '重试复制' : '已复制';
    pending.button.title = message.error || '代码已复制到剪贴板';
  }

  function renderTextContent(container, text, markdown, inline, allowMarkdown) {
    const value = typeof text === 'string' ? text : '';
    if (allowMarkdown && renderMarkdown && Array.isArray(markdown) && window.VsChatRichContent) {
      const rich = document.createElement('div');
      rich.className = 'rich-content';
      try {
        const complete = window.VsChatRichContent.render(rich, markdown, { openExternal, copyText });
        if (complete === true && rich.childNodes.length) {
          container.appendChild(rich);
          return;
        }
      } catch {
        // Preserve the original message if a malformed runtime AST cannot render.
      }
    }
    const el = document.createElement(inline ? 'span' : 'div');
    el.className = 'msg-text';
    el.textContent = value;
    container.appendChild(el);
  }

  function attachmentSize(size) {
    if (!Number.isFinite(size) || size < 0) return '';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  function renderAttachment(container, part, msg, partIndex, generation) {
    const scope = viewScope();
    const url = part.type === 5 ? safeExternalUrl(part.url) : undefined;
    const card = document.createElement(url ? 'button' : 'div');
    card.className = 'attachment-card';
    if (url) {
      card.type = 'button';
      card.title = '打开附件';
      card.addEventListener('click', () => openExternal(url));
    }
    const label = document.createElement('span');
    label.className = 'attachment-name';
    label.textContent = `${part.type === 5 ? '[视频]' : '[文件]'} ${part.fileName || ''}`.trim();
    card.appendChild(label);
    const size = attachmentSize(part.size);
    if (size) {
      const detail = document.createElement('span');
      detail.className = 'attachment-detail';
      detail.textContent = size;
      card.appendChild(detail);
    }
    if (part.type === 4) {
      const key = JSON.stringify([scope?.recipientId || '', generation, msg.id, partIndex]);
      card.dataset.attachmentKey = key;
      const available = part.fileAction?.canSave === true && typeof generation === 'string' && Number.isSafeInteger(msg.id);
      if (available) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'attachment-save';
        button.addEventListener('click', () => {
          if (button.disabled || !matchesViewScope(scope || {})) return;
          const currentGeneration = searchContextMessagesContains(card) ? contextGeneration : syncGeneration;
          if (currentGeneration !== generation || attachmentStates.get(key)?.status === 'saving') return;
          const requestId = crypto.randomUUID();
          attachmentStates.set(key, { status: 'saving', requestId });
          pendingAttachments.set(requestId, { key, scope });
          updateAttachmentCards(key);
          postScoped({ command: 'saveAttachment', requestId, targetId: msg.id, partIndex, generation }, scope);
        });
        card.appendChild(button);
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'attachment-cancel';
        cancel.textContent = '取消保存';
        cancel.addEventListener('click', () => {
          const state = attachmentStates.get(key);
          if (state?.status !== 'saving' || state.cancelRequested) return;
          state.cancelRequested = true;
          updateAttachmentCards(key);
          postScoped({ command: 'cancelAttachment', requestId: state.requestId }, scope);
        });
        card.appendChild(cancel);
      }
      const feedback = document.createElement('span');
      feedback.className = 'attachment-status';
      feedback.setAttribute('role', 'status');
      feedback.textContent = available ? '' : part.fileAction?.reason || '此文件暂不支持保存';
      card.appendChild(feedback);
      updateAttachmentCard(card);
    }
    container.appendChild(card);
  }

  function searchContextMessagesContains(target) {
    function contains(node) {
      return node === target || Array.from(node.children).some(contains);
    }
    return contains(searchContextMessages);
  }

  function updateAttachmentCard(card) {
    const button = Array.from(card.children).find(el => el.classList.contains('attachment-save'));
    if (!button) return;
    const state = attachmentStates.get(card.dataset.attachmentKey);
    const status = Array.from(card.children).find(el => el.classList.contains('attachment-status'));
    const cancel = Array.from(card.children).find(el => el.classList.contains('attachment-cancel'));
    button.disabled = state?.status === 'saving';
    button.textContent = state?.status === 'saving' ? '保存中…'
      : state?.status === 'failed' ? '重试保存' : state?.status === 'saved' ? '再次保存…' : '另存为…';
    status.textContent = state?.status === 'failed' ? `保存失败：${state.error || '请重试'}`
      : state?.status === 'saved' ? '已保存' : state?.status === 'cancelled' ? '已取消保存' : '';
    cancel.classList.toggle('hidden', state?.status !== 'saving');
    cancel.disabled = Boolean(state?.cancelRequested);
    cancel.textContent = state?.cancelRequested ? '正在取消…' : '取消保存';
  }

  function updateAttachmentCards(key) {
    function visit(node) {
      if (node.dataset.attachmentKey === key) updateAttachmentCard(node);
      Array.from(node.children).forEach(visit);
    }
    visit(messagesEl);
    visit(searchContextMessages);
  }

  function receiveAttachmentStatus(message) {
    const pending = pendingAttachments.get(message.requestId);
    if (recipientManaged && (!pending?.scope || message.recipientId !== pending.scope.recipientId
      || message.selectionId !== pending.scope.selectionId)) return;
    const key = pending?.key;
    if (!key || attachmentStates.get(key)?.requestId !== message.requestId
      || !['saving', 'saved', 'failed', 'cancelled'].includes(message.fileStatus)) return;
    attachmentStates.set(key, { ...attachmentStates.get(key), status: message.fileStatus, error: message.error, requestId: message.requestId });
    if (message.fileStatus !== 'saving') pendingAttachments.delete(message.requestId);
    updateAttachmentCards(key);
  }

  function renderMessageContent(container, msg, inline, allowMarkdown, generation = syncGeneration) {
    if (Array.isArray(msg.parts) && msg.parts.length) {
      for (const [partIndex, part] of msg.parts.entries()) {
        if (!part || typeof part !== 'object') continue;
        const wrapper = document.createElement('div');
        wrapper.className = 'message-part';
        wrapper.dataset.type = part.type;
        if (part.type === 1) renderTextContent(wrapper, part.text, part.markdown, inline, allowMarkdown);
        else if (part.type === 2) {
          renderImageContent(wrapper, {
            direction: msg.direction, content: part.url || '',
            imageDataUrl: safeImageUrl(part.imageDataUrl) || safeImageUrl(part.url) || part.imageDataUrl,
          });
          if (part.text) renderTextContent(wrapper, part.text, undefined, inline, false);
        }
        else if (part.type === 3) renderVoiceContent(wrapper, { content: part.text || '' }, inline);
        else if (part.type === 4 || part.type === 5) {
          renderAttachment(wrapper, part, msg, partIndex, generation);
          if (part.text) renderTextContent(wrapper, part.text, undefined, inline, false);
        }
        else renderTextContent(wrapper, part.text || '[消息]', undefined, inline, false);
        container.appendChild(wrapper);
      }
      return;
    }
    if (msg.type === 1) renderTextContent(container, msg.content, msg.markdown, inline, allowMarkdown);
    else if (msg.type === 2) renderImageContent(container, msg);
    else if (msg.type === 3) renderVoiceContent(container, msg, inline);
    else if (msg.type === 4) renderAttachment(container, { type: 4, fileName: msg.content }, msg, 0, generation);
    else renderOtherContent(container, msg, inline);
  }

  function renderImageContent(div, msg) {
    const imageUrl = safeImageUrl(msg.imageDataUrl);
    const fallback = safeExternalUrl(msg.imageDataUrl) || safeExternalUrl(msg.content);
    const url = fallback && /^https?:\/\//i.test(fallback) ? fallback : undefined;
    if (imageUrl) {
      const img = document.createElement('img');
      img.className = 'message-image';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = imageUrl;
      img.alt = 'image';
      img.addEventListener('click', () => {
        openLightbox(img.src);
      });
      div.appendChild(img);
    } else if (msg.direction === 'received' || url) {
      const placeholder = document.createElement(url ? 'button' : 'div');
      placeholder.className = 'image-container';
      placeholder.textContent = currentMode === 'chat' ? '[Image]' : '<binary data>';
      if (url) {
        placeholder.type = 'button';
        placeholder.title = '打开图片';
        placeholder.addEventListener('click', () => {
          openExternal(url);
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

  // 语音消息：优先显示微信返回的转写文本；旧记录 content 可能是整段 JSON，
  // 尝试从中提取 voice_item.text。inline 用于 log/git 模式的行内渲染。
  function extractVoiceText(content) {
    if (!content || content === '[语音消息]') return '';
    if (!content.startsWith('{')) return content;
    try {
      const parsed = JSON.parse(content);
      return parsed.voice_item?.text || parsed.voice_item?.transcription || '';
    } catch {
      return '';
    }
  }

  function renderVoiceContent(container, msg, inline) {
    const voiceText = extractVoiceText(msg.content);
    const el = document.createElement(inline ? 'span' : 'div');
    if (inline) el.className = 'msg-text';
    el.textContent = voiceText ? `[语音] ${voiceText}` : '[语音消息]';
    container.appendChild(el);
  }

  function renderOtherContent(container, msg, inline) {
    const url = safeExternalUrl(msg.content);
    const typeLabel = msg.type === 4 ? '文件' : msg.type === 5 ? '视频' : '消息';
    const el = document.createElement(inline ? 'span' : 'div');
    if (inline) el.className = 'msg-text';
    el.textContent = url ? `[${typeLabel}]` : (msg.content || `[${typeLabel}]`);
    if (url) {
      el.classList.add('image-container');
      el.title = '打开附件';
      el.addEventListener('click', () => {
        openExternal(url);
      });
    }
    container.appendChild(el);
  }

  function scrollToBottom() {
    preservedScrollTop = null;
    chatContainer.scrollTop = chatContainer.scrollHeight;
    followingMessages = true;
    readingPosition = null;
    if (!syncGeneration && !document.hidden) unreadCount = 0;
    updateUnread();
    reportRead();
  }

  function isNearBottom() {
    return chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 80;
  }

  function updateUnread() {
    newMessagesBtn.textContent = `有 ${unreadCount} 条新消息 · 回到最新`;
    newMessagesBtn.classList.toggle('hidden', unreadCount === 0);
  }

  function reportRead() {
    if (recipientManaged && (!viewScope() || selectedRecipientId === '__history__')) return;
    if (!syncGeneration || applyingSync || presentationReadSuppressed || searchOpen || dataOpen || !initialHistoryLoaded || !hostFocused
      || document.hidden || chatContainer.classList.contains('hidden')
      || chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight > 2) return;
    const latest = allMessages.at(-1);
    // Imported history is not a new delivery. A tail of restored records must
    // never acknowledge earlier unread deliveries as a side effect of hydration.
    if (latest?.restored) return;
    const throughId = latest?.id;
    if (!Number.isSafeInteger(throughId) || throughId <= Math.max(sharedReadThroughId, lastReadSent)) return;
    lastReadSent = throughId;
    postScoped({ command: 'markRead', generation: syncGeneration, throughId });
  }

  function showChat() {
    loginScreen.classList.add('hidden');
    chatContainer.classList.remove('hidden');
    inputBar.classList.remove('hidden');
  }

  function receiveSync(message) {
    const generation = message.generation;
    if (typeof generation !== 'string' || !generation || retiredGenerations.has(generation)) return;
    if (generation !== syncGeneration && !message.reset) {
      postScoped({ command: 'requestSync' });
      return;
    }
    const changedGeneration = generation !== syncGeneration;
    const savedPosition = pendingReadingRestore?.generation === generation ? pendingReadingRestore : null;
    const position = savedPosition?.position || captureReadingPosition();
    const previousLastId = allMessages.at(-1)?.id || 0;
    const restoredOnlyUpdate = (message.messages || []).some(msg => msg.restored)
      && !(message.messages || []).some(msg => !msg.restored && msg.id > previousLastId);
    const follow = !restoredOnlyUpdate && !dataOpen
      && (savedPosition ? savedPosition.follow : changedGeneration || allMessages.length === 0 || isNearBottom()) && !document.hidden;
    if (changedGeneration) {
      invalidateDataPreviews('聊天记录已变化，请重新预览后再确认。');
      if (activeSearch || completedSearch || pendingContext || contextGeneration) {
        invalidateSearch('聊天记录已变化，请重新搜索或重新打开引用。');
      }
      if (syncGeneration) retiredGenerations.add(syncGeneration);
      syncGeneration = generation;
      sharedReadThroughId = 0;
      lastReadSent = 0;
      readingPosition = null;
    }
    if (message.reset) {
      loadingHistory = false;
      loadMoreHistoryBtn.disabled = false;
      loadMoreHistoryBtn.textContent = '加载更早消息';
    }
    applyingSync = true;
    try {
      // Read progress belongs to the database. Keep its count visible until
      // the host acknowledges this view's rendered range or another window reads it.
      unreadCount = Math.max(0, Number(message.unreadCount) || 0);
      sharedReadThroughId = Math.max(sharedReadThroughId, Number(message.readThroughId) || 0);
      if (typeof message.hasMore === 'boolean') {
        loadMoreHistoryBtn.classList.toggle('hidden', !message.hasMore);
      }
      const incoming = message.messages || [];
      const appendOnly = !message.reset && incoming.every(msg => msg.id > previousLastId);
      const merged = new Map((message.reset ? [] : allMessages).map(msg => [msg.id, msg]));
      for (const msg of incoming) merged.set(msg.id, { ...merged.get(msg.id), ...msg });
      allMessages = [...merged.values()].sort((a, b) => a.id - b.id);
      initialHistoryLoaded = true;
      hasPartner = allMessages.length > 0;
      if (message.reset || incoming.length) {
        showChat();
        if (appendOnly) {
          const fragment = document.createDocumentFragment();
          for (const msg of allMessages) {
            if (msg.id > previousLastId) renderMessage(msg, fragment);
          }
          messagesEl.appendChild(fragment);
          if (follow) scrollToBottom();
          else restoreReadingPosition(position);
        } else {
          reRenderAll(position, follow);
        }
      }
      updateUnread();
      if (recipientManaged) {
        const option = recipients.find(item => item.id === selectedRecipientId);
        if (option) option.unreadCount = unreadCount;
        updateRecipientUI();
      }
    } finally {
      applyingSync = false;
    }
    pendingReadingRestore = null;
    if (revealRecipientAfterSync) {
      revealRecipientAfterSync = false;
      scrollToBottom();
      textInput.focus();
    }
    reportRead();
  }

  function captureReadingPosition() {
    const top = chatContainer.scrollTop;
    const viewportTop = chatContainer.getBoundingClientRect?.().top;
    const anchor = viewportTop === undefined ? null : Array.from(messagesEl.children)
      .find(el => el.dataset.id && el.getBoundingClientRect().bottom > viewportTop);
    return { top, id: anchor?.dataset.id, offset: anchor ? anchor.getBoundingClientRect().top - viewportTop : 0 };
  }

  function restoreReadingPosition(position) {
    const anchor = position?.id && Array.from(messagesEl.children).find(el => el.dataset.id === position.id);
    chatContainer.scrollTop = anchor
      ? chatContainer.scrollTop + anchor.getBoundingClientRect().top - chatContainer.getBoundingClientRect().top - position.offset
      : (position?.top || 0);
    followingMessages = false;
    // A newly prepended row can become partially visible above the preserved
    // message. Keep the original anchor until the user scrolls, so a lazy image
    // in that new row cannot replace the anchor and shift the text being read.
    readingPosition = anchor
      ? { top: chatContainer.scrollTop, id: anchor.dataset.id,
        offset: anchor.getBoundingClientRect().top - chatContainer.getBoundingClientRect().top }
      : captureReadingPosition();
    preservedScrollTop = chatContainer.scrollTop;
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

  function sameMessageValue(left, right) {
    if (left === right) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    if (Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length
      && keys.every(key => Object.prototype.hasOwnProperty.call(right, key) && sameMessageValue(left[key], right[key]));
  }

  function prependHistoryMessages(messages, previousFirst) {
    if (!messages.length) return;
    const tailDate = lastRenderedDate;
    const fragment = document.createDocumentFragment();
    lastRenderedDate = '';
    for (const msg of messages) renderMessage(msg, fragment);
    // A day can straddle two pages. Keep the new group's heading and remove
    // only the duplicated old heading, preserving every existing message node.
    const firstNode = messagesEl.firstElementChild;
    if (getDateKey(messages.at(-1).timestamp) === getDateKey(previousFirst.timestamp)
      && firstNode?.classList.contains('date-separator')) messagesEl.removeChild(firstNode);
    messagesEl.insertBefore(fragment, messagesEl.firstChild);
    lastRenderedDate = tailDate;
  }

  function loadHistory(messages, older, hasMore) {
    const previousHeight = chatContainer.scrollHeight;
    const previousTop = chatContainer.scrollTop;
    const position = captureReadingPosition();
    const followBottom = (allMessages.length === 0 || isNearBottom()) && !document.hidden;
    // A live message can arrive while the host hydrates a history page.
    // Merge by DB id rather than replacing the list with an older snapshot.
    const previousFirst = allMessages[0];
    const existing = new Map(allMessages.map((msg) => [msg.id, msg]));
    const merged = new Map(existing);
    let updatedExisting = false;
    for (const msg of messages) {
      if (!syncGeneration && !older && !followBottom && initialHistoryLoaded
        && !merged.has(msg.id) && msg.direction === 'received') unreadCount += 1;
      const next = { ...merged.get(msg.id), ...msg };
      if (existing.has(msg.id) && !sameMessageValue(existing.get(msg.id), next)) updatedExisting = true;
      merged.set(msg.id, next);
    }
    allMessages = [...merged.values()].sort((a, b) => a.id - b.id);
    const added = allMessages.filter(msg => !existing.has(msg.id));
    const prependOnly = older && previousFirst && !updatedExisting && added.every(msg => msg.id < previousFirst.id);
    if (!older) initialHistoryLoaded = true;
    loadingHistory = false;
    loadMoreHistoryBtn.disabled = false;
    loadMoreHistoryBtn.textContent = '加载更早消息';
    loadMoreHistoryBtn.classList.toggle('hidden', !hasMore);
    if (prependOnly) prependHistoryMessages(added, previousFirst);
    else {
      lastRenderedDate = '';
      const fragment = document.createDocumentFragment();
      for (const msg of allMessages) renderMessage(msg, fragment);
      messagesEl.replaceChildren(fragment);
    }
    if (older) {
      if (position.id) restoreReadingPosition(position);
      else {
        chatContainer.scrollTop = previousTop + chatContainer.scrollHeight - previousHeight;
        followingMessages = false;
        readingPosition = captureReadingPosition();
      }
    } else if (followBottom) {
      scrollToBottom();
    } else {
      restoreReadingPosition(position);
    }
    updateUnread();
  }

  loadMoreHistoryBtn.addEventListener('click', () => {
    if (loadingHistory || !allMessages.length || !viewScope()) return;
    loadingHistory = true;
    loadMoreHistoryBtn.disabled = true;
    loadMoreHistoryBtn.textContent = '加载中…';
    postScoped({ command: 'loadMoreHistory', beforeId: allMessages[0].id,
      ...(syncGeneration ? { generation: syncGeneration } : {}) });
  });

  // Search and reference context have their own rows and cursors. They never
  // replace the live timeline, load its older pages or advance its read cursor.
  function setSearchOpen(open) {
    const position = captureReadingPosition();
    if (open && dataOpen) setDataOpen(false);
    searchOpen = open;
    searchPanel.classList.toggle('hidden', !open);
    document.body.classList.toggle('search-open', open);
    document.getElementById('search-toggle').setAttribute('aria-expanded', String(open));
    updateToolWorkspace();
    restoreReadingPosition(position);
    if (open) searchQuery.focus();
    else {
      const cancelledSearch = Boolean(activeSearch);
      const cancelledContext = Boolean(pendingContext);
      activeSearch = null;
      pendingContext = null;
      searchSubmit.disabled = false;
      searchMore.disabled = false;
      if (cancelledContext) showSearchResults();
      if (cancelledSearch) searchStatus.textContent = '搜索已取消，可重新搜索或继续加载结果。';
      else if (cancelledContext) searchStatus.textContent = '上下文读取已取消，可重新选择消息。';
      textInput.focus();
    }
  }

  function showSearchResults() {
    pendingContext = null;
    contextGeneration = null;
    contextSnapshot = null;
    searchContext.classList.add('hidden');
    searchContextMessages.innerHTML = '';
    searchResults.classList.remove('hidden');
    searchMore.classList.toggle('hidden', !searchHasMore);
    searchStatus.textContent = searchResultSummary();
  }

  function searchResultSummary() {
    if (!completedSearch) return '输入关键词或选择条件后点击搜索。';
    return searchRows.length
      ? `已显示 ${searchRows.length} 条结果${searchHasMore ? '，可继续加载更早结果' : ''}`
      : '没有找到符合条件的消息。';
  }

  function invalidateSearch(reason) {
    activeSearch = null;
    completedSearch = null;
    searchRows = [];
    searchHasMore = false;
    searchResults.innerHTML = '';
    showSearchResults();
    searchSubmit.disabled = false;
    searchMore.disabled = false;
    searchStatus.textContent = reason;
  }

  function dateBoundary(value, nextDay) {
    if (!value) return undefined;
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!parts) throw new Error('请输入有效日期。');
    const [, year, month, day] = parts.map(Number);
    const date = new Date(0);
    date.setFullYear(year, month - 1, day);
    date.setHours(0, 0, 0, 0);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      throw new Error('请输入有效日期。');
    }
    // Advancing the calendar date, rather than adding 86400 seconds, handles
    // local daylight-saving transitions at either end of the selected day.
    if (nextDay) date.setDate(date.getDate() + 1);
    return Math.floor(date.getTime() / 1000);
  }

  // Local data operations run one at a time. Only the host sees selected paths;
  // previews carry opaque identifiers and require a separate confirmation.
  function dataOperationLabel(operation) {
    return { export: '导出', backup: '备份', restorePreview: '读取恢复预览', restoreConfirm: '追加恢复',
      storage: '统计容量', cleanupPreview: '预览旧缓存', cleanupConfirm: '隔离旧缓存' }[operation] || '操作';
  }

  function updateDataControls() {
    const busy = Boolean(activeData);
    for (const id of dataActionIds) document.getElementById(id).disabled = busy;
    dataFrom.disabled = busy;
    dataTo.disabled = busy;
    document.getElementById('backup-images').disabled = busy;
    restoreConfirmBtn.disabled = busy || !restorePreview || restorePreview.generation !== syncGeneration;
    cleanupConfirmBtn.disabled = busy || !cleanupPreview || cleanupPreview.generation !== syncGeneration;
    restoreConfirmBtn.classList.toggle('hidden', !restorePreview);
    cleanupConfirmBtn.classList.toggle('hidden', !cleanupPreview);
    restorePreviewEl.classList.toggle('hidden', !restorePreviewEl.textContent);
    cleanupSummary.classList.toggle('hidden', !cleanupSummary.textContent);
    dataPanel.setAttribute('aria-busy', String(busy));
  }

  function dismissDataPreview(previewId) {
    if (typeof previewId === 'string' && previewId) {
      vscode.postMessage({ command: 'dataDismissPreview', requestId: crypto.randomUUID(), previewId });
    }
  }

  function invalidateDataPreviews(reason = '') {
    const hadPreview = Boolean(restorePreview || cleanupPreview
      || activeData?.operation === 'restorePreview' || activeData?.operation === 'cleanupPreview');
    dismissDataPreview(restorePreview?.previewId);
    dismissDataPreview(cleanupPreview?.previewId);
    restorePreview = null;
    cleanupPreview = null;
    dataPreviewRevision += 1;
    if (hadPreview) {
      restorePreviewEl.textContent = '';
      cleanupSummary.textContent = '';
      if (reason) dataStatus.textContent = reason;
    }
    updateDataControls();
  }

  function setDataOpen(open) {
    if (dataOpen === open) return;
    const position = captureReadingPosition();
    if (open && searchOpen) setSearchOpen(false);
    dataOpen = open;
    dataPanel.classList.toggle('hidden', !open);
    document.body.classList.toggle('data-open', open);
    document.getElementById('data-toggle').setAttribute('aria-expanded', String(open));
    updateToolWorkspace();
    if (!open) invalidateDataPreviews('预览已关闭，请重新预览后再确认。');
    restoreReadingPosition(position);
    if (open) document.getElementById('data-close').focus();
    else textInput.focus();
  }

  function updateToolWorkspace() {
    // Covered messages retain their layout/reading anchor, but cannot receive
    // keyboard focus or be announced behind the active tool.
    const covered = searchOpen || dataOpen;
    chatContainer.inert = covered;
    if (covered) chatContainer.setAttribute('aria-hidden', 'true');
    else chatContainer.removeAttribute('aria-hidden');
  }

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
    const pickers = ['recipient-picker', 'connection-picker'].map(id => document.getElementById(id));
    if (pickers.some(picker => picker.open)) {
      pickers.forEach(picker => { picker.open = false; });
      event.preventDefault();
      textInput.focus();
      return;
    }
    if (dataOpen) { event.preventDefault(); setDataOpen(false); }
    else if (searchOpen) { event.preventDefault(); setSearchOpen(false); }
  });

  function startDataOperation(operation, command, details = {}) {
    if (activeData) return;
    if (operation === 'restorePreview' || operation === 'cleanupPreview') {
      invalidateDataPreviews();
      restorePreviewEl.textContent = '';
      cleanupSummary.textContent = '';
    }
    const requestId = crypto.randomUUID();
    activeData = { requestId, operation, revision: dataPreviewRevision, generation: syncGeneration };
    dataStatus.textContent = `${dataOperationLabel(operation)}中…关闭面板不会中断已提交的操作。`;
    updateDataControls();
    vscode.postMessage({ command, requestId, ...details });
  }

  function exportData(format) {
    if (activeData) return;
    try {
      const fromTimestamp = dateBoundary(dataFrom.value, false);
      const toTimestamp = dateBoundary(dataTo.value, true);
      if (fromTimestamp !== undefined && toTimestamp !== undefined && fromTimestamp >= toTimestamp) {
        throw new Error('开始日期不能晚于结束日期。');
      }
      startDataOperation('export', 'dataExport', { format,
        ...(fromTimestamp === undefined ? {} : { fromTimestamp }),
        ...(toTimestamp === undefined ? {} : { toTimestamp }) });
    } catch (error) {
      dataStatus.textContent = error.message || '请检查导出日期。';
    }
  }

  function confirmDataPreview(kind) {
    if (activeData) return;
    const selected = kind === 'restore' ? restorePreview : cleanupPreview;
    if (!selected || selected.generation !== syncGeneration) {
      invalidateDataPreviews('预览已失效，请重新预览后再确认。');
      return;
    }
    // Consume the token before submitting; a failure requires a fresh preview.
    if (kind === 'restore') restorePreview = null;
    else cleanupPreview = null;
    startDataOperation(kind === 'restore' ? 'restoreConfirm' : 'cleanupConfirm',
      kind === 'restore' ? 'dataRestoreConfirm' : 'dataCleanupConfirm', { previewId: selected.previewId });
  }

  function dataSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
    return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  }

  function validDataSummary(operation, data) {
    const required = {
      export: ['messageCount', 'bytes'],
      backup: ['messageCount', 'imageCount', 'missingImages', 'skippedImages', 'bytes'],
      restorePreview: ['messageCount', 'imageCount', 'imageBytes', 'newCount', 'duplicateCount', 'conflictCount'],
      restoreConfirm: ['inserted', 'skipped', 'conflicts', 'imagesRestored', 'imagesExisting', 'imagesFailed'],
      storage: ['databaseBytes', 'cacheBytes', 'draftBytes', 'temporaryBytes', 'quarantineBytes', 'otherBytes', 'totalBytes', 'fileCount'],
      cleanupPreview: ['count', 'bytes'],
      cleanupConfirm: ['moved', 'skipped', 'failed', 'bytes'],
    }[operation];
    return data && typeof data === 'object' && required
      && required.every(key => Number.isFinite(data[key]) && data[key] >= 0);
  }

  function restoreDateRange(data) {
    const from = Number.isFinite(data.fromTimestamp) ? new Date(data.fromTimestamp * 1000).toLocaleDateString() : '未知';
    const to = Number.isFinite(data.toTimestamp) ? new Date(data.toTimestamp * 1000).toLocaleDateString() : '未知';
    return `日期：${from} 至 ${to}`;
  }

  function receiveDataResult(message) {
    if (!activeData || message.requestId !== activeData.requestId || message.operation !== activeData.operation) return;
    const pending = activeData;
    activeData = null;
    const label = dataOperationLabel(pending.operation);
    const isPreview = pending.operation === 'restorePreview' || pending.operation === 'cleanupPreview';
    if (message.error || message.cancelled) {
      if (isPreview) dismissDataPreview(message.previewId);
      dataStatus.textContent = message.error ? `${label}失败：${message.error}` : `已取消${label}。`;
      updateDataControls();
      return;
    }
    if (!validDataSummary(pending.operation, message.data)) {
      if (isPreview) dismissDataPreview(message.previewId);
      dataStatus.textContent = `${label}未返回有效结果，无法确认完成；请重新检查。`;
      updateDataControls();
      return;
    }
    const data = message.data;
    if (isPreview && (!dataOpen || pending.revision !== dataPreviewRevision
      || typeof message.previewId !== 'string' || !message.previewId
      || typeof message.generation !== 'string' || message.generation !== syncGeneration
      || pending.generation !== syncGeneration)) {
      dismissDataPreview(message.previewId);
      dataStatus.textContent = '预览已失效或已关闭，请重新预览后再确认。';
      updateDataControls();
      return;
    }
    switch (pending.operation) {
      case 'export':
        dataStatus.textContent = `已导出 ${data.messageCount} 条消息，${dataSize(data.bytes)}。`;
        break;
      case 'backup':
        dataStatus.textContent = `备份完成：${data.messageCount} 条消息、${data.imageCount} 张图片，${dataSize(data.bytes)}。缺失图片 ${data.missingImages} 张，跳过 ${data.skippedImages} 张。`;
        break;
      case 'restorePreview':
        restorePreview = { previewId: message.previewId, generation: message.generation };
        restorePreviewEl.textContent = `备份包含 ${data.messageCount} 条消息、${data.imageCount} 张图片（${dataSize(data.imageBytes)}）。\n${restoreDateRange(data)}\n可追加 ${data.newCount} 条，重复 ${data.duplicateCount} 条，冲突 ${data.conflictCount} 条。\n确认后仅追加；重复和冲突记录跳过，不覆盖现有记录，不恢复登录信息。`;
        dataStatus.textContent = '请检查恢复预览，点击“确认追加恢复”后才会写入当前通道。';
        break;
      case 'restoreConfirm':
        dataStatus.textContent = `追加恢复完成${data.imagesFailed ? '，部分图片未恢复' : ''}：新增 ${data.inserted} 条，跳过 ${data.skipped} 条，冲突 ${data.conflicts} 条。图片恢复 ${data.imagesRestored} 张，已存在 ${data.imagesExisting} 张，失败 ${data.imagesFailed} 张。`;
        if (data.refreshPending === true) {
          dataStatus.textContent += '\n恢复数据已保存，聊天列表暂未刷新，请稍后刷新或重新打开视图；无需重复导入。';
        }
        restorePreviewEl.textContent = dataStatus.textContent;
        break;
      case 'storage':
        storageSummary.textContent = `总计 ${dataSize(data.totalBytes)}，${data.fileCount} 个文件。\n聊天数据库 ${dataSize(data.databaseBytes)}；媒体缓存 ${dataSize(data.cacheBytes)}；文件草稿 ${dataSize(data.draftBytes)}。\n临时文件 ${dataSize(data.temporaryBytes)}；隔离保留目录 ${dataSize(data.quarantineBytes)}；其他 ${dataSize(data.otherBytes)}。`;
        dataStatus.textContent = '容量统计已更新。隔离旧缓存会保留文件，不释放磁盘空间。';
        break;
      case 'cleanupPreview':
        cleanupPreview = { previewId: message.previewId, generation: message.generation };
        cleanupSummary.textContent = `将隔离 ${data.count} 个旧缓存文件，共 ${dataSize(data.bytes)}。\n文件移入保留目录，不删除任何数据，不释放磁盘空间；聊天记录、草稿和登录凭据保持不变。`;
        dataStatus.textContent = '请检查预览，点击“确认移入保留目录”后才会移动文件。';
        break;
      case 'cleanupConfirm':
        dataStatus.textContent = `缓存隔离完成${data.failed ? '（部分失败）' : ''}：移入保留目录 ${data.moved} 个（${dataSize(data.bytes)}），跳过 ${data.skipped} 个，失败 ${data.failed} 个。文件仍保留，未释放磁盘空间。`;
        cleanupSummary.textContent = dataStatus.textContent;
        break;
    }
    updateDataControls();
  }

  document.getElementById('data-toggle').addEventListener('click', () => setDataOpen(!dataOpen));
  document.getElementById('data-close').addEventListener('click', () => setDataOpen(false));
  document.getElementById('export-markdown').addEventListener('click', () => exportData('markdown'));
  document.getElementById('export-json').addEventListener('click', () => exportData('json'));
  document.getElementById('backup-create').addEventListener('click', () => startDataOperation('backup', 'dataBackup', {
    includeImages: document.getElementById('backup-images').checked === true,
  }));
  document.getElementById('restore-select').addEventListener('click', () => startDataOperation('restorePreview', 'dataRestorePreview'));
  restoreConfirmBtn.addEventListener('click', () => confirmDataPreview('restore'));
  document.getElementById('storage-refresh').addEventListener('click', () => startDataOperation('storage', 'dataStorage'));
  document.getElementById('cleanup-preview').addEventListener('click', () => startDataOperation('cleanupPreview', 'dataCleanupPreview'));
  cleanupConfirmBtn.addEventListener('click', () => confirmDataPreview('cleanup'));

  function searchFilters() {
    const query = searchQuery.value.trim();
    if (query.length > 200) throw new Error('关键词最多 200 个字符。');
    const type = searchType.value && searchType.value !== 'all' ? Number(searchType.value) : undefined;
    if (type !== undefined && ![1, 2, 3, 4, 5].includes(type)) throw new Error('请选择有效的消息类型。');
    const fromTimestamp = dateBoundary(searchFrom.value, false);
    const toTimestamp = dateBoundary(searchTo.value, true);
    if (fromTimestamp !== undefined && toTimestamp !== undefined && fromTimestamp >= toTimestamp) {
      throw new Error('开始日期不能晚于结束日期。');
    }
    return { query, ...(type === undefined ? {} : { type }),
      ...(fromTimestamp === undefined ? {} : { fromTimestamp }),
      ...(toTimestamp === undefined ? {} : { toTimestamp }) };
  }

  function submitSearch(older = false) {
    if (!viewScope()) {
      searchStatus.textContent = '请先选择联系人或只读历史。';
      return;
    }
    if (activeSearch || (older && (!completedSearch || !searchHasMore || !searchRows.length))) return;
    let filters;
    try {
      filters = older ? completedSearch.filters : searchFilters();
    } catch (error) {
      invalidateSearch(error.message);
      return;
    }
    showSearchResults();
    if (!older) {
      searchRows = [];
      searchResults.innerHTML = '';
      completedSearch = null;
      searchHasMore = false;
      searchMore.classList.add('hidden');
    }
    const requestId = crypto.randomUUID();
    const generation = older ? completedSearch.generation : syncGeneration;
    const beforeId = older ? searchRows[searchRows.length - 1].id : undefined;
    activeSearch = { requestId, generation, filters, older };
    searchSubmit.disabled = true;
    searchMore.disabled = true;
    searchStatus.textContent = '正在搜索历史记录…';
    postScoped({ command: 'searchHistory', requestId, ...filters,
      ...(beforeId === undefined ? {} : { beforeId }), ...(generation ? { generation } : {}) });
  }

  function compatibleSearchGeneration(generation, requested) {
    return typeof generation === 'string' && generation && !retiredGenerations.has(generation)
      && (!requested || requested === generation) && (!syncGeneration || syncGeneration === generation);
  }

  function appendLiteralHighlight(parent, text, query) {
    let start = 0;
    const needle = foldSearchText(query);
    const haystack = foldSearchText(text);
    while (needle) {
      const index = haystack.indexOf(needle, start);
      if (index < 0) break;
      const prefix = document.createElement('span');
      prefix.textContent = text.slice(start, index);
      parent.appendChild(prefix);
      const mark = document.createElement('mark');
      mark.textContent = text.slice(index, index + query.length);
      parent.appendChild(mark);
      start = index + query.length;
    }
    const suffix = document.createElement('span');
    suffix.textContent = text.slice(start);
    parent.appendChild(suffix);
  }

  function foldSearchText(text) {
    // SQLite's default case folding is ASCII-only. Keep UTF-16 offsets stable
    // so characters whose Unicode lowercase expands cannot shift highlights.
    return text.replace(/[A-Z]/g, character => character.toLowerCase());
  }

  function messageMetadata(msg) {
    const type = { 1: '文字', 2: '图片', 3: '语音', 4: '文件', 5: '视频' }[msg.type] || '消息';
    return `${msg.direction === 'sent' ? '我' : '对方'} · ${type} · ${new Date(msg.timestamp * 1000).toLocaleString()}`;
  }

  function renderSearchResults() {
    searchResults.innerHTML = '';
    for (const msg of searchRows) {
      const result = document.createElement('button');
      result.type = 'button';
      result.className = 'search-result';
      result.dataset.id = msg.id;
      result.title = '查看消息上下文';
      const meta = document.createElement('span');
      meta.className = 'search-result-meta';
      meta.textContent = messageMetadata(msg);
      result.appendChild(meta);
      const snippet = document.createElement('span');
      snippet.className = 'search-result-snippet';
      const content = String(msg.content || '');
      const query = completedSearch?.filters.query || '';
      const hit = query ? foldSearchText(content).indexOf(foldSearchText(query)) : 0;
      const start = Math.max(0, hit - 50);
      const text = (start ? '…' : '') + content.slice(start, start + 160) + (content.length > start + 160 ? '…' : '');
      appendLiteralHighlight(snippet, text, query);
      result.appendChild(snippet);
      result.addEventListener('click', () => requestMessageContext({ targetId: msg.id }));
      searchResults.appendChild(result);
    }
  }

  function receiveSearchResults(message) {
    if (!activeSearch || message.requestId !== activeSearch.requestId) return;
    if (!compatibleSearchGeneration(message.generation, activeSearch.generation)) {
      invalidateSearch('聊天记录已变化，请重新搜索。');
      return;
    }
    completedSearch = { filters: activeSearch.filters, generation: message.generation };
    const merged = new Map((activeSearch.older ? searchRows : []).map(msg => [msg.id, msg]));
    for (const msg of message.messages || []) merged.set(msg.id, msg);
    searchRows = [...merged.values()].sort((a, b) => b.id - a.id);
    searchHasMore = Boolean(message.hasMore);
    activeSearch = null;
    searchSubmit.disabled = false;
    searchMore.disabled = false;
    searchMore.classList.toggle('hidden', !searchHasMore);
    searchStatus.textContent = searchResultSummary();
    renderSearchResults();
  }

  function requestMessageContext(target) {
    if (!viewScope()) return;
    if (!searchOpen) setSearchOpen(true);
    activeSearch = null;
    searchSubmit.disabled = false;
    searchMore.disabled = false;
    searchStatus.textContent = searchResultSummary();
    const requestId = crypto.randomUUID();
    const generation = completedSearch?.generation || syncGeneration;
    pendingContext = { requestId, generation };
    contextGeneration = null;
    contextSnapshot = null;
    searchContextMessages.innerHTML = '';
    searchContext.classList.remove('hidden');
    searchResults.classList.add('hidden');
    searchMore.classList.add('hidden');
    searchContextTitle.textContent = '正在读取消息上下文…';
    postScoped({ command: 'loadMessageContext', requestId, ...target,
      ...(generation ? { generation } : {}) });
  }

  function receiveMessageContext(message) {
    if (!pendingContext || message.requestId !== pendingContext.requestId) return;
    if (!compatibleSearchGeneration(message.generation, pendingContext.generation)) {
      invalidateSearch('聊天记录已变化，请重新搜索或重新打开引用。');
      return;
    }
    pendingContext = null;
    contextGeneration = message.generation;
    contextSnapshot = message;
    renderContextRows(message, true);
  }

  function renderContextRows(message, focusTarget) {
    searchContextMessages.innerHTML = '';
    const messages = [...(message.messages || [])].sort((a, b) => a.id - b.id);
    const index = messages.findIndex(msg => msg.id === message.targetId);
    const start = Math.max(0, Math.min(index - 10, messages.length - 21));
    let target;
    for (const msg of messages.slice(start, start + 21)) {
      const row = document.createElement('div');
      row.className = 'search-context-message';
      row.dataset.id = msg.id;
      const meta = document.createElement('div');
      meta.className = 'search-context-meta';
      meta.textContent = messageMetadata(msg);
      row.appendChild(meta);
      const content = document.createElement('div');
      content.className = 'search-context-text';
      renderMessageContent(content, msg, false, true, contextGeneration);
      row.appendChild(content);
      if (msg.id === message.targetId) {
        row.classList.add('search-context-target');
        row.setAttribute('tabindex', '-1');
        target = row;
      }
      searchContextMessages.appendChild(row);
    }
    searchContextTitle.textContent = `消息上下文 · ${Math.min(messages.length, 21)} 条${message.hasBefore || message.hasAfter ? '（前后还有其他历史）' : ''}`;
    if (target && focusTarget) {
      target.scrollIntoView({ block: 'center' });
      target.focus({ preventScroll: true });
    }
  }

  function updateMarkdownPresentation(enabled) {
    if (renderMarkdown === enabled) return;
    const position = captureReadingPosition();
    const follow = isNearBottom() && !document.hidden;
    const previousUnread = unreadCount;
    const contextTop = searchPanel.scrollTop;
    const contextViewportTop = searchPanel.getBoundingClientRect().top;
    const anchor = Array.from(searchContextMessages.children)
      .find(row => row.getBoundingClientRect().bottom > contextViewportTop);
    const anchorId = anchor?.dataset.id;
    const anchorOffset = anchor ? anchor.getBoundingClientRect().top - contextViewportTop : 0;
    renderMarkdown = enabled;
    presentationReadSuppressed = true;
    const change = ++presentationChange;
    reRenderAll(position, follow);
    if (contextSnapshot) {
      renderContextRows(contextSnapshot, false);
      const restored = Array.from(searchContextMessages.children).find(row => row.dataset.id === anchorId);
      searchPanel.scrollTop = restored
        ? searchPanel.scrollTop + restored.getBoundingClientRect().top - searchPanel.getBoundingClientRect().top - anchorOffset
        : contextTop;
    }
    unreadCount = previousUnread;
    updateUnread();
    // Layout and programmatic scroll events from a presentation-only change
    // must not turn an unread message into a read message.
    const release = () => { if (change === presentationChange) presentationReadSuppressed = false; };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(release));
    else setTimeout(release, 0);
  }

  document.getElementById('search-toggle').addEventListener('click', () => setSearchOpen(!searchOpen));
  document.getElementById('search-close').addEventListener('click', () => setSearchOpen(false));
  document.getElementById('search-form').addEventListener('submit', event => {
    event.preventDefault();
    submitSearch();
  });
  searchMore.addEventListener('click', () => submitSearch(true));
  document.getElementById('search-context-back').addEventListener('click', showSearchResults);
  for (const control of [searchQuery, searchType, searchFrom, searchTo]) {
    for (const event of ['input', 'change']) {
      control.addEventListener(event, () => invalidateSearch('搜索条件已修改，请点击搜索。'));
    }
  }

  // ---- Events ----

  function fileLimit() {
    return Number.isFinite(fileCapabilities.maxBytes) && fileCapabilities.maxBytes > 0
      ? Math.min(MAX_FILE_BYTES, fileCapabilities.maxBytes) : MAX_FILE_BYTES;
  }

  function fileLimitLabel() {
    return `${fileLimit() / (1024 * 1024)} MiB`;
  }

  function canSendFile() {
    return Boolean(pendingFile?.valid && fileCapabilities.canSend
      && Number.isFinite(pendingFile.size) && pendingFile.size >= 0 && pendingFile.size <= fileLimit());
  }

  function showFileDraft() {
    fileDraftBar.classList.toggle('hidden', !pendingFile);
    if (!pendingFile) {
      fileDraftName.textContent = '';
      fileDraftStatus.textContent = '';
      return;
    }
    fileDraftName.textContent = `${pendingFile.fileName} · ${attachmentSize(pendingFile.size)}`;
    fileDraftStatus.textContent = pendingFile.checking ? '正在检查文件草稿…'
      : !pendingFile.valid ? `${pendingFile.error || '文件草稿已失效'}，请重新选择`
      : !fileCapabilities.canSend ? fileCapabilities.reason || '当前通道不支持发送文件'
      : pendingFile.size > fileLimit() ? `文件超过 ${fileLimitLabel()} 限额，请重新选择`
      : '待发送 · 文字将保留';
  }

  function clearFileDraft(release = true) {
    if (pendingFile && release) postScoped({ command: 'removeFileDraft', fileId: pendingFile.fileId });
    pendingFile = null;
    showFileDraft();
    persistDraft();
    updateComposer();
  }

  function imageMime(file) {
    if (/^image\/(png|jpeg|gif|webp|bmp)$/i.test(file.type)) return file.type;
    if (file.type && file.type !== 'application/octet-stream') return null;
    const extension = (file.name || '').split('.').pop().toLowerCase();
    return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }[extension] || null;
  }

  function stageAttachment(file) {
    if (!currentChannel || !recipientCanEdit() || activeSend?.status === 'sending' || activeFileSelection || pendingImageRead) return;
    if (imageMime(file)) { stageImage(file); return; }
    if (!fileCapabilities.canSend || !file.size || file.size > fileLimit()) {
      lastSendLabel = !fileCapabilities.canSend ? fileCapabilities.reason || '当前通道不支持文件发送'
        : `请选择非空且不超过 ${fileLimitLabel()} 的文件`;
      updateComposer();
      return;
    }
    textInput.focus();
    const requestId = crypto.randomUUID();
    const scope = viewScope();
    activeFileSelection = { requestId, channel: currentChannel };
    pendingFileSelectionScopes.set(requestId, scope);
    fileSelectionLabel = '正在读取附件…';
    updateComposer();
    const reader = new FileReader();
    reader.onload = () => {
      if (activeFileSelection?.requestId !== requestId || !matchesViewScope(scope || {})) {
        pendingFileSelectionScopes.delete(requestId);
        return;
      }
      fileSelectionLabel = '正在准备附件…';
      updateComposer();
      postScoped({ command: 'stageFile', requestId, fileData: reader.result, fileName: file.name }, scope);
    };
    reader.onerror = () => receiveFileSelected({ command: 'fileSelected', requestId, ...scope, error: '无法读取附件，请重新选择' });
    reader.readAsDataURL(file);
  }
  fileDraftCancel.addEventListener('click', () => {
    if (activeSend?.status === 'sending' || !recipientCanEdit()) return;
    clearFileDraft();
  });

  function receiveFileSelected(message) {
    const scope = pendingFileSelectionScopes.get(message.requestId);
    if (!pendingFileSelectionScopes.has(message.requestId)) return;
    if (recipientManaged && (message.recipientId !== scope?.recipientId || message.selectionId !== scope?.selectionId)) return;
    pendingFileSelectionScopes.delete(message.requestId);
    if (!matchesViewScope(message)) {
      if (message.fileDraft?.fileId) postScoped({ command: 'removeFileDraft', fileId: message.fileDraft.fileId }, scope);
      if (activeFileSelection?.requestId === message.requestId) activeFileSelection = null;
      return;
    }
    if (!activeFileSelection || message.requestId !== activeFileSelection.requestId) return;
    activeFileSelection = null;
    fileSelectionLabel = message.error ? `选择文件失败：${message.error}` : '';
    const draft = message.fileDraft;
    if (!message.cancelled && !message.error && draft && typeof draft.fileId === 'string'
      && typeof draft.fileName === 'string' && Number.isFinite(draft.size) && draft.size >= 0) {
      // Only a successful native selection replaces an existing attachment.
      if (pendingFile?.fileId !== draft.fileId) clearFileDraft();
      clearImageDraft();
      pendingFile = { fileId: draft.fileId, fileName: draft.fileName, size: draft.size, valid: true, checking: false };
      lastSendLabel = '';
    }
    persistDraft();
    updateComposer();
  }

  function receiveFileDraftStatus(message) {
    if (!pendingFile || message.fileId !== pendingFile.fileId) return;
    pendingFile.valid = message.valid === true;
    pendingFile.checking = false;
    pendingFile.error = message.error;
    // Validation never changes the outcome of a previously submitted request.
    persistDraft();
    updateComposer();
  }

  function clearImageDraft() {
    pendingImageRead = null;
    pendingImage = null;
    showImageDraft();
    persistDraft();
    updateComposer();
  }

  function showImageDraft() {
    if (pendingImage?.imageData) {
      draftBar.classList.remove('hidden');
      preview.src = pendingImage.imageData;
      preview.classList.remove('hidden');
      status.textContent = `${pendingImage.fileName} · 待发送`;
      status.title = `${sendShortcut === 'ctrlEnter' ? 'Ctrl/Cmd+Enter' : 'Enter'} 发送；文字和引用保留为独立草稿`;
      return;
    }
    draftBar.classList.add('hidden');
    preview.removeAttribute('src');
    preview.classList.add('hidden');
  }

  document.getElementById('paste-cancel').addEventListener('click', clearImageDraft);
  textInput.addEventListener('paste', (event) => {
    const data = event.clipboardData;
    const file = Array.from(data?.items || [])
      .find(item => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile()
      || Array.from(data?.files || []).find(file => file.type.startsWith('image/'));
    if (!file) return; // Let the browser paste normal text into the input.
    event.preventDefault();
    stageImage(file);
  });

  // Capture before VS Code's webview drop handler can open the file in an editor.
  const isFileDrag = event => Array.from(event.dataTransfer?.types || []).some(type =>
    ['files', 'resourceurls', 'codefiles', 'text/uri-list'].includes(type.toLowerCase()))
    || Boolean(event.dataTransfer?.files?.length)
    || Array.from(event.dataTransfer?.items || []).some(item => item.kind === 'file');
  function handleAttachmentDrag(event) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const allowed = !searchOpen && !dataOpen && currentChannel && recipientCanEdit()
      && activeSend?.status !== 'sending' && !activeFileSelection && !pendingImageRead;
    if (event.dataTransfer) event.dataTransfer.dropEffect = allowed ? 'copy' : 'none';
    inputBar.classList.toggle('drag-over', Boolean(allowed));
  }
  // VS Code starts its editor drop overlay on dragenter, before dragover.
  // Claim both events in capture phase so the overlay cannot swallow our drop.
  window.addEventListener('dragenter', handleAttachmentDrag, true);
  window.addEventListener('dragover', handleAttachmentDrag, true);
  window.addEventListener('dragleave', event => {
    if (!event.relatedTarget) inputBar.classList.remove('drag-over');
  });
  window.addEventListener('drop', event => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    inputBar.classList.remove('drag-over');
    if (searchOpen || dataOpen || !currentChannel || !recipientCanEdit() || activeSend?.status === 'sending') return;
    let files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) files = Array.from(event.dataTransfer?.items || [])
      .filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
    if (files.length !== 1) {
      lastSendLabel = files.length ? '请一次添加一个附件。' : '未取得文件内容，请点击回形针从本机选择；远程编辑器路径不能直接作为附件。';
      updateComposer();
      return;
    }
    stageAttachment(files[0]);
  }, true);

  function stageImage(file) {
    if (!currentChannel || !recipientCanEdit() || activeSend?.status === 'sending') return;
    const scope = viewScope();
    draftBar.classList.remove('hidden');
    if (!imageMime(file) || !file.size || file.size > 10 * 1024 * 1024) {
      status.textContent = '请选择不超过 10 MB 的 PNG、JPEG、GIF、WebP 或 BMP 图片';
      return;
    }
    textInput.focus();
    const draft = { id: crypto.randomUUID(), fileName: file.name || 'clipboard.' + file.type.split('/')[1], imageData: null };
    pendingImageRead = draft;
    updateComposer();
    status.textContent = '正在读取图片…';
    const reader = new FileReader();
    reader.onload = () => {
      if (pendingImageRead !== draft || !matchesViewScope(scope || {})) return;
      pendingImageRead = null;
      draft.imageData = reader.result;
      clearFileDraft();
      pendingImage = draft;
      showImageDraft();
      persistDraft();
      updateComposer();
    };
    reader.onerror = () => {
      if (pendingImageRead !== draft || !matchesViewScope(scope || {})) return;
      pendingImageRead = null;
      status.textContent = '图片读取失败，请重新粘贴';
      updateComposer();
    };
    reader.readAsDataURL(file.type === imageMime(file) ? file : file.slice(0, file.size, imageMime(file)));
  }

  function sendDraft() {
    if (!currentChannel || !recipientCanSend() || activeSend || activeFileSelection || pendingImageRead) return;
    const scope = viewScope();
    const requestId = crypto.randomUUID();
    let payload;
    if (pendingFile) {
      if (!canSendFile()) return;
      activeSend = { requestId, kind: 'file', fileId: pendingFile.fileId, status: 'sending' };
      payload = { command: 'sendFile', fileId: pendingFile.fileId };
    } else if (pendingImage) {
      if (!pendingImage.imageData) return;
      activeSend = { requestId, kind: 'image', imageId: pendingImage.id, status: 'sending' };
      payload = { command: 'sendImage', imageData: pendingImage.imageData, fileName: pendingImage.fileName };
    } else {
      const text = textInput.value;
      if (!text.trim()) return;
      activeSend = { requestId, kind: 'text', text, quote: quoteTarget, status: 'sending' };
      payload = { command: 'sendMessage', text, replyTo: quoteTarget || undefined };
    }
    activeSend = { ...activeSend, ...scope };
    persistDraft();
    updateComposer();
    postScoped({ ...payload, requestId }, scope);
  }

  sendBtn.addEventListener('click', sendDraft);
  retrySendBtn.addEventListener('click', () => {
    if (!activeSend || activeSend.status === 'sending' || !recipientCanSend()
      || (recipientManaged && activeSend.recipientId !== selectedRecipientId)) return;
    if (activeFileSelection || pendingImageRead || (pendingFile && !canSendFile())
      || (!pendingFile && !pendingImage?.imageData && !textInput.value.trim())) return;
    // A retry is a new, explicit user action. Unknown outcomes are never
    // retried automatically and the button explains the duplicate risk.
    activeSend = null;
    sendDraft();
    persistDraft();
    updateComposer();
  });
  confirmSendBtn.addEventListener('click', () => {
    if (activeSend?.status !== 'uncertain' || !recipientCanEdit()
      || (recipientManaged && activeSend.recipientId !== selectedRecipientId)) return;
    receiveSendStatus({ requestId: activeSend.requestId, sendStatus: 'sent', ...viewScope() });
    lastSendLabel = '已确认对方收到';
    updateComposer();
  });

  function receiveSendStatus(message) {
    if (recipientManaged && (message.recipientId !== selectedRecipientId || !activeSend
      || activeSend.requestId !== message.requestId)) {
      receiveBackgroundSendStatus(message);
      return;
    }
    if (!activeSend || message.requestId !== activeSend.requestId) return;
    if (message.sendStatus === 'sent') {
      const sent = activeSend;
      activeSend = null;
      if (sent.kind === 'image') {
        if (pendingImage?.id === sent.imageId) clearImageDraft();
      } else if (sent.kind === 'file') {
        if (pendingFile?.fileId === sent.fileId) clearFileDraft(false);
      } else if (textInput.value === sent.text && JSON.stringify(quoteTarget) === JSON.stringify(sent.quote)) {
        textInput.value = '';
        clearQuote();
      }
      lastSendLabel = '已发送' + (message.warning ? ` · ${message.warning}` : '');
      resizeInput();
    } else if (['sending', 'failed', 'uncertain'].includes(message.sendStatus)) {
      activeSend.status = message.sendStatus;
      activeSend.error = message.error || message.warning;
    }
    persistDraft();
    updateComposer();
  }

  function receiveBackgroundSendStatus(message) {
    if (typeof message.recipientId !== 'string' || message.recipientId === '__history__') return;
    for (const [key, draft] of Object.entries(drafts)) {
      const sent = draft?.send;
      if (!sent || sent.requestId !== message.requestId || sent.recipientId !== message.recipientId) continue;
      if (message.sendStatus === 'sent') {
        draft.send = null;
        if (sent.kind === 'file' && draft.file?.fileId === sent.fileId) draft.file = null;
        else if (sent.kind === 'image' && draft.image?.id === sent.imageId) draft.image = null;
        else if (sent.kind === 'text' && draft.text === sent.text
          && JSON.stringify(draft.quote) === JSON.stringify(sent.quote)) {
          draft.text = '';
          draft.quote = null;
        }
        draft.lastSendLabel = '已发送' + (message.warning ? ` · ${message.warning}` : '');
      } else if (['sending', 'failed', 'uncertain'].includes(message.sendStatus)) {
        draft.send = { ...sent, status: message.sendStatus, error: message.error || message.warning };
      } else return;
      drafts[key] = draft;
      saveState();
      return;
    }
  }

  textInput.addEventListener('input', () => {
    resizeInput();
    persistDraft();
    updateComposer();
  });

  textInput.addEventListener('keydown', (e) => {
    const shortcutMatches = sendShortcut === 'ctrlEnter'
      ? (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey
      : !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
    if (e.key === 'Enter' && shortcutMatches && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  function updateShortcutHints() {
    textInput.title = sendShortcut === 'ctrlEnter'
      ? 'Ctrl/Cmd+Enter 发送，Enter 换行'
      : 'Enter 发送，Shift+Enter 换行';
    if (pendingImage?.imageData) showImageDraft();
  }

  attachBtn.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) stageAttachment(file);
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
    if (!currentChannel || !recipientCanEdit() || activeSend?.status === 'sending') return;
    const start = textInput.selectionStart ?? textInput.value.length;
    const end = textInput.selectionEnd ?? textInput.value.length;
    textInput.value = textInput.value.slice(0, start) + emoji + textInput.value.slice(end);
    textInput.focus();
    const pos = start + emoji.length;
    textInput.setSelectionRange(pos, pos);
    resizeInput();
    persistDraft();
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
    for (const id of ['recipient-picker', 'connection-picker']) {
      if (!e.target.closest(`#${id}`)) document.getElementById(id).open = false;
    }
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

  newMessagesBtn.addEventListener('click', scrollToBottom);
  chatContainer.addEventListener('scroll', () => {
    if (preservedScrollTop !== null) {
      const restored = Math.abs(chatContainer.scrollTop - preservedScrollTop) < 1;
      preservedScrollTop = null;
      if (restored) return;
    }
    followingMessages = isNearBottom();
    readingPosition = followingMessages ? null : captureReadingPosition();
    if (followingMessages && !document.hidden) {
      if (!syncGeneration) unreadCount = 0;
      updateUnread();
      reportRead();
    }
  });
  document.addEventListener('visibilitychange', () => {
    // A previous report may have reached the host just after this panel hid.
    // Retrying after the next visibility transition is safe: DB reads are monotonic.
    lastReadSent = sharedReadThroughId;
    if (!document.hidden) {
      postScoped({ command: 'requestSync' });
      if (isNearBottom()) scrollToBottom();
    }
  });
  window.addEventListener('focus', () => {
    lastReadSent = sharedReadThroughId;
    postScoped({ command: 'requestSync' });
    reportRead();
  });
  window.addEventListener('resize', resizeInput);
  // Images load after their rows are inserted. Keep the same visible message
  // when their height changes, or continue following the latest message.
  if (typeof ResizeObserver !== 'undefined') {
    const resizeObserver = new ResizeObserver(() => {
      if (followingMessages && !document.hidden) scrollToBottom();
      else if (readingPosition) restoreReadingPosition(readingPosition);
    });
    resizeObserver.observe(messagesEl);
    resizeObserver.observe(chatContainer);
  }

  // ---- Messages from extension host ----

  function receiveConnectionHealth(health) {
    const labels = { offline: '离线', connecting: '正在连接', online: '在线', reconnecting: '正在重新连接', error: '连接异常' };
    if (!health || !Object.prototype.hasOwnProperty.call(labels, health.state)) return;
    const parts = [labels[health.state]];
    if (typeof health.detail === 'string' && health.detail.trim()) parts.push(health.detail);
    const time = value => Number.isFinite(value) && value >= 0 && Number.isFinite(new Date(value).getTime())
      ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : null;
    const lastAck = time(health.lastAckAt);
    const retry = time(health.retryAt);
    if (lastAck) parts.push(`最近响应 ${lastAck}`);
    if (retry) parts.push(`下次重试 ${retry}`);
    const detail = parts.join(' · ');
    const text = health.state === 'online' ? labels.online : detail;
    if (connectionStatus.title === detail && connectionStatus.dataset.state === health.state) return;
    const position = captureReadingPosition();
    // Status-bar height changes are presentation only, never read actions.
    presentationReadSuppressed = true;
    const change = ++presentationChange;
    connectionStatus.textContent = text;
    document.getElementById('connection-detail').textContent = detail;
    connectionStatus.title = detail;
    connectionStatus.setAttribute('aria-label', detail);
    connectionStatus.tabIndex = 0;
    connectionStatus.dataset.state = health.state;
    connectionStatus.classList.remove('hidden');
    restoreReadingPosition(position);
    const release = () => { if (change === presentationChange) presentationReadSuppressed = false; };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(release));
    else setTimeout(release, 0);
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    const scopedCommands = ['syncMessages', 'loadHistory', 'newMessage', 'clearHistory', 'historyError',
      'searchResults', 'searchError', 'messageContext', 'contextError', 'readStateError', 'revealLatest',
      'error', 'warning', 'fileDraftStatus'];
    if (recipientManaged && scopedCommands.includes(message.command) && !matchesViewScope(message)) return;

    switch (message.command) {
      case 'connectionHealth':
        receiveConnectionHealth(message.connectionHealth);
        break;
      case 'recipients':
        receiveRecipients(message);
        break;

      case 'recipientSelected':
        receiveRecipientSelected(message);
        break;

      case 'recipientSelectionError':
        if (pendingRecipientSelection?.requestId === message.requestId
          || (!pendingRecipientSelection && currentSelectionId === message.requestId)) {
          pendingRecipientSelection = null;
          currentSelectionId = null;
          recipientSelectionError = `切换失败：${message.error || '请重试'}。请重新选择联系人。`;
          updateRecipientUI();
        }
        break;

      case 'recipientInvalidated':
        if (recipientManaged) invalidateRecipient(message.error);
        break;

      case 'revealRecipient':
        selectRecipient(message.recipientId, true);
        break;
      case 'settings':
        if (message.sendShortcut === 'enter' || message.sendShortcut === 'ctrlEnter') {
          sendShortcut = message.sendShortcut;
          updateShortcutHints();
        }
        if (typeof message.renderMarkdown === 'boolean') updateMarkdownPresentation(message.renderMarkdown);
        break;

      case 'copyResult':
        receiveCopyResult(message);
        break;

      case 'dataResult':
        receiveDataResult(message);
        break;

      case 'searchResults':
        receiveSearchResults(message);
        break;

      case 'searchError':
        if (activeSearch?.requestId === message.requestId) {
          activeSearch = null;
          searchSubmit.disabled = false;
          searchMore.disabled = false;
          searchStatus.textContent = `搜索失败：${message.error || '请重试。'}`;
        }
        break;

      case 'messageContext':
        receiveMessageContext(message);
        break;

      case 'contextError':
        if (pendingContext?.requestId === message.requestId) {
          pendingContext = null;
          searchContextTitle.textContent = `无法打开消息：${message.error || '请重试。'}`;
        }
        break;

      case 'syncMessages':
        receiveSync(message);
        break;

      case 'hostFocus':
        hostFocused = message.focused === true;
        lastReadSent = sharedReadThroughId;
        if (hostFocused) {
          postScoped({ command: 'requestSync' });
          reportRead();
        }
        break;

      case 'readStateError':
        // Allow the next visibility, focus or scroll action to retry. Avoid a
        // tight request/failure loop when storage is temporarily unavailable.
        if (!message.generation || message.generation === syncGeneration) lastReadSent = 0;
        break;

      case 'revealLatest':
        if (searchOpen) setSearchOpen(false);
        if (dataOpen) setDataOpen(false);
        showChat();
        scrollToBottom();
        textInput.focus();
        break;

      case 'channel':
        restoreDraft(message.channel);
        break;

      case 'sendStatus':
        receiveSendStatus(message);
        break;

      case 'fileCapabilities':
        fileCapabilities = message.fileCapabilities && typeof message.fileCapabilities === 'object'
          ? { ...message.fileCapabilities, canSend: message.fileCapabilities.canSend === true }
          : { canSend: false, maxBytes: MAX_FILE_BYTES, reason: '当前通道不支持发送文件' };
        updateComposer();
        break;

      case 'fileSelected':
        receiveFileSelected(message);
        break;

      case 'fileDraftStatus':
        receiveFileDraftStatus(message);
        break;

      case 'attachmentStatus':
        receiveAttachmentStatus(message);
        break;

      case 'loadHistory':
        if (syncGeneration && message.generation !== syncGeneration) break;
        loadHistory(message.messages || [], Boolean(message.older), Boolean(message.hasMore));
        hasPartner = message.messages && message.messages.length > 0;
        loginScreen.classList.add('hidden');
        chatContainer.classList.remove('hidden');
        inputBar.classList.remove('hidden');
        reportRead();
        break;

      case 'newMessage':
        if (syncGeneration && message.generation !== syncGeneration) break;
        if (message.message) {
          if (!loginScreen.classList.contains('hidden')) {
            loginScreen.classList.add('hidden');
            chatContainer.classList.remove('hidden');
            inputBar.classList.remove('hidden');
          }
          if (!allMessages.some((msg) => msg.id === message.message.id)) {
            const follow = (allMessages.length === 0 || isNearBottom()) && !document.hidden;
            const position = captureReadingPosition();
            const outOfOrder = allMessages.length > 0
              && message.message.id < allMessages[allMessages.length - 1].id;
            allMessages.push(message.message);
            allMessages.sort((a, b) => a.id - b.id);
            if (outOfOrder) reRenderAll();
            else renderMessage(message.message);
            if (follow) scrollToBottom();
            else {
              if (!syncGeneration && message.message.direction === 'received') unreadCount += 1;
              restoreReadingPosition(position);
              updateUnread();
            }
          }
          hasPartner = true;
        }
        break;

      case 'clearHistory':
        if (syncGeneration) break; // Shared clears arrive as a new-generation snapshot.
        invalidateSearch('聊天记录已清空，请重新搜索。');
        allMessages = [];
        initialHistoryLoaded = true;
        messagesEl.innerHTML = '';
        loadingHistory = false;
        loadMoreHistoryBtn.disabled = false;
        loadMoreHistoryBtn.classList.add('hidden');
        lastRenderedDate = '';
        unreadCount = 0;
        scrollToBottom();
        break;

      case 'historyError':
        loadingHistory = false;
        loadMoreHistoryBtn.disabled = false;
        loadMoreHistoryBtn.textContent = '重试加载更早消息';
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
          const follow = isNearBottom() && !document.hidden;
          messagesEl.appendChild(errDiv);
          if (follow) scrollToBottom();
        }
        break;

      case 'warning':
        if (message.warning) {
          const warnDiv = document.createElement('div');
          warnDiv.className = 'message received warning-message';
          warnDiv.textContent = currentMode === 'chat'
            ? `⚠ ${message.warning}`
            : `[WARN] ${message.warning}`;
          const follow = isNearBottom() && !document.hidden;
          messagesEl.appendChild(warnDiv);
          if (follow) scrollToBottom();
        }
        break;
    }
  });
  // Register all event handlers before asking the host to restore state.
  vscode.postMessage({ command: 'ready' });
})();
