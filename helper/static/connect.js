const statusPill = document.querySelector('#connect-status-pill');
const title = document.querySelector('#connect-title');
const notice = document.querySelector('#connect-notice');
const summaryText = document.querySelector('#connect-summary');
const primaryButton = document.querySelector('#connect-primary-button');
const openAppHomeLink = document.querySelector('#open-app-home');
const deviceChip = document.querySelector('#device-chip');
const modeChip = document.querySelector('#mode-chip');
const mobileSummaryText = document.querySelector('#mobile-summary');
const mobileStepsList = document.querySelector('#mobile-steps');
const sourceUrlText = document.querySelector('#connect-source-url');
const copyButton = document.querySelector('#copy-source-url');
const connectCertTip = document.querySelector('#connect-cert-tip');
const connectCertActions = document.querySelector('#connect-cert-actions');
const installCertLink = document.querySelector('#install-cert-link');

let currentSourceUrl = `${location.origin}/source`;
let currentPrimaryAction = { type: 'none', value: '' };

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

function renderSteps(steps) {
  mobileStepsList.innerHTML = '';
  steps.forEach((step) => {
    const item = document.createElement('li');
    item.textContent = step;
    mobileStepsList.appendChild(item);
  });
}

function detectClientEnvironment() {
  const ua = navigator.userAgent || '';
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const isMobile = isIOS || isAndroid || /Mobile/i.test(ua);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isSafari = /Safari/i.test(ua) && !/Chrome|CriOS|FxiOS|EdgiOS|EdgA|OPR|OPT/i.test(ua);

  let deviceLabel = '桌面设备';
  if (isIOS) {
    deviceLabel = 'iPhone / iPad';
  } else if (isAndroid) {
    deviceLabel = 'Android 设备';
  } else if (isMobile) {
    deviceLabel = '移动设备';
  }

  let browserLabel = '浏览器';
  if (isIOS && isSafari) {
    browserLabel = 'Safari';
  } else if (/CriOS|Chrome/i.test(ua)) {
    browserLabel = 'Chrome';
  } else if (/Firefox|FxiOS/i.test(ua)) {
    browserLabel = 'Firefox';
  } else if (/EdgiOS|EdgA|Edg/i.test(ua)) {
    browserLabel = 'Edge';
  }

  return {
    isIOS,
    isAndroid,
    isMobile,
    isStandalone,
    browserLabel,
    deviceLabel
  };
}

function renderPrimaryAction(payload) {
  currentPrimaryAction = { type: 'none', value: '' };
  primaryButton.hidden = true;
  primaryButton.textContent = '';

  if (!payload.sharingEnabled) {
    summaryText.textContent = '先回到 Mac 上点“开始共享”，这台设备现在还连不上书源。';
    return;
  }

  if ((payload.bookCount ?? 0) === 0) {
    summaryText.textContent = '先回到 Mac 上检查共享文件夹，helper 目前还没有扫描到可用 PDF。';
    return;
  }

  if (payload.addRemoteUrl) {
    summaryText.textContent = '先试一下直接打开 PDFreader 添加页。';
    currentPrimaryAction = { type: 'open', value: payload.addRemoteUrl };
    primaryButton.textContent = '打开 PDFreader 添加页';
    primaryButton.hidden = false;
    return;
  }

  summaryText.textContent = '当前最稳的做法，是先复制书源地址，再回到 PDFreader 手动添加。';
  currentPrimaryAction = { type: 'copy', value: payload.sourceBaseUrl || currentSourceUrl };
  primaryButton.textContent = '复制书源地址';
  primaryButton.hidden = false;
}

function renderDeviceGuide(payload) {
  const env = detectClientEnvironment();
  deviceChip.textContent = env.deviceLabel;
  modeChip.textContent = env.isStandalone ? '安装态窗口' : `${env.browserLabel} 浏览器`;

  if (payload.appBaseUrl) {
    openAppHomeLink.hidden = false;
    openAppHomeLink.href = payload.appBaseUrl;
  } else {
    openAppHomeLink.hidden = true;
    openAppHomeLink.removeAttribute('href');
  }

  if (!payload.sharingEnabled) {
    mobileSummaryText.textContent = '现在先不用研究这页，回到 Mac 上开启共享就行。';
    renderSteps(['回到 Mac 上的 PDFreader Helper。', '点击“开始共享”。', '等 helper 扫到书以后，再回到这台设备继续。']);
    return;
  }

  if ((payload.bookCount ?? 0) === 0) {
    mobileSummaryText.textContent = '共享已经打开，但还没有可同步的书。';
    renderSteps(['回到 Mac 检查你选中的文件夹。', '确认文件夹里确实有 PDF。', '在 helper 里重新扫描。']);
    return;
  }

  if (!env.isMobile) {
    mobileSummaryText.textContent = '这页更适合发给手机继续。桌面上看到这里，通常说明你只是测试链路。';
    renderSteps([
      payload.tlsEnabled ? '先在手机安装 helper 证书（只需首次）。' : '让手机和这台 Mac 连到同一局域网。',
      '把二维码或书源地址发到手机。',
      '在手机上的 PDFreader 完成添加。'
    ]);
    return;
  }

  if (env.isIOS && payload.addRemoteUrl) {
    mobileSummaryText.textContent = 'iPhone / iPad 上先试按钮；如果没进入 PDFreader，就改走复制地址。';
    const steps = [
      '先点“打开 PDFreader 添加页”。',
      '如果直接进了 PDFreader，就保存并同步。',
      '如果还停在 Safari，就复制书源地址。',
      '回到主屏幕里的 PDFreader，再手动添加。'
    ];
    if (payload.tlsEnabled) {
      steps.unshift('首次连接先安装 helper 证书。');
    }
    renderSteps(steps);
    return;
  }

  if (env.isIOS) {
    mobileSummaryText.textContent = '这台 iPhone / iPad 更稳的方式，是复制地址后再回到主屏幕里的 PDFreader。';
    const steps = ['先复制书源地址。', '回到主屏幕打开 PDFreader。', '进入“添加内容 -> 局域网书源”。', '粘贴地址并保存。'];
    if (payload.tlsEnabled) {
      steps.unshift('首次连接先安装 helper 证书。');
    }
    renderSteps(steps);
    return;
  }

  if (env.isAndroid && payload.addRemoteUrl) {
    mobileSummaryText.textContent = 'Android 上通常可以直接打开添加页。';
    const steps = ['先点“打开 PDFreader 添加页”。', '确认内容无误。', '点击“保存并同步”。', '如果没打开成功，再复制书源地址。'];
    if (payload.tlsEnabled) {
      steps.unshift('首次连接先安装 helper 证书。');
    }
    renderSteps(steps);
    return;
  }

  if (env.isAndroid) {
    mobileSummaryText.textContent = 'Android 上当前更稳的方式，也是先复制书源地址，再回到 PDFreader 手动添加。';
    const steps = ['先复制书源地址。', '打开 PDFreader。', '进入“添加内容 -> 局域网书源”。', '粘贴地址并保存。'];
    if (payload.tlsEnabled) {
      steps.unshift('首次连接先安装 helper 证书。');
    }
    renderSteps(steps);
    return;
  }

  mobileSummaryText.textContent = '如果按钮没有把你带进 PDFreader，就直接复制书源地址。';
  const fallbackSteps = ['先试上面的推荐动作。', '如果没有进入 PDFreader，就复制书源地址。', '打开 PDFreader 的添加页。', '粘贴地址并保存。'];
  if (payload.tlsEnabled) {
    fallbackSteps.unshift('首次连接先安装 helper 证书。');
  }
  renderSteps(fallbackSteps);
}

async function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }

  window.prompt('复制下面这个地址', value);
}

async function loadConsumerState() {
  try {
    const response = await fetch('/api/consumer');
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.message || '读取连接状态失败');
    }

    currentSourceUrl = payload.sourceBaseUrl || `${location.origin}/source`;
    title.textContent = payload.sourceName || '连接 PDFreader';
    sourceUrlText.textContent = currentSourceUrl;
    statusPill.textContent = payload.sharingEnabled ? '共享中' : '共享未开启';
    statusPill.className = `status-pill ${payload.sharingEnabled ? '' : 'is-off'}`.trim();
    if (payload.tlsEnabled && payload.certificateInstallUrl) {
      connectCertTip.hidden = false;
      connectCertActions.hidden = false;
      installCertLink.href = payload.certificateInstallUrl;
    } else {
      connectCertTip.hidden = true;
      connectCertActions.hidden = true;
      installCertLink.removeAttribute('href');
    }

    renderPrimaryAction(payload);
    renderDeviceGuide(payload);

    if (!payload.sharingEnabled) {
      setNotice('当前 helper 还没有开启共享，请回到 Mac 上点“开始共享”。');
    } else if ((payload.bookCount ?? 0) === 0) {
      setNotice('共享已经开启，但当前还没有发现 PDF，请先回到 Mac 检查共享文件夹。');
    } else if (payload.lastScanError) {
      setNotice(payload.lastScanError, 'error');
    } else {
      setNotice('');
    }
  } catch (error) {
    setNotice(error instanceof Error ? error.message : '读取连接状态失败', 'error');
  }
}

primaryButton.addEventListener('click', async () => {
  if (currentPrimaryAction.type === 'open' && currentPrimaryAction.value) {
    window.location.href = currentPrimaryAction.value;
    return;
  }

  if (currentPrimaryAction.type === 'copy' && currentPrimaryAction.value) {
    await copyText(currentPrimaryAction.value);
    setNotice('书源地址已复制。');
  }
});

copyButton.addEventListener('click', async () => {
  await copyText(currentSourceUrl);
  setNotice('书源地址已复制。');
});

void loadConsumerState();
setInterval(() => {
  void loadConsumerState();
}, 5000);
