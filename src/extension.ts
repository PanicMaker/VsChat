import * as vscode from 'vscode';
import { ChatDB } from './chat-db';
import { VsChatClient } from './vschat-client';
import { ChatViewProvider } from './chat-view-provider';

let client: VsChatClient | undefined;
let db: ChatDB | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Initialize database
  db = new ChatDB(context);
  await db.init();

  // Initialize VsChat client
  client = new VsChatClient(context, db);
  context.subscriptions.push(client);

  // Try to restore previous session before registering provider
  try {
    const restored = await client.restoreLogin();
    if (restored) {
      await client.startPolling();
    }
  } catch {
    // Ignore restore errors — user can log in manually
  }

  // Register chat view provider (after restore so connected state is correct)
  const provider = new ChatViewProvider(context, client, db);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider),
    provider
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('vschat.login', async () => {
      if (client) {
        await client.login();
        await client.startPolling();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vschat.clearHistory', async () => {
      if (provider) {
        await provider.clearHistory();
        vscode.window.showInformationMessage('Chat history cleared');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vschat.disconnect', async () => {
      if (client) {
        await client.logout();
        vscode.window.showInformationMessage('Disconnected from WeChat');
      }
    })
  );

}

export async function deactivate(): Promise<void> {
  client?.dispose();
  await db?.close();
}
