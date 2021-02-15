/* Note: This code is taken from https://github.com/cheton/is-electron/blob/master/index.js
   Licence: MIT
*/
// helper method to determine whether app is running in electron environment
export function isElectron(): boolean {
  // Renderer process
  if (
    typeof window !== 'undefined' &&
    typeof window.process === 'object' &&
    (window.process as any).type === 'renderer'
  ) {
    return true;
  }

  // Main process
  if (
    typeof process !== 'undefined' &&
    typeof process.versions === 'object' &&
    !!(process.versions as any).electron
  ) {
    return true;
  }

  // Detect the user agent when the `nodeIntegration` option is set to true
  if (
    typeof navigator === 'object' &&
    typeof navigator.userAgent === 'string' &&
    navigator.userAgent.indexOf('Electron') >= 0
  ) {
    return true;
  }

  return false;
}

declare global {
  interface Window {
    headlampBaseUrl?: string;
  }
}

/**
 * @returns URL depending on dev-mode/electron, base-url, and window.location.origin.
 *
 * @example isDevMode | isElectron returns 'http://localhost:4466/'
 * @example base-url set as '/headlamp' returns '/headlamp/'
 * @example isDevMode | isElectron and base-url is set
 *          it returns 'http://localhost:4466/headlamp/'
 * @example returns 'https://headlamp.example.com/'using the window.location.origin of browser
 *
 */
export function getAppUrl(): string {
  const isDevMode = !process.env.NODE_ENV || process.env.NODE_ENV === 'development';

  let url = isDevMode || isElectron() ? 'http://localhost:4466' : window.location.origin;

  const baseUrl = getBaseUrl();
  url += baseUrl ? baseUrl + '/' : '/';

  return url;
}

/**
 * @returns the baseUrl for the app based on window.headlampBaseUrl or process.env.PUBLIC_URL
 *
 * This could be either '' meaning /, or something like '/headlamp'.
 */
export function getBaseUrl(): string {
  let baseUrl = '';
  if (window.headlampBaseUrl !== undefined) {
    baseUrl = window.headlampBaseUrl;
  } else {
    baseUrl = process.env.PUBLIC_URL ? process.env.PUBLIC_URL : '';
  }

  if (baseUrl === './' || baseUrl === '.') {
    baseUrl = '';
  }
  return baseUrl;
}
