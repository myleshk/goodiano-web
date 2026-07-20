import { subscribeLocaleChange, t, translateDocument } from './i18n';

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform?: string }>;
}

export interface InstallEnvironment {
  window: Window;
  document: Document;
  navigator: Navigator;
}

function defaultEnvironment(): InstallEnvironment {
  return { window, document, navigator };
}

export function isIOSDevice(navigatorLike: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'>): boolean {
  return /iPad|iPhone|iPod/i.test(navigatorLike.userAgent)
    || (navigatorLike.platform === 'MacIntel' && navigatorLike.maxTouchPoints > 1);
}

export function isIOSSafari(navigatorLike: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'>): boolean {
  if (!isIOSDevice(navigatorLike)) return false;
  return /Version\/[\d.]+.*Safari/i.test(navigatorLike.userAgent)
    && !/(CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo)/i.test(navigatorLike.userAgent);
}

export function isStandalone(environment: InstallEnvironment = defaultEnvironment()): boolean {
  const iosStandalone = (environment.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || environment.window.matchMedia('(display-mode: standalone)').matches;
}

/** Owns install capability detection and the non-modal installation guidance. */
export class InstallPromotionController {
  private readonly environment: InstallEnvironment;
  private promotion: HTMLElement | null = null;
  private settingsButton: HTMLButtonElement | null = null;
  private primaryButton: HTMLButtonElement | null = null;
  private deferredPrompt: BeforeInstallPromptEvent | null = null;
  private appReady = false;
  private initialized = false;
  private installed = false;
  private sheetDismissed = false;
  private nativePromptConsumed = false;
  private instructionsVisible = false;
  private readonly ios: boolean;
  private readonly iosSafari: boolean;

  constructor(environment: InstallEnvironment = defaultEnvironment()) {
    this.environment = environment;
    this.ios = isIOSDevice(environment.navigator);
    this.iosSafari = isIOSSafari(environment.navigator);
  }

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.promotion = this.environment.document.querySelector('.install-promotion');
    this.settingsButton = this.environment.document.querySelector('.install-settings-button');
    this.primaryButton = this.promotion?.querySelector('.install-promotion-primary') ?? null;
    this.installed = isStandalone(this.environment);

    this.environment.window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault();
      if (this.installed || this.nativePromptConsumed) return;
      this.deferredPrompt = event as BeforeInstallPromptEvent;
      this.render();
      if (this.appReady && !this.sheetDismissed) this.show();
    });
    this.environment.window.addEventListener('appinstalled', () => this.hideAll());
    this.environment.window.matchMedia('(display-mode: standalone)')
      .addEventListener?.('change', event => {
        if (event.matches) this.hideAll();
      });

    this.promotion?.querySelector<HTMLButtonElement>('.install-promotion-dismiss')
      ?.addEventListener('click', () => this.hide());
    this.primaryButton?.addEventListener('click', () => {
      if (this.ios) {
        if (this.instructionsVisible) this.hide();
        else this.showIOSInstructions();
      } else {
        void this.promptNativeInstall();
      }
    });
    this.settingsButton?.addEventListener('click', () => {
      if (this.ios) this.showIOSInstructions();
      else void this.promptNativeInstall();
    });
    subscribeLocaleChange(() => this.render());
    this.render();
  }

  markAppReady(): void {
    this.appReady = true;
    if (this.canInstall() && !this.sheetDismissed) this.show();
  }

  show(): void {
    if (!this.appReady || !this.canInstall()) return;
    this.instructionsVisible = false;
    if (this.promotion) this.promotion.hidden = false;
    this.render();
  }

  hide(): void {
    this.sheetDismissed = true;
    this.instructionsVisible = false;
    if (this.promotion) this.promotion.hidden = true;
    this.render();
  }

  showIOSInstructions(): void {
    if (!this.ios || this.installed) return;
    this.instructionsVisible = true;
    if (this.promotion) this.promotion.hidden = false;
    this.render();
  }

  async promptNativeInstall(): Promise<void> {
    const prompt = this.deferredPrompt;
    if (!prompt || this.installed || this.nativePromptConsumed) return;
    this.nativePromptConsumed = true;
    this.deferredPrompt = null;
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === 'accepted') this.installed = true;
    } catch (_) {
      // The browser can revoke eligibility between capture and the user click.
    } finally {
      // A deferred event is one-shot. After either outcome the browser decides
      // whether a future visit is eligible to receive another event.
      if (this.promotion) this.promotion.hidden = true;
      this.render();
    }
  }

  private canInstall(): boolean {
    return !this.installed && (this.ios || (!!this.deferredPrompt && !this.nativePromptConsumed));
  }

  private hideAll(): void {
    this.installed = true;
    this.deferredPrompt = null;
    if (this.promotion) this.promotion.hidden = true;
    this.render();
  }

  private render(): void {
    translateDocument(this.environment.document);
    const available = this.canInstall();
    if (this.settingsButton) this.settingsButton.hidden = !available;
    if (!this.promotion) return;
    if (!available) this.promotion.hidden = true;

    const benefits = this.promotion.querySelector<HTMLElement>('.install-promotion-benefits');
    const instructions = this.promotion.querySelector<HTMLElement>('.install-ios-instructions');
    const intro = this.promotion.querySelector<HTMLElement>('.install-ios-safari-intro');
    const steps = this.promotion.querySelector<HTMLOListElement>('.install-ios-steps');
    const fallback = this.promotion.querySelector<HTMLElement>('.install-ios-browser-fallback');
    if (benefits) benefits.hidden = this.instructionsVisible;
    if (instructions) instructions.hidden = !this.instructionsVisible;
    if (intro) intro.hidden = !this.iosSafari;
    if (steps) steps.hidden = !this.iosSafari;
    if (fallback) fallback.hidden = this.iosSafari;
    if (this.primaryButton) {
      const key = this.ios
        ? (this.instructionsVisible ? 'install.done' : 'install.showSteps')
        : 'install.installAction';
      this.primaryButton.textContent = t(key);
    }
  }
}
