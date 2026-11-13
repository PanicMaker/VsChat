const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
require('./runtime.cjs');
const { parseMarkdown, safeExternalUrl, MAX_MARKDOWN_LENGTH } = require('../src/markdown-content.ts');
const rich = require('../webview/rich-content.js');

class TestNode {
  constructor(tagName, ownerDocument, text) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.className = '';
    this.value = text || '';
    this.classList = { add: name => { this.className += ` ${name}`; } };
  }
  get textContent() { return this.value + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.value = value; this.children = []; }
  set innerHTML(value) { throw new Error(`Unsafe innerHTML assignment: ${value}`); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren() { this.children = []; this.value = ''; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
  fire(name, values = {}) {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...values };
    for (const handler of this.listeners[name] || []) handler(event);
    return event;
  }
}

function container() {
  const document = {
    createElement(tag) { return new TestNode(tag, document); },
    createTextNode(text) { return new TestNode('#text', document, text); },
  };
  return document.createElement('div');
}

function flatten(nodes) { return nodes.flatMap(node => [node, ...flatten(node.children || [])]); }
function rendered(source, handlers) {
  const target = container();
  rich.render(target, parseMarkdown(source), handlers);
  return target;
}

test('Markdown preserves headings, emphasis, nested lists, quotes and tables as data', () => {
  const nodes = flatten(parseMarkdown('# 标题\n\n**粗体** *斜体* ~~删除~~ `inline`\n\n3. first\n4. second\n   - nested\n\n> quote\n\n| 名称 | 值 |\n| --- | ---: |\n| foo | 42 |'));
  for (const tag of ['h1', 'strong', 'em', 's', 'code', 'ol', 'ul', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td']) {
    assert.ok(nodes.some(node => node.tag === tag), `${tag} is present`);
  }
  assert.equal(nodes.find(node => node.tag === 'ol').start, 3);
  const target = rendered('3. first\n4. second');
  assert.equal(flatten(target.children).find(node => node.tagName === 'ol').attributes.start, '3');
});

test('code blocks render and copy exact code text, including blank lines and trailing newline', () => {
  const code = '  const text = "<img src=x onerror=alert(1)>";\n\nconsole.log(text);\n';
  const calls = [];
  const target = rendered(`\`\`\`javascript\n${code}\`\`\`\n\n    indented();\n    next();\n`, {
    copyText: (text, button) => calls.push({ text, button }),
  });
  const nodes = flatten(target.children);
  const codeElements = nodes.filter(node => node.tagName === 'code');
  assert.deepEqual(codeElements.map(node => node.textContent), [code, 'indented();\nnext();\n']);
  const buttons = nodes.filter(node => node.tagName === 'button');
  buttons[0].fire('click');
  buttons[1].fire('click');
  assert.deepEqual(calls.map(call => call.text), [code, 'indented();\nnext();\n']);
  assert.equal(calls[0].button, buttons[0]);
  assert.equal(nodes.find(node => node.className === 'rich-code-language').textContent, 'javascript');
  assert.ok(!nodes.some(node => node.tagName === 'img'));
});

test('code copying retains CRLF and a missing final newline from the source', () => {
  for (const [source, expected] of [
    ['```js\r\nline one\r\n\r\nline two\r\n```', 'line one\r\n\r\nline two\r\n'],
    ['```js\nunfinished fence', 'unfinished fence'],
    ['    indented without newline', 'indented without newline'],
    ['    one\r\n    two\r\n', 'one\r\ntwo\r\n'],
    ['before\r\n\r\n> ```\r\n> quoted\r\n> ```', 'quoted\r\n'],
  ]) {
    const copied = [];
    const target = rendered(source, { copyText: text => copied.push(text) });
    const nodes = flatten(target.children);
    assert.equal(nodes.find(node => node.tagName === 'code').textContent, expected);
    nodes.find(node => node.tagName === 'button').fire('click');
    assert.deepEqual(copied, [expected]);
  }
});

test('raw HTML and HTML entities stay visible text and cannot create executable elements', () => {
  const source = '<script>alert(1)</script>\n\n<img src="https://tracker.test/pixel" onerror="alert(2)">\n\n&lt;svg onload=alert(3)&gt;';
  const target = rendered(source);
  assert.match(target.textContent, /<script>alert\(1\)<\/script>/);
  assert.match(target.textContent, /<img src="https:\/\/tracker.test\/pixel" onerror="alert\(2\)">/);
  assert.match(target.textContent, /<svg onload=alert\(3\)>/);
  assert.ok(!flatten(target.children).some(node => ['script', 'img', 'svg'].includes(node.tagName)));
});

test('Markdown images become alt text placeholders without src or network-loading nodes', () => {
  const target = rendered('![diagram **bold**](https://tracker.test/pixel.png "title") ![](data:image/png;base64,aGVsbG8=)');
  assert.match(target.textContent, /\[图片：diagram bold\]/);
  assert.match(target.textContent, /\[图片：未加载\]/);
  assert.ok(!flatten(target.children).some(node => ['img', 'iframe', 'video', 'audio', 'source'].includes(node.tagName)));
  assert.ok(flatten(target.children).every(node => !('src' in node.attributes) && !('href' in node.attributes)));
});

test('only explicit external schemes open, through callbacks and keyboard activation', () => {
  const opened = [];
  const target = rendered('[web](https://example.com/docs) [mail](mailto:user@example.com) [relative](/etc/passwd) https://unlinked.test', {
    openExternal: url => opened.push(url),
  });
  const links = flatten(target.children).filter(node => node.tagName === 'a');
  assert.equal(links.length, 2);
  assert.equal(links[0].attributes.href, undefined);
  assert.equal(links[0].fire('click').defaultPrevented, true);
  assert.equal(links[1].fire('keydown', { key: 'Enter' }).defaultPrevented, true);
  links[0].fire('keydown', { key: 'ArrowRight' });
  assert.deepEqual(opened, ['https://example.com/docs', 'mailto:user@example.com']);
  assert.match(target.textContent, /relative https:\/\/unlinked.test/);
});

test('host and Webview reject dangerous URLs and nested encoded controls identically', () => {
  const unsafe = [
    undefined, null, {}, '', 'javascript:alert(1)', 'data:text/html,test', 'file:///etc/passwd',
    'command:workbench.action.closeWindow', 'vscode://file/etc/passwd', '//evil.test', '/relative',
    ' https://example.com', 'https://example.com\n.evil', 'https://example.com/\\evil',
    'https://example.com/%0a', 'https://example.com/%250D', 'https://example.com/%25%30%61',
    'https://example.com/%252525007f', 'https://example.com/%7f', 'https://example.com/%5c',
    'mailto:user@example.com?subject=test%0d%0aBcc:other@example.com', 'h%74tps://example.com',
    'https://user:secret@example.com', 'mailto:', 'mailto://example.com',
    `https://example.com/${'x'.repeat(4096)}`,
  ];
  for (const value of unsafe) {
    assert.equal(safeExternalUrl(value), undefined, `host should reject ${String(value)}`);
    assert.equal(rich.safeExternalUrl(value), undefined, `Webview should reject ${String(value)}`);
  }
  for (const value of ['HTTPS://example.com', 'http://localhost:3000/docs', 'https://example.com/a%20b', 'https://example.com/中文', 'https://example.com/%E4%B8%AD%E6%96%87', 'mailto:user@example.com?subject=Hello%20world']) {
    assert.equal(safeExternalUrl(value), new URL(value).href);
    assert.equal(rich.safeExternalUrl(value), safeExternalUrl(value));
  }
});

test('dangerous Markdown link encodings cannot bypass the protocol allowlist', () => {
  const source = '[script](javascript:alert%281%29) [entity](java&#x73;cript:alert%281%29) [file](file:///tmp/a) [command](command:run) [encoded](https://example.com/%250a)';
  const target = rendered(source);
  assert.ok(!flatten(target.children).some(node => node.tagName === 'a'));
  for (const label of ['script', 'entity', 'file', 'command', 'encoded']) assert.ok(target.textContent.includes(label));
});

test('forged AST cannot inject tags, styles, attributes, code labels, or unsafe URLs', () => {
  const target = container();
  const opened = [];
  rich.render(target, [
    { tag: 'script', text: 'bad script', children: [{ tag: 'img', src: 'https://evil.test' }] },
    { tag: 'img', src: 'https://tracker.test', onerror: 'alert(1)' },
    { tag: 'p', text: '<img src=x>', style: 'background:url(https://tracker.test)', onclick: 'alert(2)' },
    { tag: 'a', href: 'javascript:alert(3)', text: 'unsafe link', target: '_blank' },
    { tag: 'pre', text: '<script>alert(4)</script>\n', language: '<img src=x onerror=alert(5)>' },
  ], { openExternal: url => opened.push(url) });
  const nodes = flatten(target.children);
  assert.ok(nodes.every(node => !['script', 'img', 'a'].includes(node.tagName)));
  assert.ok(nodes.every(node => !('onclick' in node.attributes) && !('style' in node.attributes) && !('src' in node.attributes)));
  assert.match(target.textContent, /bad script/);
  assert.match(target.textContent, /<img src=x onerror=alert\(5\)>/);
  assert.deepEqual(opened, []);
});

test('oversized Markdown stays exact plaintext and malformed AST has bounded recursion', () => {
  const source = `# ${'*'.repeat(MAX_MARKDOWN_LENGTH)}`;
  assert.deepEqual(parseMarkdown(source), [{ tag: 'text', text: source }]);
  const target = rendered(source);
  assert.equal(target.textContent, source);
  assert.equal(target.children.length, 1);
  const cyclic = { tag: 'p', children: [] };
  cyclic.children.push(cyclic);
  assert.equal(rich.render(target, [{ tag: 'text', text: 'prefix must also disappear' }, cyclic]), false);
  assert.equal(target.children.length, 0);
  assert.doesNotThrow(() => rich.render(target, [null, 'text', 42, {}]));
  assert.equal(target.textContent, '');
});

test('rich rendering accepts exactly its node budget and rejects overflow without a partial prefix', () => {
  const target = container();
  const nodes = Array.from({ length: 10_000 }, () => ({ tag: 'text', text: 'x' }));
  assert.equal(rich.render(target, nodes), true);
  assert.equal(target.textContent, 'x'.repeat(10_000));
  assert.equal(rich.render(target, [...nodes, { tag: 'text', text: 'END_OF_MESSAGE' }]), false);
  assert.equal(target.children.length, 0, 'an incomplete prefix must not remain visible');
  const dense = '**x** '.repeat(4000) + 'END_OF_MESSAGE';
  assert.ok(dense.length < MAX_MARKDOWN_LENGTH, 'this exercises the AST budget, not the source-length fallback');
  assert.equal(rich.render(target, parseMarkdown(dense)), false);
  assert.equal(target.children.length, 0, 'nested overflow must propagate through the enclosing paragraph');
});

test('rich rendering preserves the last allowed depth and rejects deeper children in full', () => {
  const target = container();
  let nested = { tag: 'p', text: 'deep leaf' };
  for (let depth = 0; depth < 40; depth++) nested = { tag: 'blockquote', children: [nested] };
  assert.equal(rich.render(target, [nested]), true);
  assert.equal(target.textContent, 'deep leaf');
  assert.equal(rich.render(target, [{ tag: 'text', text: 'prefix' }, { tag: 'p', children: [nested] }]), false);
  assert.equal(target.children.length, 0);
});

test('browser script exposes the same standalone API without a module loader', () => {
  const sandbox = { window: {}, URL };
  vm.runInNewContext(fs.readFileSync(require.resolve('../webview/rich-content.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.window.VsChatRichContent.render, 'function');
  assert.equal(sandbox.window.VsChatRichContent.safeExternalUrl('https://example.com'), 'https://example.com/');
});
