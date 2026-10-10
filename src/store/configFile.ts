import { configTemplate, describeConfigErrors, parseConfig, resetConfig, setConfig } from '../model/config';
import { flash } from './persistence';

/**
 * Renderer side of the user configuration file (`config.txt` in Electron's userData folder; see electron/main.cjs).
 * The file is the only source of truth: it is read at startup and on an explicit reload, parsed as a whole, and only a
 * fully valid result replaces the in-memory config (model/config.ts). Nothing here touches the deck store, undo
 * history or autosave, so a reload can never change or dirty a presentation. Browser-only runs have no file: the
 * built-in defaults stay in effect and the shortcuts do nothing.
 */

interface ConfigRead { path: string; text: string | null; error?: string }

const read = (): Promise<ConfigRead | null> => (window.native?.readConfig ? window.native.readConfig() : Promise.resolve(null));

/**
 * Startup: apply a valid config.txt before anything is created. A missing file means defaults; an unreadable or invalid
 * one also means defaults, with a warning (the file itself is left exactly as it is).
 */
export async function loadConfig() {
  let r: ConfigRead | null = null;
  try { r = await read(); } catch (e) { console.error('config read failed', e); }
  if (!r) return;
  if (r.error) return void flash(`Could not read config.txt: ${r.error} — using built-in defaults`, 5000);
  if (r.text === null) return;
  const parsed = parseConfig(r.text);
  if (parsed.ok) setConfig(parsed.config);
  else flash(`${describeConfigErrors(parsed.errors)} — using built-in defaults`, 5000);
}

/** Cmd+Shift+, : re-read the file; a valid one replaces the active config, anything else keeps the previous one. */
export async function reloadConfig() {
  let r: ConfigRead | null = null;
  try { r = await read(); } catch (e) { return void flash(`Could not read config.txt: ${String(e)}`, 5000); }
  if (!r) return;
  if (r.error) return void flash(`Could not read config.txt: ${r.error}`, 5000);
  if (r.text === null) { resetConfig(); return void flash('No config.txt — built-in defaults restored'); }
  const parsed = parseConfig(r.text);
  if (!parsed.ok) return void flash(describeConfigErrors(parsed.errors), 6000);
  setConfig(parsed.config);
  flash('Configuration reloaded');
}

/** Cmd+, : create config.txt from the commented template if it does not exist (never overwriting), then open it in the default editor. */
export async function openConfig() {
  if (!window.native?.openConfig) return;
  try {
    const r = await window.native.openConfig(configTemplate());
    if (!r.ok) flash(`Could not open config.txt (${r.error ?? 'unknown error'}) — it is at ${r.path}`, 6000);
    else if (r.created) flash('Created config.txt');
  } catch (e) {
    flash(`Could not open config.txt: ${String(e)}`, 6000);
  }
}

// The menu accelerator and the renderer key fallback can both fire for one key press: run each command once per burst.
const lastRun: Record<string, number> = {};
export function runConfigCommand(command: string) {
  if (command !== 'open' && command !== 'reload') return;
  const now = Date.now();
  if (now - (lastRun[command] ?? -Infinity) < 400) return;
  lastRun[command] = now;
  void (command === 'open' ? openConfig() : reloadConfig());
}

const isMac = /Mac/i.test(navigator.platform);
/**
 * Fallback for the menu accelerators: `code` is layout-independent, unlike `key` (Shift+, is "<" on some layouts).
 * Only in the desktop app — in a browser these keys keep their normal meaning.
 */
export function configShortcut(e: KeyboardEvent): 'open' | 'reload' | null {
  if (!window.native?.openConfig || e.code !== 'Comma' || e.altKey) return null;
  if (!(isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) return null;
  return e.shiftKey ? 'reload' : 'open';
}

/** Subscribe to the Electron menu items (Open Configuration… / Reload Configuration). */
export function startConfigCommands() {
  window.native?.onConfigCommand?.(runConfigCommand);
}
