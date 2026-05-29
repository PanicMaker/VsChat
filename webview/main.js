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

  let hasPartner = false; // true once we've received a message

  // Notify extension that webview is ready for messages
  vscode.postMessage({ command: 'ready' });

  function sendMessage(command, data) {
    vscode.postMessage({ command, ...data });
  }

  function formatTime(timestamp) {
    const date = new Date(timestamp * 1000);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function renderMessage(msg) {
    const div = document.createElement('div');
    div.className = `message ${msg.direction}`;
    div.dataset.id = msg.id;

    if (msg.type === 1) {
      // Text message — render as plain text
      const textEl = document.createElement('div');
      textEl.textContent = msg.content;
      div.appendChild(textEl);
    } else if (msg.type === 2) {
      // Image message
      console.log('[webview] renderMessage image:', JSON.stringify({ id: msg.id, direction: msg.direction, content: msg.content, imageDataUrl: !!msg.imageDataUrl, imageDataUrlType: typeof msg.imageDataUrl }));
      if (msg.direction === 'received' && msg.imageDataUrl) {
        // Has decrypted image data — show thumbnail
        const img = document.createElement('img');
        img.className = 'message-image';
        img.src = msg.imageDataUrl;
        img.alt = 'Message image';
        img.addEventListener('click', () => {
          lightboxImg.src = img.src;
          lightbox.classList.remove('hidden');
        });
        div.appendChild(img);
      } else if (msg.direction === 'received') {
        // No decrypted data yet — check if content is a valid URL
        const isUrl = msg.content && msg.content.startsWith('http');
        const placeholder = document.createElement('div');
        placeholder.className = 'image-container';
        placeholder.textContent = '[Image]';
        if (isUrl) {
          placeholder.addEventListener('click', () => {
            vscode.postMessage({ command: 'openExternal', url: msg.content });
          });
        }
        div.appendChild(placeholder);
      } else {
        // Sent image
        const placeholder = document.createElement('div');
        placeholder.className = 'image-container image-sent';
        placeholder.textContent = '[Image sent]';
        div.appendChild(placeholder);
      }
    }

    const timeEl = document.createElement('div');
    timeEl.className = 'timestamp';
    timeEl.textContent = formatTime(msg.timestamp);
    div.appendChild(timeEl);

    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function scrollToBottom() {
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  function loadHistory(messages) {
    messagesEl.innerHTML = '';
    for (const msg of messages) {
      renderMessage(msg);
    }
    scrollToBottom();
  }

  // Send button
  sendBtn.addEventListener('click', () => {
    const text = textInput.value.trim();
    if (text) {
      sendMessage('sendMessage', { text });
      textInput.value = '';
    }
  });

  // Enter to send
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  // Image attach
  attachBtn.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        sendMessage('sendImage', {
          imageData: event.target.result,
          fileName: file.name,
        });
      };
      reader.readAsDataURL(file);
    }
    fileInput.value = '';
  });

  // Lightbox — close on X or background click
  lightboxClose.addEventListener('click', () => {
    lightbox.classList.add('hidden');
  });

  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) {
      lightbox.classList.add('hidden');
    }
  });

  // Handle messages from extension host
  window.addEventListener('message', (event) => {
    const message = event.data;

    switch (message.command) {
      case 'loadHistory':
        loadHistory(message.messages || []);
        hasPartner = message.messages && message.messages.length > 0;
        // Transition to chat view
        loginScreen.classList.add('hidden');
        chatContainer.classList.remove('hidden');
        inputBar.classList.remove('hidden');
        break;

      case 'newMessage':
        if (message.message) {
          // If still on login screen, transition to chat
          if (!loginScreen.classList.contains('hidden')) {
            loginScreen.classList.add('hidden');
            chatContainer.classList.remove('hidden');
            inputBar.classList.remove('hidden');
          }
          renderMessage(message.message);
          hasPartner = true;
        }
        break;

      case 'clearHistory':
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
          errDiv.style.background = '#8b0000';
          errDiv.textContent = `Error: ${message.error}`;
          messagesEl.appendChild(errDiv);
          scrollToBottom();
        }
        break;
    }
  });
})();
