import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { fetch } from 'undici';
import * as log from './logger';

const EXTENSION_ID = 'PanicMaker.vschat';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 10 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  assets: { name: string; browser_download_url: string }[];
}

function parseSemver(v: string): number[] {
  return v.replace(/^v/i, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
}

function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check GitHub Releases for a newer VsChat version. When one exists, prompt the
 * user to download the VSIX and install it via the extension host.
 *
 * The GitHub Actions workflow packages vschat.vsix and publishes it to a
 * release tagged v<version> on every push to main/master.
 */
export async function checkForUpdates(context: vscode.ExtensionContext, force = false): Promise<void> {
  if (context.extensionMode === vscode.ExtensionMode.Development && !force) {
    log.info('Skipping auto-update check in development mode');
    return;
  }

  const config = vscode.workspace.getConfiguration('vschat');
  if (!force && !config.get<boolean>('autoUpdate', true)) {
    log.info('Auto-update disabled by vschat.autoUpdate');
    return;
  }

  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  if (!ext) {
    return;
  }
  const currentVersion = String(ext.packageJSON.version || '0.0.0');
  const repoUrl = String(ext.packageJSON.repository?.url || '');
  const repoMatch = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!repoMatch) {
    log.warn('Cannot parse repository URL for update checks:', repoUrl);
    return;
  }
  const [, owner, repo] = repoMatch;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;

  let release: GitHubRelease;
  try {
    const resp = await fetchWithTimeout(apiUrl, REQUEST_TIMEOUT_MS);
    if (resp.status === 404) {
      log.info('No GitHub release found yet, skipping update check');
      return;
    }
    if (resp.status === 403) {
      log.warn('GitHub API rate limit reached, skipping update check');
      return;
    }
    if (!resp.ok) {
      log.warn('GitHub release check failed, HTTP', resp.status);
      return;
    }
    release = (await resp.json()) as GitHubRelease;
  } catch (err) {
    log.warn('GitHub release check error:', err instanceof Error ? err.message : String(err));
    return;
  }

  const remoteVersion = release.tag_name.replace(/^v/i, '');
  if (!isNewerVersion(remoteVersion, currentVersion)) {
    if (force) {
      vscode.window.showInformationMessage(`VsChat 已是最新版本 v${currentVersion}`);
    } else {
      log.info('VsChat is up to date at v' + currentVersion);
    }
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `VsChat 有新版本 v${remoteVersion}（当前 v${currentVersion}），是否更新？`,
    '更新',
    '忽略此次'
  );
  if (choice !== '更新') {
    log.info('User declined update to v' + remoteVersion);
    return;
  }

  const asset = release.assets.find(a => a.name === 'vschat.vsix');
  const downloadUrl = asset?.browser_download_url ?? `${release.html_url}/download/v${remoteVersion}/vschat.vsix`;
  const vsixPath = path.join(context.globalStorageUri.fsPath, 'updates', `vschat-${remoteVersion}.vsix`);

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在下载 VsChat v${remoteVersion}…`,
      },
      async () => {
        fs.mkdirSync(path.dirname(vsixPath), { recursive: true });
        const resp = await fetchWithTimeout(downloadUrl, DOWNLOAD_TIMEOUT_MS);
        if (!resp.ok) {
          throw new Error(`download failed: HTTP ${resp.status}`);
        }
        fs.writeFileSync(vsixPath, Buffer.from(await resp.arrayBuffer()));
        log.info('Downloaded update:', vsixPath);
      }
    );

    await vscode.commands.executeCommand(
      'workbench.extensions.installExtension',
      vscode.Uri.file(vsixPath)
    );

    const reload = await vscode.window.showInformationMessage(
      `VsChat 已更新到 v${remoteVersion}，需要重新加载窗口生效。`,
      '立即重载'
    );
    if (reload === '立即重载') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } catch (err) {
    log.error('Update failed:', err instanceof Error ? err.message : String(err));
    const openRelease = await vscode.window.showErrorMessage(
      `VsChat 自动更新失败（${err instanceof Error ? err.message : String(err)}）`,
      '打开 Release 页面'
    );
    if (openRelease === '打开 Release 页面') {
      await vscode.env.openExternal(vscode.Uri.parse(release.html_url));
    }
  }
}

/**
 * Schedule the first update check shortly after activation, then re-check
 * periodically. Timers are disposed with the extension context.
 */
export function scheduleAutoUpdates(context: vscode.ExtensionContext): void {
  const firstTimer = setTimeout(() => {
    void checkForUpdates(context);
  }, FIRST_CHECK_DELAY_MS);
  context.subscriptions.push({ dispose: () => clearTimeout(firstTimer) });

  const intervalTimer = setInterval(() => {
    void checkForUpdates(context);
  }, CHECK_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(intervalTimer) });
}
