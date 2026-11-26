(() => {
  'use strict'

  const $ = id => document.getElementById(id)
  const embedMode = new URLSearchParams(location.search).has('embed')
  const state = {
    password: sessionStorage.getItem('miot-admin') || (embedMode ? localStorage.getItem('lx_admin_password') || '' : ''),
    status: null,
    devices: [],
    playlists: [],
    commands: [],
    ai: null,
    promptDefaults: { intent: '', classify: '' },
    current: null,
    searchSongs: [],
    loginId: '',
    authTab: 'qrcode',
    qr: { loginId: '', generation: 0, timer: null, polling: false },
    editingCommand: -1,
    draggingVolume: false,
    timers: [],
  }

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]))
  const sourceLabel = source => source === 'local' ? '本地曲库' : (source || '')
  const vipBadge = song => song && song.vip ? ' <span class="vip-badge">VIP</span>' : ''

  const formatTime = seconds => {
    const total = Math.max(0, Math.round(Number(seconds) || 0))
    const min = Math.floor(total / 60)
    const sec = total % 60
    return `${min}:${String(sec).padStart(2, '0')}`
  }

  const formatDate = timestamp => {
    if (!timestamp) return '未知'
    const date = new Date(timestamp)
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }

  const formatClock = timestamp => {
    const date = new Date(timestamp)
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
  }

  const imageDataUri = base64 => {
    if (!base64) return ''
    const mime = base64.startsWith('/9j/') ? 'image/jpeg' : base64.startsWith('iVBOR') ? 'image/png' : 'image/png'
    return `data:${mime};base64,${base64}`
  }

  const readCurrent = () => {
    try {
      const parsed = JSON.parse(localStorage.getItem('miot-current') || 'null')
      return parsed && parsed.accountId && parsed.deviceId ? parsed : null
    } catch { return null }
  }

  const writeCurrent = target => {
    state.current = target
    if (target) localStorage.setItem('miot-current', JSON.stringify(target))
    else localStorage.removeItem('miot-current')
  }

  state.current = readCurrent()

  const toast = (message, type = '') => {
    const item = document.createElement('div')
    item.className = `toast-item ${type}`
    item.textContent = message
    $('toast').appendChild(item)
    setTimeout(() => item.remove(), 4200)
  }

  // ===== 主题 =====

  const isDarkTheme = () => {
    const appearance = document.documentElement.getAttribute('data-appearance')
    if (appearance === 'dark') return true
    if (appearance === 'light') return false
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  }

  const updateThemeIcon = () => {
    const icon = $('themeBtn') && $('themeBtn').querySelector('i')
    if (icon) icon.className = isDarkTheme() ? 'fas fa-sun' : 'fas fa-moon'
  }

  window.updateMiotThemeIcon = updateThemeIcon

  const toggleTheme = () => {
    const next = isDarkTheme() ? 'light' : 'dark'
    document.documentElement.setAttribute('data-appearance', next)
    try { localStorage.setItem('lx_appearance', next) } catch { /* ignore */ }
    updateThemeIcon()
  }

  const setBadge = (text, kind = '') => {
    const badge = $('statusBadge')
    badge.className = `badge ${kind}`
    badge.querySelector('span').textContent = text
  }

  const api = async (path, options = {}) => {
    const headers = { ...(options.headers || {}) }
    if (state.password) headers['x-frontend-auth'] = state.password
    let body = options.body
    if (body && typeof body === 'object') {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(body)
    }
    const response = await fetch(path, { ...options, headers, body })
    const text = await response.text()
    let data
    try { data = text ? JSON.parse(text) : {} } catch { data = { success: response.ok, message: text } }
    if (response.status === 401) {
      showLogin()
      throw new Error('后台密码不正确或已变更')
    }
    if (!response.ok) throw new Error(data.message || `请求失败 (HTTP ${response.status})`)
    return data
  }

  const showLogin = () => {
    stopTimers()
    qrReset()
    $('loginPanel').classList.remove('hidden')
    $('appPanel').classList.add('hidden')
    $('logoutBtn').classList.add('hidden')
    setBadge('未连接')
    $('adminPassword').focus()
  }

  const showApp = () => {
    $('loginPanel').classList.add('hidden')
    $('appPanel').classList.remove('hidden')
    $('logoutBtn').classList.remove('hidden')
  }

  const stopTimers = () => {
    for (const timer of state.timers) clearInterval(timer)
    state.timers = []
  }

  const startTimers = () => {
    stopTimers()
    state.timers.push(setInterval(() => {
      if (document.hidden) return
      void refreshPlayback().catch(() => {})
    }, 5000))
    state.timers.push(setInterval(() => {
      if (document.hidden) return
      void refreshDevices(false).catch(() => {})
    }, 15000))
    state.timers.push(setInterval(() => {
      if (document.hidden) return
      void refreshVoiceLog().catch(() => {})
    }, 15000))
    state.timers.push(setInterval(() => {
      if (document.hidden) return
      void refreshAi().catch(() => {})
    }, 15000))
  }

  const currentTarget = () => {
    if (state.current) {
      const exists = state.devices.some(device => device.accountId === state.current.accountId && device.deviceId === state.current.deviceId)
      if (exists) return state.current
    }
    const first = state.devices[0]
    return first ? { accountId: first.accountId, deviceId: first.deviceId } : null
  }

  const requireTarget = () => {
    const target = currentTarget()
    if (!target) throw new Error('请先添加并选择一个设备')
    if (!state.current) {
      writeCurrent(target)
      renderDevices()
    }
    return target
  }

  const targetName = target => {
    const device = state.devices.find(item => item.accountId === target.accountId && item.deviceId === target.deviceId)
    return device ? device.name : '未选择设备'
  }

  // ===== 连接与设置 =====

  const connect = async () => {
    const data = await api('/api/miot/status')
    applyStatus(data)
    showApp()
    await Promise.all([
      refreshDevices(true),
      refreshPlaylists(),
      refreshCommands(),
      refreshVoiceLog(),
    ])
    startTimers()
    if (state.authTab === 'qrcode' && !state.qr.loginId) void startQRCode()
  }

  const applyStatus = data => {
    state.status = data
    if (data.promptDefaults) state.promptDefaults = data.promptDefaults
    fillSettings(data.settings)
    renderAccounts(data.accounts || [])
    renderUserOptions(data.lxUsers || [])
    $('streamBaseUrl').textContent = data.streamBaseUrl || ''
    $('footerStream').textContent = data.streamBaseUrl ? `推流地址 ${data.streamBaseUrl}` : ''
    $('heroEnabled').textContent = data.settings.enabled ? '集成已启用' : '集成已停用'
    $('heroEnabled').className = `pill ${data.settings.enabled ? 'ok' : 'bad'}`
    applyAi(data.ai)
    setBadge(data.settings.enabled ? `已连接 · ${data.devices.length} 台设备` : '已连接 · 集成停用', data.settings.enabled ? 'ok' : 'warn')
  }
  const refreshStatus = async () => {
    const data = await api('/api/miot/status')
    applyStatus(data)
    return data
  }

  const applyAi = ai => {
    if (!ai) return
    state.ai = ai
    const pill = $('heroAi')
    if (ai.error) {
      pill.textContent = 'AI分析异常'
      pill.className = 'pill bad'
    } else if (ai.enabled) {
      pill.textContent = `AI分析开启 · 今日 ${ai.dailyCount}/${ai.dailyLimit}`
      pill.className = 'pill ok'
    } else {
      pill.textContent = 'AI分析关闭'
      pill.className = 'pill'
    }
    const error = ai.error
    $('aiErrorPanel').classList.toggle('hidden', !error)
    if (error) {
      $('aiErrorText').textContent = error.message || '未知错误'
      $('aiErrorMeta').textContent = [
        error.at ? `发生时间 ${formatDate(error.at)}` : '',
        error.device_name ? `设备 ${error.device_name}` : '',
      ].filter(Boolean).join(' · ')
    }
  }

  const refreshAi = async () => {
    const data = await api('/api/miot/ai')
    applyAi(data)
    return data
  }

  const clearAiError = async () => {
    if (!confirm('确认错误已处理并清除记录？清除后需要到运行设置里手动重新打开 AI分析开关。')) return
    try {
      const data = await api('/api/miot/ai/clear-error', { method: 'POST', body: {} })
      applyAi(data)
      toast('AI 错误记录已清除，请手动重新打开 AI分析开关', 'ok')
    } catch (err) { toast(err.message, 'error') }
  }

  const renderUserOptions = users => {
    $('lxUserList').innerHTML = users.map(user => `<option value="${esc(user)}"></option>`).join('')
  }

  const customPrompt = (id, defaultText) => {
    const value = $(id).value.trim()
    return value && value !== String(defaultText || '').trim() ? value : ''
  }

  const fillSettings = settings => {
    if (!settings) return
    $('setEnabled').checked = !!settings.enabled
    $('setUsername').value = settings.username || ''
    $('setQuality').value = settings.quality || '320k'
    $('setBaseUrl').value = settings.public_base_url || ''
    $('setPoll').value = settings.poll_interval_sec || 2
    $('setDefaultList').value = settings.default_playlist_id || 'default'
    $('setVoice').checked = !!settings.voice_enabled
    $('setAutoNext').checked = !!settings.auto_next
    $('setCacheOnPlay').checked = !!settings.cache_on_play
    $('setVipAutoDownload').checked = !!settings.vip_auto_download
    $('setKeepLight').checked = !!settings.keep_light
    $('setAnnounce').checked = !!settings.announce_song
    $('setAiAnalysis').checked = !!settings.ai_recommend_enabled
    $('setAiDailyLimit').value = settings.ai_daily_limit || 60
    $('setAiFailureThreshold').value = settings.ai_failure_threshold || 3
    $('setAiFailureWindow').value = settings.ai_failure_window_min || 10
    $('setAiIntentPrompt').value = settings.ai_intent_prompt || state.promptDefaults.intent || ''
    $('setAiClassifyPrompt').value = settings.ai_classify_prompt || state.promptDefaults.classify || ''
  }

  const saveSettings = async event => {
    event.preventDefault()
    const body = {
      enabled: $('setEnabled').checked,
      username: $('setUsername').value.trim(),
      quality: $('setQuality').value,
      public_base_url: $('setBaseUrl').value.trim(),
      poll_interval_sec: Number($('setPoll').value) || 2,
      default_playlist_id: $('setDefaultList').value.trim() || 'default',
      voice_enabled: $('setVoice').checked,
      auto_next: $('setAutoNext').checked,
      cache_on_play: $('setCacheOnPlay').checked,
      vip_auto_download: $('setVipAutoDownload').checked,
      keep_light: $('setKeepLight').checked,
      announce_song: $('setAnnounce').checked,
      ai_recommend_enabled: $('setAiAnalysis').checked,
      ai_daily_limit: Number($('setAiDailyLimit').value) || 60,
      ai_failure_threshold: Number($('setAiFailureThreshold').value) || 3,
      ai_failure_window_min: Number($('setAiFailureWindow').value) || 10,
      ai_intent_prompt: customPrompt('setAiIntentPrompt', state.promptDefaults.intent),
      ai_classify_prompt: customPrompt('setAiClassifyPrompt', state.promptDefaults.classify),
    }
    try {
      const data = await api('/api/miot/settings', { method: 'POST', body })
      toast('设置已保存', 'ok')
      const nextStatus = { ...state.status, settings: data.settings }
      if (data.promptDefaults) nextStatus.promptDefaults = data.promptDefaults
      if (data.ai) nextStatus.ai = data.ai
      applyStatus(nextStatus)
      await refreshPlaylists()
    } catch (err) {
      toast(err.message, 'error')
      await refreshAi().catch(() => {})
    }
  }

  // ===== 小米账号 =====

  const renderAccounts = accounts => {
    if (!accounts.length) {
      $('accountList').innerHTML = '<div class="muted">尚未登录小米账号</div>'
      return
    }
    $('accountList').innerHTML = accounts.map(account => `
      <div class="list-item">
        <div class="main">
          <div class="title">${esc(account.username)}</div>
          <div class="sub">userId ${esc(account.user_id || '-')} · 上次登录 ${formatDate(account.last_login_at)} · token ${formatDate(account.token_expires_at)} 到期</div>
        </div>
        <button class="small" data-account-action="sync" data-account="${esc(account.id)}">同步设备</button>
        <button class="small danger" data-account-action="logout" data-account="${esc(account.id)}">退出</button>
      </div>
    `).join('')
  }

  const handleLoginResult = async result => {
    if (result.state === 'success') {
      state.loginId = ''
      qrReset()
      $('captchaBox').classList.add('hidden')
      $('verifyBox').classList.add('hidden')
      $('miPassword').value = ''
      toast('小米账号登录成功', 'ok')
      await refreshStatus()
      await refreshDevices(true)
      return
    }
    if (result.state === 'need_captcha') {
      state.loginId = result.loginId || ''
      $('verifyBox').classList.add('hidden')
      $('captchaImage').src = imageDataUri(result.captchaImage)
      $('captchaInput').value = ''
      $('captchaBox').classList.remove('hidden')
      toast(result.captchaImage ? '请输入图片验证码' : (result.error || '获取验证码失败'), result.captchaImage ? '' : 'error')
      return
    }
    if (result.state === 'need_verify') {
      state.loginId = result.loginId || ''
      $('captchaBox').classList.add('hidden')
      $('verifyBox').classList.remove('hidden')
      $('verifyTip').textContent = result.verifyType === 'email' ? '需要邮箱验证码，请查收邮箱' : '需要短信验证码，请查收手机短信'
      $('verifyLink').href = result.verifyUrl || '#'
      $('verifyInput').value = ''
      toast(result.error || '账号需要安全验证', '')
      return
    }
    toast(result.error || '登录失败', 'error')
  }

  const miLogin = async () => {
    const username = $('miUsername').value.trim()
    const password = $('miPassword').value
    if (!username || !password) { toast('请输入小米账号和密码', 'error'); return }
    try {
      const result = await api('/api/miot/login', { method: 'POST', body: { username, password } })
      await handleLoginResult(result)
    } catch (err) { toast(err.message, 'error') }
  }

  const captchaLogin = async () => {
    const captcha = $('captchaInput').value.trim()
    if (!captcha) { toast('请输入图片验证码', 'error'); return }
    try {
      const result = await api('/api/miot/login/captcha', { method: 'POST', body: { loginId: state.loginId, captcha } })
      await handleLoginResult(result)
    } catch (err) { toast(err.message, 'error') }
  }

  const verifyLogin = async () => {
    const code = $('verifyInput').value.trim()
    if (!code) { toast('请输入验证码', 'error'); return }
    try {
      const result = await api('/api/miot/login/verify', { method: 'POST', body: { loginId: state.loginId, code } })
      await handleLoginResult(result)
    } catch (err) { toast(err.message, 'error') }
  }

  const tokenLogin = async () => {
    const body = {
      username: $('miUsername').value.trim() || '手动Token',
      userId: $('tokenUserId').value.trim(),
      serviceToken: $('tokenServiceToken').value.trim(),
      ssecurity: $('tokenSsecurity').value.trim(),
    }
    if (!body.userId || !body.serviceToken) { toast('请填写 userId 和 serviceToken', 'error'); return }
    try {
      const result = await api('/api/miot/login/token', { method: 'POST', body })
      await handleLoginResult(result)
    } catch (err) { toast(err.message, 'error') }
  }

  // ===== 扫码登录 =====

  const setQRStatus = (text, kind = '') => {
    const el = $('qrStatus')
    if (!el) return
    el.textContent = text
    el.className = `qr-status${kind ? ` ${kind}` : ''}`
  }

  const qrStopTimer = () => {
    if (state.qr.timer) {
      clearTimeout(state.qr.timer)
      state.qr.timer = null
    }
  }

  const qrReset = () => {
    state.qr.generation++
    qrStopTimer()
    state.qr.loginId = ''
    state.qr.polling = false
  }

  const qrShowPlaceholder = () => {
    const image = $('qrImage')
    image.classList.add('hidden')
    image.removeAttribute('src')
    $('qrPlaceholder').classList.remove('hidden')
    $('qrLoginLink').classList.add('hidden')
  }

  const scheduleQRPoll = (delay, generation) => {
    qrStopTimer()
    state.qr.timer = setTimeout(() => {
      state.qr.timer = null
      void pollQRCode(generation)
    }, delay)
  }

  const pollQRCode = async generation => {
    if (generation !== state.qr.generation || !state.qr.loginId || state.authTab !== 'qrcode') return
    if (state.qr.polling) {
      scheduleQRPoll(600, generation)
      return
    }

    state.qr.polling = true
    try {
      const data = await api('/api/miot/login/qrcode/poll', {
        method: 'POST',
        body: { loginId: state.qr.loginId },
      })
      if (generation !== state.qr.generation) return

      if (data.state === 'success' || data.success) {
        state.qr.loginId = ''
        setQRStatus('登录成功，正在同步设备…', 'ok')
        qrShowPlaceholder()
        toast('小米账号登录成功', 'ok')
        await refreshStatus()
        await refreshDevices(true)
        return
      }

      if (data.state === 'expired' || data.state === 'failed') {
        state.qr.loginId = ''
        setQRStatus(data.message || (data.state === 'expired' ? '二维码已过期，请刷新' : '登录失败，请重试'), 'error')
        return
      }

      setQRStatus('等待扫码…（扫码后请在手机上确认）')
      if (state.authTab === 'qrcode' && !document.hidden) scheduleQRPoll(900, generation)
    } catch (err) {
      if (generation !== state.qr.generation) return
      setQRStatus(err.message, 'error')
      if (err.message !== '后台密码不正确或已变更' && state.authTab === 'qrcode' && !document.hidden) {
        scheduleQRPoll(2000, generation)
      }
    } finally {
      if (generation === state.qr.generation) state.qr.polling = false
    }
  }

  const startQRCode = async () => {
    qrReset()
    const generation = state.qr.generation
    qrShowPlaceholder()
    setQRStatus('正在获取二维码…')
    try {
      const data = await api('/api/miot/login/qrcode', { method: 'POST', body: {} })
      if (generation !== state.qr.generation) return
      if (!data.success || !data.qrcodeUrl) {
        setQRStatus(data.message || '获取二维码失败', 'error')
        return
      }
      state.qr.loginId = data.loginId || ''
      $('qrImage').src = data.qrcodeUrl
      $('qrImage').classList.remove('hidden')
      $('qrPlaceholder').classList.add('hidden')
      if (data.loginUrl) {
        $('qrLoginLink').href = data.loginUrl
        $('qrLoginLink').classList.remove('hidden')
      }
      setQRStatus('等待扫码…（扫码后请在手机上确认）')
      if (state.authTab === 'qrcode' && !document.hidden) scheduleQRPoll(800, generation)
    } catch (err) {
      if (generation !== state.qr.generation) return
      setQRStatus(err.message, 'error')
    }
  }

  const switchAuthTab = tab => {
    state.authTab = tab
    document.querySelectorAll('[data-auth-tab]').forEach(button => {
      button.classList.toggle('active', button.dataset.authTab === tab)
    })
    const panels = { qrcode: 'qrPanel', password: 'passwordPanel', token: 'tokenPanel' }
    for (const [name, id] of Object.entries(panels)) {
      $(id).classList.toggle('hidden', name !== tab)
    }
    if (tab === 'qrcode') {
      if (!state.qr.loginId) void startQRCode()
      else if (!state.qr.timer && !state.qr.polling) scheduleQRPoll(400, state.qr.generation)
    } else {
      qrStopTimer()
    }
  }

  const handleAccountAction = async event => {
    const target = event.target.closest('[data-account-action]')
    if (!target) return
    const accountId = target.dataset.account
    try {
      if (target.dataset.accountAction === 'sync') {
        await api('/api/miot/devices/sync', { method: 'POST', body: { accountId } })
        toast('设备已同步', 'ok')
        await refreshStatus()
        await refreshDevices(true)
        return
      }
      if (target.dataset.accountAction === 'logout') {
        if (!confirm('确定退出该小米账号？其设备与播放记录会被移除。')) return
        await api('/api/miot/logout', { method: 'POST', body: { accountId } })
        toast('已退出账号', 'ok')
        if (state.current && state.current.accountId === accountId) writeCurrent(null)
        await refreshStatus()
        await refreshDevices(true)
      }
    } catch (err) { toast(err.message, 'error') }
  }

  // ===== 设备 =====

  const renderDevices = () => {
    if (!state.devices.length) {
      $('deviceList').innerHTML = '<div class="muted">没有设备。请先登录小米账号并同步设备。</div>'
      renderVoiceDevices()
      updateCurrentLabel()
      return
    }
    const active = currentTarget()
    $('deviceList').innerHTML = state.devices.map(device => {
      const isActive = active && active.accountId === device.accountId && active.deviceId === device.deviceId
      const sub = [device.model || device.hardware || '未知型号', device.accountName, device.presence ? `在线状态 ${device.presence}` : '', `音量 ${device.volume}`]
        .filter(Boolean).join(' · ')
      return `
        <div class="list-item ${isActive ? 'active' : ''}" data-account="${esc(device.accountId)}" data-device="${esc(device.deviceId)}">
          <div class="main">
            <div class="title">${esc(device.name)} ${isActive ? '<span class="pill ok">当前</span>' : ''}</div>
            <div class="sub">${esc(sub)}</div>
          </div>
          <label class="switch" title="托管给本服务">
            <input type="checkbox" data-device-action="managed" ${device.managed ? 'checked' : ''}>
          </label>
          <label class="switch" title="启用语音口令">
            <input type="checkbox" data-device-action="voice" ${device.voiceEnabled ? 'checked' : ''}>
          </label>
          <button class="small" data-device-action="use">使用</button>
        </div>
      `
    }).join('')
    renderVoiceDevices()
    updateCurrentLabel()
  }

  const updateCurrentLabel = () => {
    const target = currentTarget()
    $('currentDeviceLabel').textContent = target ? `当前设备：${targetName(target)}` : '未选择设备'
  }

  const refreshDevices = async render => {
    const previousCount = state.devices.length
    const data = await api('/api/miot/devices')
    state.devices = data.devices || []
    if (render !== false || previousCount !== state.devices.length) {
      renderDevices()
    } else {
      // 轻量刷新仅更新标签与音量，避免打断复选框操作
      updateCurrentLabel()
      renderVoiceDevices()
      state.devices.forEach(device => {
        const row = document.querySelector(`.list-item[data-account="${cssEscape(device.accountId)}"][data-device="${cssEscape(device.deviceId)}"]`)
        if (!row) return
        const managed = row.querySelector('[data-device-action="managed"]')
        const voice = row.querySelector('[data-device-action="voice"]')
        if (managed && document.activeElement !== managed) managed.checked = device.managed
        if (voice && document.activeElement !== voice) voice.checked = device.voiceEnabled
      })
    }
    const target = currentTarget()
    if (target) {
      if (!state.current) writeCurrent(target)
      applyPlayback((data.playback || []).find(item => item && item.accountId === target.accountId && item.deviceId === target.deviceId) || null)
    }
  }

  const cssEscape = value => {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value))
    return String(value).replace(/["\\]/g, '\\$&')
  }

  const updateDevice = async (accountId, deviceId, patch) => {
    await api('/api/miot/device', { method: 'POST', body: { accountId, deviceId, ...patch } })
    const index = state.devices.findIndex(item => item.accountId === accountId && item.deviceId === deviceId)
    if (index >= 0) Object.assign(state.devices[index], patch)
    toast('设备设置已更新', 'ok')
    if (patch.managed !== undefined || patch.voice_enabled !== undefined) await refreshDevices(false)
  }

  const handleDeviceChange = async event => {
    const checkbox = event.target.closest('input[data-device-action]')
    if (!checkbox) return
    const row = checkbox.closest('.list-item')
    if (!row) return
    const action = checkbox.dataset.deviceAction
    try {
      if (action === 'managed') await updateDevice(row.dataset.account, row.dataset.device, { managed: checkbox.checked })
      if (action === 'voice') await updateDevice(row.dataset.account, row.dataset.device, { voice_enabled: checkbox.checked })
    } catch (err) {
      checkbox.checked = !checkbox.checked
      toast(err.message, 'error')
    }
  }

  const handleDeviceClick = async event => {
    const button = event.target.closest('button[data-device-action="use"]')
    if (!button) return
    const row = button.closest('.list-item')
    if (!row) return
    writeCurrent({ accountId: row.dataset.account, deviceId: row.dataset.device })
    renderDevices()
    try { await refreshPlayback() } catch { /* ignore */ }
    toast(`已选择 ${targetName(state.current)}`, 'ok')
  }

  // ===== 歌单与搜索 =====

  const refreshPlaylists = async () => {
    try {
      const data = await api('/api/miot/playlists')
      state.playlists = data.playlists || []
      const settings = state.status ? state.status.settings : {}
      const preferred = settings.default_playlist_id || 'default'
      const selected = $('playlistSelect').value || preferred
      $('playlistSelect').innerHTML = state.playlists.map(list =>
        `<option value="${esc(list.id)}">${esc(list.name)} (${list.count}${list.builtin ? '' : ''})</option>`
      ).join('')
      if (state.playlists.some(list => list.id === selected)) $('playlistSelect').value = selected
      const saveSelect = $('saveToListSelect')
      const previousSave = saveSelect.value
      saveSelect.innerHTML = state.playlists.map(list =>
        `<option value="${esc(list.id)}">${esc(list.name)} (${list.count})</option>`
      ).join('')
      if (state.playlists.some(list => list.id === previousSave)) saveSelect.value = previousSave
      else if (state.playlists.some(list => list.id === 'love')) saveSelect.value = 'love'
      if (!data.success && data.message) toast(data.message, 'error')
    } catch (err) { toast(err.message, 'error') }
  }

  const playPlaylist = async () => {
    const listId = $('playlistSelect').value
    if (!listId) { toast('请先选择歌单', 'error'); return }
    try {
      const target = requireTarget()
      const data = await api('/api/miot/play', { method: 'POST', body: { ...target, listId } })
      applyPlayback(data.playback)
      toast(data.success ? '已开始播放歌单' : (data.playback && data.playback.error) || '播放失败', data.success ? 'ok' : 'error')
    } catch (err) { toast(err.message, 'error') }
  }

  const search = async () => {
    const keyword = $('searchInput').value.trim()
    if (!keyword) { toast('请输入搜索关键词', 'error'); return }
    $('searchResults').innerHTML = '<div class="muted">搜索中...</div>'
    try {
      const data = await api(`/api/miot/search?keyword=${encodeURIComponent(keyword)}`)
      const songs = data.songs || []
      if (!songs.length) {
        $('searchResults').innerHTML = '<div class="muted">没有找到可播放的歌曲（请检查音源是否启用）</div>'
        return
      }
      $('searchResults').innerHTML = songs.map((song, index) => `
        <div class="list-item">
          <div class="main">
            <div class="title">${esc(song.name)}${vipBadge(song)}</div>
            <div class="sub">${esc(song.singer || '未知歌手')} · ${esc(sourceLabel(song.source))} ${song.interval ? `· ${esc(song.interval)}` : ''}</div>
          </div>
          <button class="small" data-song-index="${index}">播放</button>
        </div>
      `).join('') + '<div class="row"><button class="small primary" id="playAllSearchBtn">播放全部搜索结果</button></div>'
      state.searchSongs = songs
    } catch (err) { toast(err.message, 'error'); $('searchResults').innerHTML = '' }
  }

  const playSongs = async (songs, name) => {
    try {
      const target = requireTarget()
      const data = await api('/api/miot/play', { method: 'POST', body: { ...target, songs, name } })
      applyPlayback(data.playback)
      toast(data.success ? `开始播放：${songs[0] ? songs[0].name : name}` : (data.playback && data.playback.error) || '播放失败', data.success ? 'ok' : 'error')
    } catch (err) { toast(err.message, 'error') }
  }

  const handleSearchClick = async event => {
    const songButton = event.target.closest('[data-song-index]')
    if (songButton) {
      const song = (state.searchSongs || [])[Number(songButton.dataset.songIndex)]
      if (song) await playSongs([song], '搜索单曲')
      return
    }
    if (event.target.id === 'playAllSearchBtn') {
      if (state.searchSongs && state.searchSongs.length) await playSongs(state.searchSongs, '搜索结果')
    }
  }

  // ===== 播放控制 =====

  const applyPlayback = view => {
    if (!view) {
      $('nowSong').textContent = '暂无播放'
      $('nowArtist').textContent = '选择歌单或搜索歌曲开始'
      $('playStatus').textContent = 'idle'
      $('playStatus').className = 'pill'
      $('playTime').textContent = '0:00 / 0:00'
      $('playListName').textContent = ''
      $('progressBar').style.width = '0%'
      $('playbackError').textContent = ''
      return
    }
    $('nowSong').innerHTML = view.song ? `${esc(view.song.name)}${vipBadge(view.song)}` : '暂无播放'
    $('nowArtist').textContent = view.song ? `${view.song.singer || '未知歌手'} · ${sourceLabel(view.song.source)}` : '选择歌单或搜索歌曲开始'
    const statusText = {
      idle: '空闲', loading: '加载中', playing: '播放中', paused: '已暂停', stopped: '已停止', error: '出错',
    }[view.status] || view.status
    $('playStatus').textContent = statusText
    $('playStatus').className = `pill ${view.status === 'playing' ? 'ok' : view.status === 'error' ? 'bad' : ''}`
    $('playTime').textContent = `${formatTime(view.position)} / ${formatTime(view.duration)}`
    $('playListName').textContent = view.listName ? `${view.listName}${view.count ? ` · 第 ${view.index + 1}/${view.count} 首` : ''}` : ''
    const percent = view.duration > 0 ? Math.min(100, Math.max(0, view.position / view.duration * 100)) : 0
    $('progressBar').style.width = `${percent}%`
    $('playbackError').textContent = view.error || ''
    if (view.volume !== undefined && !state.draggingVolume) {
      $('volumeRange').value = view.volume
      $('volumeLabel').textContent = view.volume
    }
    if (view.mode) $('modeSelect').value = view.mode
    if (view.status === 'loading') {
      $('nowSong').innerHTML = view.song ? `${esc(view.song.name)}${vipBadge(view.song)}（正在获取播放链接…）` : '正在加载…'
    }
  }

  const refreshPlayback = async () => {
    const target = currentTarget()
    if (!target) return
    const data = await api(`/api/miot/playback?accountId=${encodeURIComponent(target.accountId)}&deviceId=${encodeURIComponent(target.deviceId)}`)
    applyPlayback(data.playback)
  }

  const playerAction = async (action, value, extra = {}) => {
    try {
      const target = requireTarget()
      const data = await api('/api/miot/player', { method: 'POST', body: { ...target, action, value, ...extra } })
      applyPlayback(data.playback)
      if (action === 'volume') toast(`音量 ${data.volume}`, 'ok')
      else if (action === 'sync-volume') toast(`设备音量 ${data.volume}`, 'ok')
      else if (action === 'add-to-list') { /* 由调用方按 result 提示 */ }
      else if (!data.success) toast((data.playback && data.playback.error) || '操作未成功', 'error')
      return data
    } catch (err) { toast(err.message, 'error'); return null }
  }

  const saveCurrentToList = async () => {
    const select = $('saveToListSelect')
    const listId = select.value
    if (!listId) { toast('请选择目标歌单', 'error'); return }
    const listName = state.playlists.find(list => list.id === listId)?.name || listId
    const data = await playerAction('add-to-list', undefined, { listId })
    if (!data) return
    if (data.result === 'added') {
      toast(`已收藏到 ${listName}`, 'ok')
      void refreshPlaylists()
    } else if (data.result === 'exists') toast(`已在 ${listName} 中`, 'ok')
    else if (data.result === 'no-song') toast('当前没有播放歌曲', 'error')
    else if (data.result === 'not-found') toast('歌单不存在，请刷新歌单后重试', 'error')
    else toast('收藏失败', 'error')
  }

  const changeVolume = async () => {
    const value = Number($('volumeRange').value)
    $('volumeLabel').textContent = value
    await playerAction('volume', value)
  }

  // ===== 语音 =====

  const renderVoiceDevices = () => {
    const select = $('voiceDeviceSelect')
    const previous = select.value
    select.innerHTML = state.devices.map(device =>
      `<option value="${esc(device.accountId + '|' + device.deviceId)}">${esc(device.name)}${device.voiceEnabled ? '' : '（语音关闭）'}</option>`
    ).join('')
    const target = currentTarget()
    if (previous && state.devices.some(d => `${d.accountId}|${d.deviceId}` === previous)) select.value = previous
    else if (target) select.value = `${target.accountId}|${target.deviceId}`
  }

  const voiceTarget = () => {
    const value = $('voiceDeviceSelect').value
    if (value && value.includes('|')) {
      const [accountId, deviceId] = value.split('|')
      return { accountId, deviceId }
    }
    return currentTarget()
  }

  const COMMAND_TYPES = [
    ['play_playlist', '播放歌单（关键词后的内容作为歌单名）'],
    ['play_chart', '播放榜单（关键词后的内容作为榜单名）'],
    ['play_song', '播放歌曲（关键词后的内容作为歌名）'],
    ['play_artist', '播放歌手（关键词后的内容作为歌手名）'],
    ['play_index', '跳到第 N 首（关键词需包含“第”）'],
    ['set_play_mode', '切换播放模式'],
    ['set_volume', '同步音量（音量由音箱固件处理）'],
    ['next', '下一首'],
    ['previous', '上一首'],
    ['resume', '继续播放'],
    ['stop', '停止播放'],
    ['favorite', '收藏 / 取消收藏'],
    ['favorite_to', '收藏到指定歌单（关键词后的内容作为歌单名）'],
    ['dislike_song', '不喜欢当前歌曲（同步到“不喜欢歌曲”）'],
    ['dislike_artist', '不喜欢当前歌手（同步到“不喜欢歌手”）'],
    ['dislike_album', '不喜欢当前专辑（同步到“不喜欢专辑”）'],
    ['sleep_timer', '睡眠定时'],
    ['cancel_sleep_timer', '取消睡眠定时'],
    ['query_sleep_timer', '查询睡眠定时'],
  ]

  const COMMAND_TYPE_LABELS = Object.fromEntries(COMMAND_TYPES)
  const MODE_OPTIONS = [['shuffle', '随机播放'], ['single', '单曲循环'], ['singlePlay', '单曲播放'], ['loop', '列表循环'], ['order', '顺序播放']]
  const FAVORITE_OPTIONS = [['add', '收藏'], ['remove', '取消收藏']]
  const DISLIKE_OPTIONS = [['add', '不喜欢'], ['remove', '取消不喜欢']]
  const PARAM_SELECT_OPTIONS = {
    set_play_mode: MODE_OPTIONS,
    favorite: FAVORITE_OPTIONS,
    dislike_song: DISLIKE_OPTIONS,
    dislike_artist: DISLIKE_OPTIONS,
    dislike_album: DISLIKE_OPTIONS,
  }
  const useParamSelect = type => Object.prototype.hasOwnProperty.call(PARAM_SELECT_OPTIONS, type)
  const COMMAND_HINTS = {
    play_playlist: '关键词后的内容会作为歌单名；本地歌单存在时优先播放本地，本地不存在或为空时才搜索在线歌单；不带歌单名时使用默认歌单。',
    play_chart: '关键词后的内容会作为榜单名，例如“播放榜单 飙升榜”；不带榜单名时播放热歌榜。优先使用在线音源榜单，失败后回退本地歌单或本地曲库。',
    play_song: '关键词后的内容会作为歌名，去落雪自定义音源搜索后播放。',
    play_artist: '关键词后的内容会作为歌手名，去落雪自定义音源搜索后播放。',
    play_index: '关键词中需要保留“第”，例如“切换到第”“跳到第”。',
    set_volume: '音量由小爱固件原生处理，口令只用于触发音量回读。',
    sleep_timer: '关键词要能配合“分钟后停止”“首歌后停止”等时长说法使用。',
    favorite: '参数决定命中后是收藏还是取消收藏。',
    favorite_to: '关键词后的内容会作为歌单名，把当前播放歌曲加入该歌单。',
    dislike_song: '只记录当前歌曲与歌手这一版（歌名@歌手），不会连带屏蔽整首歌或整个歌手；标记成功后自动切到下一首，取消不喜欢不切歌。',
    dislike_artist: '把当前歌曲的歌手加入“不喜欢歌手”，合唱歌曲会拆分并加入所有歌手；标记成功后自动切到下一首，取消时按同样口径移除且不切歌。',
    dislike_album: '把当前歌曲的专辑加入“不喜欢专辑”；标记成功后自动切到下一首，取消时按同名专辑移除且不切歌。',
  }

  const commandTypeLabel = type => COMMAND_TYPE_LABELS[type] || type

  const refreshCommands = async () => {
    try {
      const data = await api('/api/miot/voice/commands')
      state.commands = data.commands || []
      renderCommands()
    } catch (err) { toast(err.message, 'error') }
  }

  const renderCommands = () => {
    if (!state.commands.length) {
      $('commandList').innerHTML = '<div class="muted">暂无口令</div>'
      return
    }
    $('commandList').innerHTML = state.commands.map((command, index) => `
      <div class="voice-cmd" data-command-index="${index}">
        <label class="switch" title="启用">
          <input type="checkbox" ${command.enabled ? 'checked' : ''}>
        </label>
        <div style="flex:1;min-width:0">
          <div class="type">${esc(commandTypeLabel(command.type))}${command.param ? ` · ${esc(command.param)}` : ''}</div>
          <div class="keywords">${command.keywords.map(esc).join(' / ')}</div>
        </div>
        <div class="voice-cmd-actions">
          <button type="button" class="cmd-action" data-command-action="edit" title="编辑"><i class="fas fa-pen"></i></button>
          <button type="button" class="cmd-action danger" data-command-action="delete" title="删除"><i class="fas fa-trash"></i></button>
        </div>
      </div>
    `).join('')
  }

  const syncCommandParamField = () => {
    const type = $('cmdType').value
    const field = $('cmdParamField')
    const select = $('cmdParamSelect')
    const input = $('cmdParamInput')
    const options = PARAM_SELECT_OPTIONS[type] || null
    field.classList.remove('hidden')
    if (options) {
      select.classList.remove('hidden')
      input.classList.add('hidden')
      select.innerHTML = options.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')
    } else {
      select.classList.add('hidden')
      input.classList.remove('hidden')
    }
    $('cmdHint').textContent = COMMAND_HINTS[type] || ''
  }

  const openCommandEditor = index => {
    const command = index >= 0 ? state.commands[index] : null
    state.editingCommand = command ? index : -1
    $('commandEditorTitle').textContent = command ? '编辑口令' : '添加自定义口令'
    $('cmdType').innerHTML = COMMAND_TYPES.map(([type, label]) => `<option value="${esc(type)}">${esc(label)}</option>`).join('')
    if (command && !COMMAND_TYPES.some(([type]) => type === command.type)) {
      const option = document.createElement('option')
      option.value = command.type
      option.textContent = command.type
      $('cmdType').appendChild(option)
    }
    $('cmdType').value = command ? command.type : 'play_song'
    $('cmdKeywords').value = command ? command.keywords.join(', ') : ''
    $('cmdEnabled').checked = command ? command.enabled : true
    syncCommandParamField()
    const useSelect = command && useParamSelect(command.type)
    if (useSelect && command.param) {
      if ([...$('cmdParamSelect').options].some(option => option.value === command.param)) $('cmdParamSelect').value = command.param
      $('cmdParamInput').value = ''
    } else if (command && command.param) {
      $('cmdParamInput').value = command.param
    } else {
      $('cmdParamInput').value = ''
    }
    $('commandEditor').classList.remove('hidden')
    $('commandEditor').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    $('cmdKeywords').focus()
  }

  const closeCommandEditor = () => {
    state.editingCommand = -1
    $('commandEditor').classList.add('hidden')
  }

  const saveCommandEditor = async () => {
    const type = $('cmdType').value
    const keywords = [...new Set($('cmdKeywords').value.split(/[,，、\n]/).map(item => item.trim()).filter(Boolean))]
    if (!keywords.length) { toast('请至少填写一个关键词', 'error'); return }
    const useSelect = useParamSelect(type)
    const command = {
      type,
      keywords,
      param: useSelect ? $('cmdParamSelect').value : ($('cmdParamInput').value.trim() || undefined),
      enabled: $('cmdEnabled').checked,
    }
    const commands = state.commands.slice()
    if (state.editingCommand >= 0) commands[state.editingCommand] = command
    else commands.push(command)
    try {
      const data = await api('/api/miot/voice/commands', { method: 'POST', body: { commands } })
      state.commands = data.commands || []
      closeCommandEditor()
      renderCommands()
      toast('口令已保存', 'ok')
    } catch (err) { toast(err.message, 'error') }
  }

  const deleteCommand = async index => {
    const command = state.commands[index]
    if (!command || !confirm(`删除口令「${command.keywords.join(' / ')}」？`)) return
    const commands = state.commands.filter((_, itemIndex) => itemIndex !== index)
    try {
      const data = await api('/api/miot/voice/commands', { method: 'POST', body: { commands } })
      state.commands = data.commands || []
      if (state.editingCommand >= 0) closeCommandEditor()
      renderCommands()
      toast('口令已删除', 'ok')
    } catch (err) { toast(err.message, 'error') }
  }

  const saveCommands = async () => {
    const commands = state.commands.map((command, index) => {
      const row = document.querySelector(`[data-command-index="${index}"]`)
      const checkbox = row ? row.querySelector('input[type="checkbox"]') : null
      return { ...command, enabled: checkbox ? checkbox.checked : command.enabled }
    })
    try {
      const data = await api('/api/miot/voice/commands', { method: 'POST', body: { commands } })
      state.commands = data.commands || []
      renderCommands()
      toast('口令开关已保存', 'ok')
    } catch (err) { toast(err.message, 'error') }
  }

  const resetCommands = async () => {
    if (!confirm('恢复默认口令并覆盖当前口令表？')) return
    try {
      const data = await api('/api/miot/voice/commands/reset', { method: 'POST', body: {} })
      state.commands = data.commands || []
      renderCommands()
      toast('已恢复默认口令', 'ok')
    } catch (err) { toast(err.message, 'error') }
  }

  const testVoice = async execute => {
    const query = $('voiceTestInput').value.trim()
    if (!query) { toast('请输入要测试的语音指令', 'error'); return }
    const target = voiceTarget()
    try {
      const data = await api('/api/miot/voice/test', {
        method: 'POST',
        body: { query, execute, accountId: target ? target.accountId : undefined, deviceId: target ? target.deviceId : undefined },
      })
      $('voiceTestResult').textContent = JSON.stringify(data, null, 2)
      if (!data.matched) toast('没有匹配到口令', 'error')
      else toast(`匹配 ${data.command}${data.executed ? ' 已执行' : ''}`, data.executed ? 'ok' : '')
      if (execute) {
        await refreshPlayback().catch(() => {})
        await refreshVoiceLog()
      }
    } catch (err) { toast(err.message, 'error') }
  }

  const AI_LOG_LABELS = {
    ai_classify: 'AI 内部询问',
    ai_classify_request: 'AI 分类请求',
    ai_classify_result: 'AI 分类返回',
    ai_intent_request: 'AI 指令解析请求',
    ai_intent_result: 'AI 指令解析返回',
    ai_retry: 'AI 暂时未响应',
    ai_recommend: 'AI 同类推荐',
    ai_error: 'AI 异常',
  }

  const refreshVoiceLog = async () => {
    try {
      const data = await api('/api/miot/voice/log')
      const messages = data.messages || []
      if (!messages.length) {
        $('voiceLog').textContent = '暂无记录'
        return
      }
      $('voiceLog').textContent = messages.slice(0, 60).map(message => {
        const commandLabel = AI_LOG_LABELS[message.command] || message.command || '无'
        let status
        if (message.command === 'ai_classify_request') status = '已发送'
        else if (message.command === 'ai_classify_result') status = '已返回'
        else if (message.command === 'ai_intent_request') status = '已发送'
        else if (message.command === 'ai_intent_result') status = message.executed ? '已执行' : '未执行'
        else if (message.command === 'ai_retry') status = '保持开启'
        else if (message.command === 'ai_recommend') status = message.executed ? '已生成' : '无结果'
        else if (message.command === 'ai_error') status = '失败'
        else status = message.executed ? '执行成功' : (message.command ? '未执行' : '未匹配')
        const note = message.note ? ` · ${message.note}` : ''
        const answerLabel = message.answer_label || '小爱回答'
        const answer = message.answer ? `\n    ${answerLabel}：${String(message.answer).slice(0, 200)}` : ''
        return `[${formatClock(message.received_at)}] ${message.device_name}  ${message.question}\n    → ${commandLabel} / ${status}${note}${answer}`
      }).join('\n\n')
    } catch { /* 轮询失败不提示 */ }
  }

  // ===== 事件绑定 =====

  const bindEvents = () => {
    $('adminLoginBtn').addEventListener('click', async () => {
      const password = $('adminPassword').value
      if (!password) { toast('请输入后台密码', 'error'); return }
      state.password = password
      try {
        await connect()
        sessionStorage.setItem('miot-admin', password)
        $('adminPassword').value = ''
        toast('连接成功', 'ok')
      } catch (err) {
        state.password = ''
        sessionStorage.removeItem('miot-admin')
        toast(err.message, 'error')
      }
    })
    $('adminPassword').addEventListener('keydown', event => {
      if (event.key === 'Enter') $('adminLoginBtn').click()
    })
    $('logoutBtn').addEventListener('click', () => {
      state.password = ''
      sessionStorage.removeItem('miot-admin')
      showLogin()
      toast('已退出后台验证', 'ok')
    })
    $('refreshBtn').addEventListener('click', async () => {
      try {
        await refreshStatus()
        await Promise.all([refreshDevices(), refreshPlaylists(), refreshCommands(), refreshVoiceLog(), refreshAi()])
        toast('已刷新', 'ok')
      } catch (err) { toast(err.message, 'error') }
    })

    $('settingsForm').addEventListener('submit', saveSettings)
    $('resetAiIntentPrompt').addEventListener('click', () => {
      $('setAiIntentPrompt').value = state.promptDefaults.intent || ''
      toast('已填回默认意图解析提示词，点保存后生效', 'ok')
    })
    $('resetAiClassifyPrompt').addEventListener('click', () => {
      $('setAiClassifyPrompt').value = state.promptDefaults.classify || ''
      toast('已填回默认歌曲分类提示词，点保存后生效', 'ok')
    })
    $('setAiAnalysis').addEventListener('change', () => {
      if ($('setAiAnalysis').checked && state.ai && state.ai.error) {
        $('setAiAnalysis').checked = false
        toast('存在未清除的 AI 错误，请先在页面顶部清除错误记录，再手动打开开关', 'error')
      }
    })
    $('aiClearBtn').addEventListener('click', clearAiError)
    $('miLoginBtn').addEventListener('click', miLogin)
    $('captchaSubmitBtn').addEventListener('click', captchaLogin)
    $('verifySubmitBtn').addEventListener('click', verifyLogin)
    $('tokenLoginBtn').addEventListener('click', tokenLogin)
    $('themeBtn').addEventListener('click', toggleTheme)
    document.querySelectorAll('[data-auth-tab]').forEach(button => {
      button.addEventListener('click', () => switchAuthTab(button.dataset.authTab))
    })
    $('qrRefreshBtn').addEventListener('click', () => { void startQRCode() })
    $('accountList').addEventListener('click', handleAccountAction)

    $('deviceList').addEventListener('change', handleDeviceChange)
    $('deviceList').addEventListener('click', handleDeviceClick)

    $('refreshPlaylistsBtn').addEventListener('click', refreshPlaylists)
    $('playPlaylistBtn').addEventListener('click', playPlaylist)
    $('searchBtn').addEventListener('click', search)
    $('searchInput').addEventListener('keydown', event => { if (event.key === 'Enter') search() })
    $('searchResults').addEventListener('click', handleSearchClick)
    $('modeSelect').addEventListener('change', () => playerAction('mode', $('modeSelect').value))

    $('prevBtn').addEventListener('click', () => playerAction('previous'))
    $('pauseBtn').addEventListener('click', () => playerAction('pause'))
    $('resumeBtn').addEventListener('click', () => playerAction('resume'))
    $('nextBtn').addEventListener('click', () => playerAction('next'))
    $('stopBtn').addEventListener('click', () => playerAction('stop'))
    $('favoriteBtn').addEventListener('click', () => playerAction('favorite', 'add'))
    $('saveToListBtn').addEventListener('click', () => void saveCurrentToList())
    $('volumeSyncBtn').addEventListener('click', () => playerAction('sync-volume'))

    const volume = $('volumeRange')
    volume.addEventListener('pointerdown', () => { state.draggingVolume = true })
    volume.addEventListener('input', () => { $('volumeLabel').textContent = volume.value })
    volume.addEventListener('change', async () => {
      state.draggingVolume = false
      await changeVolume()
    })
    volume.addEventListener('pointerup', () => { state.draggingVolume = false })

    $('voiceDryBtn').addEventListener('click', () => testVoice(false))
    $('voiceExecBtn').addEventListener('click', () => testVoice(true))
    $('voiceTestInput').addEventListener('keydown', event => { if (event.key === 'Enter') testVoice(false) })
    $('saveCommandsBtn').addEventListener('click', saveCommands)
    $('resetCommandsBtn').addEventListener('click', resetCommands)
    $('addCommandBtn').addEventListener('click', () => openCommandEditor(-1))
    $('cmdSaveBtn').addEventListener('click', () => void saveCommandEditor())
    $('cmdCancelBtn').addEventListener('click', closeCommandEditor)
    $('cmdType').addEventListener('change', syncCommandParamField)
    $('cmdKeywords').addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); void saveCommandEditor() }
    })
    $('commandList').addEventListener('click', event => {
      const button = event.target.closest('button[data-command-action]')
      if (!button) return
      const row = button.closest('[data-command-index]')
      if (!row) return
      const index = Number(row.dataset.commandIndex)
      if (button.dataset.commandAction === 'edit') openCommandEditor(index)
      if (button.dataset.commandAction === 'delete') void deleteCommand(index)
    })
    $('refreshVoiceBtn').addEventListener('click', refreshVoiceLog)

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        qrStopTimer()
      } else if (state.authTab === 'qrcode' && state.qr.loginId && !state.qr.polling && !state.qr.timer) {
        scheduleQRPoll(300, state.qr.generation)
      }
    })
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bindEvents()
    updateThemeIcon()
    if (!state.password) { showLogin(); return }
    try {
      await connect()
    } catch (err) {
      state.password = ''
      sessionStorage.removeItem('miot-admin')
      showLogin()
      toast(err.message, 'error')
    }
  })
})()
