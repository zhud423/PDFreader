const statusPill = document.querySelector('#status-pill');
const notice = document.querySelector('#notice');
const stepTitle = document.querySelector('#step-title');
const primaryActionButton = document.querySelector('#primary-action');
const folderList = document.querySelector('#folder-list');
const folderManageList = document.querySelector('#folder-manage-list');
const bookCountText = document.querySelector('#book-count');
const lastScanText = document.querySelector('#last-scan');
const scanNoteText = document.querySelector('#scan-note');
const connectSummaryText = document.querySelector('#connect-summary');
const qrCard = document.querySelector('#qr-card');
const primaryQrImage = document.querySelector('#primary-qr');
const qrEmptyText = document.querySelector('#qr-empty');
const copyPrimaryLinkButton = document.querySelector('#copy-primary-link');
const tlsSummaryText = document.querySelector('#tls-summary');
const installCertLink = document.querySelector('#install-cert-link');
const sourceNameInput = document.querySelector('#source-name');
const manualFolderPathInput = document.querySelector('#manual-folder-path');
const openConnectPageLink = document.querySelector('#open-connect-page');
const openLibraryJsonLink = document.querySelector('#open-library-json');

let currentSnapshot = null;
let qrObjectUrl = null;

function getPrimarySetupUrl(snapshot) {
  const urls = snapshot?.urls ?? {};
  return urls.primarySetupUrl || urls.addRemoteUrl || urls.connectUrl || urls.sourceBaseUrl || '';
}

function setNotice(message, tone = 'normal') {
  if (!message) {
    notice.hidden = true;
    notice.textContent = '';
    notice.classList.remove('is-error');
    return;
  }

  notice.hidden = false;
  notice.textContent = message;
  notice.classList.toggle('is-error', tone === 'error');
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json'
    },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || '请求失败');
  }
  return payload;
}

async function copyText(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('当前没有可复制的链接。');
  }

  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }

  window.prompt('复制下面这个地址', value);
}

function buildStepState(snapshot) {
  const { state, summary, urls } = snapshot;

  if (summary.folderCount === 0) {
    return {
      title: '第 1 步：选择要共享的文件夹',
      action: 'choose-folder',
      label: '选择文件夹'
    };
  }

  if (!state.sharingEnabled) {
    return {
      title: '第 2 步：开始共享',
      action: 'start-share',
      label: '开始共享'
    };
  }

  if (summary.bookCount === 0) {
    return {
      title: '先确认文件夹里有 PDF',
      action: 'rescan',
      label: '重新扫描'
    };
  }

  if (urls.lan.length === 0) {
    return {
      title: '先让手机和 Mac 连到同一 Wi-Fi',
      action: 'refresh',
      label: '重新检查状态'
    };
  }

  return {
    title: '第 3 步：让手机连接',
    action: 'idle',
    label: ''
  };
}

function renderStatus(snapshot) {
  const { state, summary } = snapshot;
  if (state.scanStatus === 'scanning') {
    statusPill.textContent = '正在扫描文件...';
    statusPill.className = 'status-pill';
    return;
  }

  if (state.lastScanError) {
    statusPill.textContent = '共享有问题，请先处理';
    statusPill.className = 'status-pill is-error';
    return;
  }

  if (state.sharingEnabled) {
    statusPill.textContent = `共享中，已发现 ${summary.bookCount} 本 PDF`;
    statusPill.className = 'status-pill';
    return;
  }

  statusPill.textContent = summary.folderCount > 0 ? '文件夹已选好，还没开始共享' : '还没有开始共享';
  statusPill.className = 'status-pill is-off';
}

function renderFolders(state) {
  folderList.innerHTML = '';
  folderManageList.innerHTML = '';

  if (state.folders.length === 0) {
    folderList.innerHTML = '<li class="empty">还没有选共享文件夹。</li>';
    folderManageList.innerHTML = '<li class="empty">还没有可管理的文件夹。</li>';
    return;
  }

  state.folders.forEach((folder) => {
    const readonlyItem = document.createElement('li');
    readonlyItem.className = 'folder-item';
    readonlyItem.innerHTML = `<strong>${folder.name}</strong><span class="mono">${folder.path}</span>`;
    folderList.appendChild(readonlyItem);

    const manageItem = document.createElement('li');
    manageItem.className = 'folder-item';
    manageItem.innerHTML = `
      <div class="folder-item__row">
        <strong>${folder.name}</strong>
        <button class="secondary" data-folder-id="${folder.id}">移除</button>
      </div>
      <span class="mono">${folder.path}</span>
    `;
    folderManageList.appendChild(manageItem);
  });
}

function revokeQrObjectUrl() {
  if (!qrObjectUrl) {
    return;
  }

  URL.revokeObjectURL(qrObjectUrl);
  qrObjectUrl = null;
}

function hideQrCard(message) {
  qrCard.hidden = true;
  qrEmptyText.hidden = false;
  qrEmptyText.textContent = message;
  primaryQrImage.removeAttribute('src');
  revokeQrObjectUrl();
}

async function loadQrImage(candidates) {
  for (const candidate of candidates) {
    try {
      const response = await fetch(`${candidate}?_ts=${Date.now()}`, {
        cache: 'no-store'
      });
      if (!response.ok) {
        continue;
      }

      const contentType = response.headers.get('Content-Type') || '';
      if (!contentType.includes('image/svg+xml')) {
        continue;
      }

      const svgBlob = await response.blob();
      revokeQrObjectUrl();
      qrObjectUrl = URL.createObjectURL(svgBlob);
      primaryQrImage.src = qrObjectUrl;
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

async function renderConnectCard(snapshot) {
  const { state, summary, urls } = snapshot;
  const sourceBaseUrl = urls.sourceBaseUrl || '';
  const connectUrl = urls.connectUrl || `${location.origin}/connect`;
  const certificateInstallUrl = urls.certificateInstallUrl || '';

  copyPrimaryLinkButton.disabled = !getPrimarySetupUrl(snapshot);
  openConnectPageLink.href = connectUrl;
  openLibraryJsonLink.href = sourceBaseUrl ? `${sourceBaseUrl}/library.json` : '#';
  if (urls.tlsEnabled && certificateInstallUrl) {
    tlsSummaryText.hidden = false;
    installCertLink.href = certificateInstallUrl;
  } else {
    tlsSummaryText.hidden = true;
    installCertLink.removeAttribute('href');
  }

  if (!state.sharingEnabled) {
    connectSummaryText.textContent = '开启共享后会显示二维码。';
    hideQrCard('当前还没有开始共享。');
    return;
  }

  if (summary.bookCount === 0) {
    connectSummaryText.textContent = '扫描到可用 PDF 后会显示二维码。';
    hideQrCard('当前还没有可供同步的 PDF。');
    return;
  }

  if (urls.lan.length === 0) {
    connectSummaryText.textContent = '请先让 Mac 和手机连到同一 Wi-Fi。';
    hideQrCard('当前没有可供手机访问的局域网地址。');
    return;
  }

  connectSummaryText.textContent = urls.addRemoteUrl
    ? '扫码可直接进入 PDFreader 添加页。'
    : '扫码先打开连接页，再按提示添加。';

  const loaded = await loadQrImage(['/qr/primary.svg', '/qr/connect.svg', '/qr/source.svg']);
  if (!loaded) {
    hideQrCard('二维码加载失败，请先使用“复制书源地址”，然后在手机里手动添加。');
    return;
  }

  qrCard.hidden = false;
  qrEmptyText.hidden = true;
}

async function renderSnapshot(snapshot) {
  currentSnapshot = snapshot;
  const { state, summary } = snapshot;
  const stepState = buildStepState(snapshot);

  renderStatus(snapshot);
  stepTitle.textContent = stepState.title;
  if (stepState.action === 'idle') {
    primaryActionButton.hidden = true;
    primaryActionButton.dataset.action = '';
    primaryActionButton.textContent = '';
  } else {
    primaryActionButton.hidden = false;
    primaryActionButton.textContent = stepState.label;
    primaryActionButton.dataset.action = stepState.action;
  }

  renderFolders(state);
  await renderConnectCard(snapshot);

  sourceNameInput.value = state.sourceName;
  bookCountText.textContent = String(summary.bookCount);
  lastScanText.textContent = state.lastScanFinishedAt || '还没有扫描记录';
  scanNoteText.textContent = state.lastScanError
    ? `当前有问题：${state.lastScanError}`
    : state.scanIssues.length > 0
      ? `有 ${state.scanIssues.length} 个文件没有成功扫描，可在高级设置里重新扫描。`
      : '当前状态正常。';
}

async function loadState() {
  try {
    const snapshot = await requestJson('/api/state', { method: 'GET' });
    await renderSnapshot(snapshot);
  } catch (error) {
    setNotice(error instanceof Error ? error.message : '读取状态失败', 'error');
  }
}

async function runPrimaryAction(action) {
  if (action === 'choose-folder') {
    setNotice('正在打开系统文件夹选择器...');
    const result = await requestJson('/api/folders/choose', { method: 'POST' });
    if (result.cancelled) {
      setNotice('已取消选择。');
      return;
    }
    setNotice('文件夹已添加。');
    return;
  }

  if (action === 'start-share') {
    setNotice('正在开启共享并扫描文件...');
    await requestJson('/api/share/start', { method: 'POST' });
    setNotice('共享已开启。');
    return;
  }

  if (action === 'rescan') {
    setNotice('正在重新扫描文件...');
    await requestJson('/api/rescan', { method: 'POST' });
    setNotice('扫描完成。');
    return;
  }

  if (action === 'refresh') {
    await loadState();
    setNotice('状态已刷新。');
    return;
  }

}

primaryActionButton.addEventListener('click', async () => {
  try {
    await runPrimaryAction(primaryActionButton.dataset.action || '');
    await loadState();
  } catch (error) {
    setNotice(error instanceof Error ? error.message : '操作失败', 'error');
  }
});

copyPrimaryLinkButton.addEventListener('click', async () => {
  try {
    const value = getPrimarySetupUrl(currentSnapshot);
    if (!value) {
      setNotice('当前还没有可复制的连接链接。', 'error');
      return;
    }
    await copyText(value);
    setNotice('连接链接已复制。');
  } catch (error) {
    setNotice(error instanceof Error ? error.message : '复制失败', 'error');
  }
});

document.querySelector('#save-source-name').addEventListener('click', async () => {
  try {
    await requestJson('/api/source-name', {
      method: 'POST',
      body: JSON.stringify({ sourceName: sourceNameInput.value })
    });
    setNotice('书源名称已保存。');
    await loadState();
  } catch (error) {
    setNotice(error instanceof Error ? error.message : '保存失败', 'error');
  }
});

document.querySelector('#add-folder-manually').addEventListener('click', async () => {
  try {
    await requestJson('/api/folders/manual', {
      method: 'POST',
      body: JSON.stringify({ path: manualFolderPathInput.value })
    });
    manualFolderPathInput.value = '';
    setNotice('文件夹已添加。');
    await loadState();
  } catch (error) {
    setNotice(error instanceof Error ? error.message : '添加文件夹失败', 'error');
  }
});

document.querySelector('#choose-folder-advanced').addEventListener('click', async () => {
  try {
    setNotice('正在打开系统文件夹选择器...');
    const result = await requestJson('/api/folders/choose', { method: 'POST' });
    if (result.cancelled) {
      setNotice('已取消选择。');
      return;
    }
    setNotice('文件夹已添加。');
    await loadState();
  } catch (error) {
    setNotice(error instanceof Error ? error.message : '选择文件夹失败', 'error');
  }
});

document.querySelector('#rescan').addEventListener('click', async () => {
  try {
    setNotice('正在重新扫描文件...');
    await requestJson('/api/rescan', { method: 'POST' });
    setNotice('扫描完成。');
    await loadState();
  } catch (error) {
    setNotice(error instanceof Error ? error.message : '扫描失败', 'error');
  }
});

document.querySelector('#stop-share').addEventListener('click', async () => {
  try {
    await requestJson('/api/share/stop', { method: 'POST' });
    setNotice('共享已关闭。');
    await loadState();
  } catch (error) {
    setNotice(error instanceof Error ? error.message : '关闭共享失败', 'error');
  }
});

folderManageList.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }

  const folderId = target.dataset.folderId;
  if (!folderId) {
    return;
  }

  try {
    await requestJson(`/api/folders/${folderId}`, { method: 'DELETE' });
    setNotice('文件夹已移除。');
    await loadState();
  } catch (error) {
    setNotice(error instanceof Error ? error.message : '移除文件夹失败', 'error');
  }
});

void loadState();
setInterval(() => {
  void loadState();
}, 5000);
