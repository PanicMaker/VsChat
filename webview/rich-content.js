(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VsChatRichContent = api;
})(typeof window !== 'undefined' ? window : undefined, function () {
  'use strict';

  // Keep this allowlist in sync with src/markdown-content.ts; the host rechecks every open request.
  function safeExternalUrl(value) {
    if (typeof value !== 'string' || value.length > 4096 || !/^(?:https?:\/\/|mailto:)/i.test(value)
      || /[\u0000-\u0020\u007f-\u009f\\]/.test(value)) return undefined;
    let decoded = value;
    while (true) {
      if (/[\u0000-\u001f\u007f\\]/.test(decoded)) return undefined;
      const next = decoded.replace(/%([\da-f]{2})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
      if (next === decoded) break;
      decoded = next;
    }
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return url.hostname && !url.username && !url.password ? url.href : undefined;
      }
      if (url.protocol === 'mailto:' && url.pathname && !url.pathname.startsWith('//')) return url.href;
    } catch {
      // An invalid link remains plain text.
    }
    return undefined;
  }

  const tags = new Set([
    'p', 'strong', 'em', 's', 'code', 'blockquote', 'ul', 'ol', 'li',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ]);

  function render(container, nodes, handlers) {
    const document = container.ownerDocument;
    const callbacks = handlers || {};
    container.replaceChildren();
    container.classList.add('rich-content');
    if (!Array.isArray(nodes)) return false;
    let remaining = 10_000;

    function append(parent, entries, depth) {
      if (!Array.isArray(entries) || entries.length === 0) return true;
      if (depth > 40) return false;
      for (const node of entries) {
        if (--remaining < 0) return false;
        if (!node || typeof node !== 'object') continue;
        if (node.tag === 'text') {
          if (typeof node.text === 'string') parent.appendChild(document.createTextNode(node.text));
          continue;
        }
        if (node.tag === 'pre') {
          if (typeof node.text !== 'string') continue;
          const block = document.createElement('div');
          block.className = 'rich-code-block';
          const header = document.createElement('div');
          header.className = 'rich-code-header';
          const language = document.createElement('span');
          language.className = 'rich-code-language';
          language.textContent = typeof node.language === 'string' ? node.language.slice(0, 80) : '';
          header.appendChild(language);
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'rich-code-copy';
          button.textContent = '复制代码';
          button.addEventListener('click', () => {
            if (typeof callbacks.copyText === 'function') callbacks.copyText(node.text, button);
          });
          header.appendChild(button);
          block.appendChild(header);
          const pre = document.createElement('pre');
          const code = document.createElement('code');
          code.textContent = node.text;
          pre.appendChild(code);
          block.appendChild(pre);
          parent.appendChild(block);
          continue;
        }
        let element;
        if (node.tag === 'a') {
          const url = safeExternalUrl(node.href);
          element = document.createElement(url ? 'a' : 'span');
          if (url) {
            element.className = 'rich-link';
            element.setAttribute('role', 'link');
            element.setAttribute('tabindex', '0');
            element.setAttribute('title', url);
            // Deliberately no href: every activation must pass through the validated host command.
            const activate = event => {
              event.preventDefault();
              if (typeof callbacks.openExternal === 'function') callbacks.openExternal(url);
            };
            element.addEventListener('click', activate);
            element.addEventListener('keydown', event => {
              if (event.key === 'Enter' || event.key === ' ') activate(event);
            });
          }
        } else if (tags.has(node.tag)) {
          element = document.createElement(node.tag);
          if (node.tag === 'ol' && Number.isSafeInteger(node.start) && node.start > 0) {
            element.setAttribute('start', String(node.start));
          }
        } else {
          // A forged AST cannot create scripts, images, event handlers, styles, or arbitrary attributes.
          if (typeof node.text === 'string') parent.appendChild(document.createTextNode(node.text));
          continue;
        }
        if (typeof node.text === 'string') element.textContent = node.text;
        if (!append(element, node.children, depth + 1)) return false;
        parent.appendChild(element);
      }
      return true;
    }
    const complete = append(container, nodes, 0);
    // A resource limit must never leave a plausible but incomplete message.
    // Callers retain the original source and render it as literal text on false.
    if (!complete) container.replaceChildren();
    return complete;
  }

  return { render, safeExternalUrl };
});
