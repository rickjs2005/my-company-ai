// Tipos de browser.mjs (JavaScript puro, usado também pelo launch.mjs sem tsx).
export interface OpenCommand { file: string; args: string[] }
export interface BrowserDeps {
  readRegistry?: (key: string, value: string | null) => string | null;
  exists?: (path: string) => boolean;
  env?: Record<string, string | undefined>;
}
export function parseOpenCommand(command: string | null | undefined, url: string, env?: Record<string, string | undefined>): OpenCommand | null;
export function readRegistry(key: string, value: string | null): string | null;
export function findBrowserCommand(url: string, deps?: BrowserDeps): OpenCommand | null;
export function openUrl(url: string): string;
