import * as vscode from 'vscode';
import { ChatDB } from './chat-db';
import { ClawBotClient } from './clawbot-client';
import { ChatViewProvider } from './chat-view-provider';

let client: ClawBotClient | undefined;
let db: ChatDB | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Initialize database
  db = new ChatDB(context);
  await db.init();

  // Initialize ClawBot client
  client = new ClawBotClient(context, db);
  context.subscriptions.push(client);

  // Register chat view provider
  const provider = new ChatViewProvider(context, client, db);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider),
    provider
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('clawbot.login', async () => {
      if (client) {
        await client.login();
        await client.startPolling();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('clawbot.clearHistory', async () => {
      if (provider) {
        await provider.clearHistory();
        vscode.window.showInformationMessage('Chat history cleared');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('clawbot.disconnect', async () => {
      if (client) {
        await client.logout();
        vscode.window.showInformationMessage('Disconnected from WeChat');
      }
    })
  );

  // Try to restore previous session
  const restored = await client.restoreLogin();
  if (restored) {
    await client.startPolling();
  }
}

export function deactivate(): void {
  client?.dispose();
  db?.close();
}
