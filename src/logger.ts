import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('VsChat');
  }
  return outputChannel;
}

function timestamp(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
