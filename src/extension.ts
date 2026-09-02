import * as vscode from 'vscode';
import { ChatDB } from './chat-db';
import { WxClient } from './wx-client';
import { QqBotClient, QQ_APP_ID_SECRET, QQ_APP_SECRET_SECRET } from './qq-bot-client';
import { ChatClient } from './chat-client';
import { ChatViewProvider } from './chat-view-provider';
import { sendBarkPush, previewForNotification } from './push';
import { checkForUpdates, scheduleAutoUpdates } from './updater';
import * as log from './logger';

let client: ChatClient | undefined;
let db: ChatDB | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Initialize database
  const configuredChannel = vscode.workspace.getConfiguration('vschat').get<'wechat' | 'qq'>('channel') || 'wechat';
  const configuredLogLevel = vscode.workspace.getConfiguration('vschat').get<log.LogLevel>('logLevel') || 'debug';
  log.configure(configuredLogLevel, {
    version: context.extension.packageJSON.version,
    channel: configuredChannel,
    extensionMode: vscode.ExtensionMode[context.extensionMode],
    vscodeVersion: vscode.version,
    nodeVersion: process.version,
    platform: process.platform,
  });
  log.info('[Core] activating extension', { channel: configuredChannel });
  db = new ChatDB(context, configuredChannel);
  try {
    await db.init();
  } catch (err) {
    log.error('[DB] initialization failed', { channel: configuredChannel }, log.formatError(err));
    throw err;
  }
  log.info('[DB] initialized', { channel: configuredChannel });

  // Initialize the selected chat transport.
  client = configuredChannel === 'qq'
    ? new QqBotClient(context, db)
    : new WxClient(context, db);
  context.subscriptions.push(client);

  // Try to restore previous session before registering provider
  try {
    const restored = await client.restoreLogin();
    if (restored) {
      await client.startPolling();
    }
  } catch (err) {
    log.warn('[Core] session restore failed; manual login remains available', log.formatError(err));
  }

  // Global message subscription: receive logging + Bark push must work even
  // when the VsChat side panel is closed (the panel's own onMessage
  // subscription only exists while the webview is visible).
  context.subscriptions.push(
    client.onMessage(async (chatMsg) => {
      log.info('[Core] message event', {
        channel: client?.channelName,
        id: chatMsg.id,
        type: chatMsg.type,
        direction: chatMsg.direction,
        contentLen: chatMsg.content.length,
        imageDataUrlLen: (chatMsg as any).imageDataUrl?.length ?? 'none',
        messageId: chatMsg.message_id,
      });
      if (chatMsg.direction === 'received') {
        const preview = previewForNotification(chatMsg);
        void sendBarkPush(client?.channelName || 'VsChat', preview);
      }
    })
  );

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
        log.info('[Command] login requested', { channel: client.channelName });
        try {
          await client.login();
          await client.startPolling();
        } catch (err: any) {
          log.error('[Command] login failed', { channel: client.channelName }, log.formatError(err));
          vscode.window.showErrorMessage(err.message);
        }
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
        log.info('[Command] disconnect requested', { channel: client.channelName });
        await client.logout();
        vscode.window.showInformationMessage(`Disconnected from ${client.channelName}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vschat.configureQQ', async () => {
      const previousAppId = await context.secrets.get(QQ_APP_ID_SECRET) || '';
      const appId = await vscode.window.showInputBox({
        title: 'Configure QQ Bot',
        prompt: '输入 QQ 开放平台中的 AppID',
        value: previousAppId,
        ignoreFocusOut: true,
      });
      if (!appId?.trim()) return;

      const appSecret = await vscode.window.showInputBox({
        title: 'Configure QQ Bot',
        prompt: '输入 AppSecret（将安全保存到 VS Code SecretStorage）',
        password: true,
        ignoreFocusOut: true,
      });
      if (!appSecret?.trim()) return;

      await context.secrets.store(QQ_APP_ID_SECRET, appId.trim());
      await context.secrets.store(QQ_APP_SECRET_SECRET, appSecret.trim());
      log.info('[Command] QQ credentials stored', { appId: appId.trim(), secretPresent: true });
      const channelConfiguration = vscode.workspace.getConfiguration('vschat');
      const channelInspection = channelConfiguration.inspect<string>('channel');
      const configurationTarget = channelInspection?.workspaceFolderValue !== undefined
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : channelInspection?.workspaceValue !== undefined
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
      await channelConfiguration.update(
        'channel',
        'qq',
        configurationTarget
      );

      const action = await vscode.window.showInformationMessage(
        'QQ Bot 凭据已保存。重载窗口后将切换到 QQ 通道。',
        'Reload Window'
      );
      if (action === 'Reload Window') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vschat.testPush', async () => {
      const ok = await sendBarkPush('VsChat 测试', '如果你在 iPhone 上看到这条消息，Bark 推送已生效！');
      if (ok) {
        vscode.window.showInformationMessage('Test push sent — check your iPhone.');
      } else {
        vscode.window.showErrorMessage('Test push failed — check the VsChat output log or vschat.barkUrl setting.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vschat.checkUpdates', async () => {
      await checkForUpdates(context, true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vschat.showLogs', () => log.show())
  );

  scheduleAutoUpdates(context);

}

export async function deactivate(): Promise<void> {
  log.info('[Core] deactivating extension', { channel: client?.channelName });
  client?.dispose();
  await db?.close();
  log.dispose();
}
