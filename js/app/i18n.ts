/** Zero-dependency localization for the Goodiano web app. */

import { localizedManifestUrls } from 'virtual:goodiano-assets';

export type SupportedLocale = 'en' | 'zh-CN' | 'zh-TW';
export type LocalePreference = 'system' | SupportedLocale;

export const LOCALE_STORAGE_KEY = 'goodiano.locale.v1';

const en = {
  'meta.description': 'Virtual piano keyboard with realistic Yamaha U1 sound',
  'loading.audioLabel': 'Loading audio',
  'loading.initial': 'Loading Yamaha U1…',
  'loading.preparing': 'Preparing audio…',
  'loading.retry': 'Retry',
  'loading.retrying': 'Retrying audio load…',
  'loading.timeout': 'Audio load timed out. Tap to retry.',
  'loading.failed': 'Audio failed to load. Tap to retry.',
  'loading.cacheFailed': 'Audio loaded, but could not be saved offline. Tap to retry.',
  'settings.open': 'Open settings',
  'settings.label': 'Settings',
  'settings.language': 'Language',
  'install.title': 'Install Goodiano',
  'install.benefits': 'Play full screen, keep Goodiano on your Home Screen, and use it offline.',
  'install.installAction': 'Install',
  'install.showSteps': 'Show steps',
  'install.done': 'Got it',
  'install.dismiss': 'Not now',
  'install.settingsAction': 'Install to Home Screen',
  'install.iosIntro': 'In Safari:',
  'install.iosStepShare': 'Tap Share.',
  'install.iosStepAddHome': 'Tap Add to Home Screen.',
  'install.iosStepOpenAsApp': 'Turn on Open as Web App.',
  'install.iosStepAdd': 'Tap Add.',
  'install.iosOpenSafari': 'Open this page in Safari first, then add it to your Home Screen.',
  'sustain.label': 'Sustain Pedal',
  'sustain.on': 'Sustain pedal down',
  'sustain.off': 'Sustain pedal up',
  'velocity.enable': 'Enable Velocity',
  'velocity.disable': 'Disable Velocity',
  'velocity.motionSensitivity': 'Motion Sensitivity',
  'velocity.pressureSensitivity': 'Pressure Sensitivity',
  'velocity.motionDescription': 'Adjusts motion-based touch velocity.',
  'velocity.pressureDescription': 'Adjusts pressure-based touch velocity.',
  'velocity.motionGuidance': 'Motion permission is needed for touch velocity.',
  'permission.requesting': 'Requesting motion permission…',
  'permission.denied': 'Motion permission was denied.',
  'permission.unavailable': 'Motion input is unavailable on this device.',
  'permission.status': 'motion permission: {state}',
  'permission.state.disabled': 'disabled',
  'permission.state.unknown': 'unknown',
  'permission.state.requesting': 'requesting',
  'permission.state.granted': 'granted',
  'permission.state.denied': 'denied',
  'permission.state.unavailable': 'unavailable',
  'debug.show': 'Show Debug',
  'debug.hide': 'Hide Debug',
  'debug.title': 'Input Debug',
  'debug.velocityEmpty': 'Velocity: --',
  'debug.velocity': '{note}  ·  velocity {velocity}',
  'debug.source': 'source: {source}',
  'debug.raw': 'pressure {pressure}  ·  motion Δ {motion}',
  'debug.source.pressure': 'pressure',
  'debug.source.motion': 'motion',
  'debug.source.default': 'default',
  'actions.reload': 'Reload App',
  'keyboard.label': 'Piano keyboard',
  'keyboard.octave': 'Octave {octave}',
  'keyboard.hint': 'Computer keyboard: Z–M and Q–P play notes, ← → shift octave, Shift/Alt change dynamics.',
  'minimap.label': 'Keyboard position',
} as const;

export type TranslationKey = keyof typeof en;
type Catalog = Record<TranslationKey, string>;

const zhCN = {
  'meta.description': '拥有逼真 Yamaha U1 音色的虚拟钢琴键盘',
  'loading.audioLabel': '正在加载音频',
  'loading.initial': '正在加载 Yamaha U1…',
  'loading.preparing': '正在准备音频…',
  'loading.retry': '重试',
  'loading.retrying': '正在重新加载音频…',
  'loading.timeout': '音频加载超时。轻点重试。',
  'loading.failed': '音频加载失败。轻点重试。',
  'loading.cacheFailed': '音频已加载，但无法保存供离线使用。轻点重试。',
  'settings.open': '打开设置',
  'settings.label': '设置',
  'settings.language': '语言',
  'install.title': '安装 Goodiano',
  'install.benefits': '全屏弹奏、添加到主屏幕，并可离线使用。',
  'install.installAction': '安装',
  'install.showSteps': '查看步骤',
  'install.done': '知道了',
  'install.dismiss': '稍后再说',
  'install.settingsAction': '安装到主屏幕',
  'install.iosIntro': '在 Safari 中：',
  'install.iosStepShare': '轻点“共享”。',
  'install.iosStepAddHome': '轻点“添加到主屏幕”。',
  'install.iosStepOpenAsApp': '打开“作为 Web App 打开”。',
  'install.iosStepAdd': '轻点“添加”。',
  'install.iosOpenSafari': '请先在 Safari 中打开此页面，再将它添加到主屏幕。',
  'sustain.label': '延音踏板',
  'sustain.on': '延音踏板已踩下',
  'sustain.off': '延音踏板已抬起',
  'velocity.enable': '启用力度感应',
  'velocity.disable': '关闭力度感应',
  'velocity.motionSensitivity': '动作灵敏度',
  'velocity.pressureSensitivity': '压力灵敏度',
  'velocity.motionDescription': '调整基于设备动作的触键力度。',
  'velocity.pressureDescription': '调整基于触控压力的触键力度。',
  'velocity.motionGuidance': '触键力度需要动作传感器权限。',
  'permission.requesting': '正在请求动作传感器权限…',
  'permission.denied': '动作传感器权限已被拒绝。',
  'permission.unavailable': '此设备不支持动作输入。',
  'permission.status': '动作传感器权限：{state}',
  'permission.state.disabled': '已停用',
  'permission.state.unknown': '未知',
  'permission.state.requesting': '正在请求',
  'permission.state.granted': '已授权',
  'permission.state.denied': '已拒绝',
  'permission.state.unavailable': '不可用',
  'debug.show': '显示调试信息',
  'debug.hide': '隐藏调试信息',
  'debug.title': '输入调试',
  'debug.velocityEmpty': '力度：--',
  'debug.velocity': '{note}  ·  力度 {velocity}',
  'debug.source': '来源：{source}',
  'debug.raw': '压力 {pressure}  ·  动作 Δ {motion}',
  'debug.source.pressure': '压力',
  'debug.source.motion': '动作',
  'debug.source.default': '默认',
  'actions.reload': '重新加载应用',
  'keyboard.label': '钢琴键盘',
  'keyboard.octave': '第 {octave} 八度',
  'keyboard.hint': '电脑键盘：Z–M 与 Q–P 弹奏音符，← → 切换八度，Shift/Alt 调整力度。',
  'minimap.label': '键盘位置',
} satisfies Catalog;

const zhTW = {
  'meta.description': '具備逼真 Yamaha U1 音色的虛擬鋼琴鍵盤',
  'loading.audioLabel': '正在載入音訊',
  'loading.initial': '正在載入 Yamaha U1…',
  'loading.preparing': '正在準備音訊…',
  'loading.retry': '重試',
  'loading.retrying': '正在重新載入音訊…',
  'loading.timeout': '音訊載入逾時。點一下即可重試。',
  'loading.failed': '音訊載入失敗。點一下即可重試。',
  'loading.cacheFailed': '音訊已載入，但無法儲存供離線使用。點一下即可重試。',
  'settings.open': '開啟設定',
  'settings.label': '設定',
  'settings.language': '語言',
  'install.title': '安裝 Goodiano',
  'install.benefits': '全螢幕彈奏、加入主畫面，並可離線使用。',
  'install.installAction': '安裝',
  'install.showSteps': '查看步驟',
  'install.done': '知道了',
  'install.dismiss': '現在不要',
  'install.settingsAction': '安裝到主畫面',
  'install.iosIntro': '在 Safari 中：',
  'install.iosStepShare': '點一下「分享」。',
  'install.iosStepAddHome': '點一下「加入主畫面」。',
  'install.iosStepOpenAsApp': '開啟「作為 Web App 開啟」。',
  'install.iosStepAdd': '點一下「加入」。',
  'install.iosOpenSafari': '請先在 Safari 中開啟此頁面，再將它加入主畫面。',
  'sustain.label': '延音踏板',
  'sustain.on': '延音踏板已踩下',
  'sustain.off': '延音踏板已抬起',
  'velocity.enable': '啟用力度感應',
  'velocity.disable': '關閉力度感應',
  'velocity.motionSensitivity': '動作靈敏度',
  'velocity.pressureSensitivity': '壓力靈敏度',
  'velocity.motionDescription': '調整依據裝置動作判斷的觸鍵力度。',
  'velocity.pressureDescription': '調整依據觸控壓力判斷的觸鍵力度。',
  'velocity.motionGuidance': '觸鍵力度需要動作感測器權限。',
  'permission.requesting': '正在要求動作感測器權限…',
  'permission.denied': '動作感測器權限已遭拒絕。',
  'permission.unavailable': '此裝置不支援動作輸入。',
  'permission.status': '動作感測器權限：{state}',
  'permission.state.disabled': '已停用',
  'permission.state.unknown': '未知',
  'permission.state.requesting': '正在要求',
  'permission.state.granted': '已允許',
  'permission.state.denied': '已拒絕',
  'permission.state.unavailable': '無法使用',
  'debug.show': '顯示偵錯資訊',
  'debug.hide': '隱藏偵錯資訊',
  'debug.title': '輸入偵錯',
  'debug.velocityEmpty': '力度：--',
  'debug.velocity': '{note}  ·  力度 {velocity}',
  'debug.source': '來源：{source}',
  'debug.raw': '壓力 {pressure}  ·  動作 Δ {motion}',
  'debug.source.pressure': '壓力',
  'debug.source.motion': '動作',
  'debug.source.default': '預設',
  'actions.reload': '重新載入 App',
  'keyboard.label': '鋼琴鍵盤',
  'keyboard.octave': '第 {octave} 八度',
  'keyboard.hint': '電腦鍵盤：Z–M 與 Q–P 彈奏音符，← → 切換八度，Shift/Alt 調整力度。',
  'minimap.label': '鍵盤位置',
} satisfies Catalog;

const catalogs: Record<SupportedLocale, Catalog> = { en, 'zh-CN': zhCN, 'zh-TW': zhTW };
const supportedLocales: ReadonlySet<SupportedLocale> = new Set(['en', 'zh-CN', 'zh-TW']);
const listeners = new Set<(locale: SupportedLocale) => void>();
let preference: LocalePreference = 'system';
let locale: SupportedLocale = 'en';
let initialized = false;

function isLocalePreference(value: unknown): value is LocalePreference {
  return value === 'system' || supportedLocales.has(value as SupportedLocale);
}

export function resolveLocale(languages: readonly string[] | string | null | undefined): SupportedLocale {
  const candidates = typeof languages === 'string' ? [languages] : languages ?? [];
  for (const candidate of candidates) {
    const parts = candidate.replaceAll('_', '-').toLowerCase().split('-');
    if (parts[0] === 'en') return 'en';
    if (parts[0] !== 'zh') continue;
    if (parts.includes('hant') || parts.some(part => ['tw', 'hk', 'mo'].includes(part))) return 'zh-TW';
    return 'zh-CN';
  }
  return 'en';
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

function readPreference(storage?: Pick<Storage, 'getItem'>): LocalePreference {
  try {
    const value = (storage ?? localStorage).getItem(LOCALE_STORAGE_KEY);
    return isLocalePreference(value) ? value : 'system';
  } catch (_) {
    return 'system';
  }
}

function resolvedPreference(value: LocalePreference): SupportedLocale {
  return value === 'system' ? resolveLocale(browserLanguages()) : value;
}

function commitLocale(next: SupportedLocale): void {
  if (next === locale) return;
  locale = next;
  listeners.forEach(listener => listener(locale));
}

export function getLocale(): SupportedLocale { return locale; }
export function getLocalePreference(): LocalePreference { return preference; }

export function setLocalePreference(
  value: LocalePreference,
  storage?: Pick<Storage, 'setItem' | 'removeItem'>,
): SupportedLocale {
  preference = isLocalePreference(value) ? value : 'system';
  try {
    const target = storage ?? localStorage;
    if (preference === 'system') target.removeItem(LOCALE_STORAGE_KEY);
    else target.setItem(LOCALE_STORAGE_KEY, preference);
  } catch (_) { /* Storage can be unavailable in private/restricted contexts. */ }
  commitLocale(resolvedPreference(preference));
  return locale;
}

export function translate(
  key: TranslationKey,
  parameters: Readonly<Record<string, string | number>> = {},
  targetLocale: SupportedLocale = locale,
): string {
  const template = catalogs[targetLocale]?.[key] ?? en[key];
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (token, name: string) =>
    Object.prototype.hasOwnProperty.call(parameters, name) ? String(parameters[name]) : token);
}

export const t = translate;

export function translateDocument(doc: Document = document): void {
  doc.documentElement.lang = locale;
  doc.title = 'Goodiano';
  doc.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute('content', t('meta.description'));
  doc.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.setAttribute('href', localizedManifestUrls[locale]);
  doc.querySelectorAll<HTMLElement>('[data-i18n]').forEach(element => {
    const key = element.dataset.i18n as TranslationKey;
    if (key in en) element.textContent = t(key);
  });
  doc.querySelectorAll<HTMLElement>('[data-i18n-aria-label]').forEach(element => {
    const key = element.dataset.i18nAriaLabel as TranslationKey;
    if (key in en) element.setAttribute('aria-label', t(key));
  });
}

export function subscribeLocaleChange(listener: (locale: SupportedLocale) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function initializeLocalization(storage?: Pick<Storage, 'getItem'>): SupportedLocale {
  preference = readPreference(storage);
  locale = resolvedPreference(preference);
  if (!initialized && typeof window !== 'undefined') {
    window.addEventListener('languagechange', () => {
      if (preference === 'system') commitLocale(resolveLocale(browserLanguages()));
    });
    initialized = true;
  }
  return locale;
}

// Exported for type-level and unit-test catalog completeness checks.
export const translationCatalogs: Readonly<Record<SupportedLocale, Catalog>> = catalogs;
