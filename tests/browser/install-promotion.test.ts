import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InstallPromotionController,
  isIOSDevice,
  isIOSSafari,
  type BeforeInstallPromptEvent,
  type InstallEnvironment,
} from '../../js/app/install-promotion';
import { setLocalePreference } from '../../js/app/i18n';

const desktopNavigator = {
  userAgent: 'Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36',
  platform: 'Linux x86_64',
  maxTouchPoints: 0,
};

function setupDOM(): void {
  document.head.innerHTML = '<meta name="description"><link rel="manifest">';
  document.body.innerHTML = `
    <button class="install-settings-button" data-i18n="install.settingsAction" hidden></button>
    <aside class="install-promotion" hidden>
      <button class="install-promotion-dismiss" data-i18n-aria-label="install.dismiss"></button>
      <h2 data-i18n="install.title"></h2>
      <p class="install-promotion-benefits" data-i18n="install.benefits"></p>
      <div class="install-ios-instructions" hidden>
        <p class="install-ios-safari-intro" data-i18n="install.iosIntro"></p>
        <ol class="install-ios-steps"><li data-i18n="install.iosStepShare"></li></ol>
        <p class="install-ios-browser-fallback" data-i18n="install.iosOpenSafari" hidden></p>
      </div>
      <button class="install-promotion-primary"></button>
    </aside>`;
}

function environment(
  navigatorValues: typeof desktopNavigator = desktopNavigator,
  standalone = false,
): InstallEnvironment {
  const eventTarget = new EventTarget() as EventTarget & Partial<Window>;
  eventTarget.matchMedia = (() => ({
    matches: standalone,
    media: '(display-mode: standalone)',
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  })) as Window['matchMedia'];
  return {
    window: eventTarget as Window,
    document,
    navigator: navigatorValues as Navigator,
  };
}

function installPrompt(outcome: 'accepted' | 'dismissed') {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as BeforeInstallPromptEvent;
  const prompt = vi.fn(async () => {});
  Object.assign(event, {
    prompt,
    userChoice: Promise.resolve({ outcome }),
  });
  return { event, prompt };
}

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  localStorage.clear();
  setLocalePreference('system');
});

describe('install promotion', () => {
  it('waits for app readiness, invokes a native prompt once, and hides after dismissal', async () => {
    setupDOM();
    const env = environment();
    const controller = new InstallPromotionController(env);
    controller.init();
    const { event, prompt } = installPrompt('dismissed');
    env.window.dispatchEvent(event);

    expect(document.querySelector<HTMLElement>('.install-promotion')?.hidden).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('.install-settings-button')?.hidden).toBe(false);
    controller.markAppReady();
    expect(document.querySelector<HTMLElement>('.install-promotion')?.hidden).toBe(false);

    await controller.promptNativeInstall();
    await controller.promptNativeInstall();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLElement>('.install-promotion')?.hidden).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('.install-settings-button')?.hidden).toBe(true);
  });

  it('dismisses only the sheet while keeping Settings able to install', () => {
    setupDOM();
    const env = environment();
    const controller = new InstallPromotionController(env);
    controller.init();
    env.window.dispatchEvent(installPrompt('accepted').event);
    controller.markAppReady();

    document.querySelector<HTMLButtonElement>('.install-promotion-dismiss')?.click();
    expect(document.querySelector<HTMLElement>('.install-promotion')?.hidden).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('.install-settings-button')?.hidden).toBe(false);
  });

  it('removes both entry points when appinstalled fires', () => {
    setupDOM();
    const env = environment();
    const controller = new InstallPromotionController(env);
    controller.init();
    env.window.dispatchEvent(installPrompt('accepted').event);
    controller.markAppReady();
    env.window.dispatchEvent(new Event('appinstalled'));

    expect(document.querySelector<HTMLElement>('.install-promotion')?.hidden).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('.install-settings-button')?.hidden).toBe(true);
  });

  it('shows current Safari instructions and reopens them from Settings', () => {
    setupDOM();
    const iosSafari = {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
      maxTouchPoints: 5,
    };
    const controller = new InstallPromotionController(environment(iosSafari));
    controller.init();
    controller.markAppReady();
    document.querySelector<HTMLButtonElement>('.install-promotion-primary')?.click();

    expect(document.querySelector<HTMLElement>('.install-ios-instructions')?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('.install-ios-steps')?.hidden).toBe(false);
    document.querySelector<HTMLButtonElement>('.install-promotion-dismiss')?.click();
    document.querySelector<HTMLButtonElement>('.install-settings-button')?.click();
    expect(document.querySelector<HTMLElement>('.install-ios-instructions')?.hidden).toBe(false);
  });

  it('directs other iOS browsers to Safari and recognizes desktop-style iPadOS', () => {
    setupDOM();
    const ipadChrome = {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 CriOS/126.0 Mobile/15E148 Safari/604.1',
      platform: 'MacIntel',
      maxTouchPoints: 5,
    };
    expect(isIOSDevice(ipadChrome)).toBe(true);
    expect(isIOSSafari(ipadChrome)).toBe(false);
    const controller = new InstallPromotionController(environment(ipadChrome));
    controller.init();
    controller.markAppReady();
    document.querySelector<HTMLButtonElement>('.install-promotion-primary')?.click();
    expect(document.querySelector<HTMLElement>('.install-ios-browser-fallback')?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('.install-ios-steps')?.hidden).toBe(true);
  });

  it('leaves unsupported browsers unchanged, hides standalone UI, and localizes live guidance', () => {
    setupDOM();
    const unsupported = new InstallPromotionController(environment());
    unsupported.init();
    unsupported.markAppReady();
    expect(document.querySelector<HTMLElement>('.install-promotion')?.hidden).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('.install-settings-button')?.hidden).toBe(true);

    setupDOM();
    const standalone = new InstallPromotionController(environment(desktopNavigator, true));
    standalone.init();
    standalone.markAppReady();
    expect(document.querySelector<HTMLButtonElement>('.install-settings-button')?.hidden).toBe(true);

    setupDOM();
    const ios = {
      userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/18.5 Mobile Safari/604.1',
      platform: 'iPhone',
      maxTouchPoints: 5,
    };
    const localized = new InstallPromotionController(environment(ios));
    localized.init();
    localized.markAppReady();
    expect(document.querySelector<HTMLButtonElement>('.install-settings-button')?.textContent).toBe('Install to Home Screen');
    setLocalePreference('zh-TW');
    expect(document.querySelector<HTMLElement>('.install-promotion-benefits')?.textContent).toContain('主畫面');
    expect(document.querySelector<HTMLButtonElement>('.install-settings-button')?.textContent).toBe('安裝到主畫面');
    expect(document.querySelector<HTMLButtonElement>('.install-promotion-primary')?.textContent).toBe('查看步驟');
  });

  it('hides installation UI in an iOS standalone session', () => {
    setupDOM();
    const iosPWA = {
      userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/18.5 Mobile Safari/604.1',
      platform: 'iPhone',
      maxTouchPoints: 5,
      standalone: true,
    };
    const controller = new InstallPromotionController(environment(iosPWA));
    controller.init();
    controller.markAppReady();

    expect(document.querySelector<HTMLElement>('.install-promotion')?.hidden).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('.install-settings-button')?.hidden).toBe(true);
  });
});
