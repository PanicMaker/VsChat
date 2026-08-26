import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('VsChat');
  }
  return outputChannel;
}

function timestamp(): string {
  // Local time, fixed-width, date + 24h clock (locale-independent)
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function info(...args: unknown[]): void {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  getChannel().appendLine(`[${timestamp()}] ${msg}`);
}

export function warn(...args: unknown[]): void {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  getChannel().appendLine(`[${timestamp()}] [WARN] ${msg}`);
}

export function error(...args: unknown[]): void {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  getChannel().appendLine(`[${timestamp()}] [ERROR] ${msg}`);
}

export function show(): void {
  getChannel().show(true);
}

export function dispose(): void {
  outputChannel?.dispose();
  outputChannel = undefined;
}
