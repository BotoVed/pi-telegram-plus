export const UI_CALLBACK_PREFIX = "tgplus:ui:";
export const TUI_CALLBACK_PREFIX = "tgplus:tui:";

export const MENU_MORE_CALLBACK_PREFIX = "tgplus:more:";
export const MENU_RUN_CALLBACK_PREFIX = "tgplus:run:";

export function encodeUiCallback(value: string): string {
  return `${UI_CALLBACK_PREFIX}${value}`;
}

export function decodeUiCallback(data: string): string | undefined {
  return data.startsWith(UI_CALLBACK_PREFIX) ? data.slice(UI_CALLBACK_PREFIX.length) : undefined;
}

export function encodeTuiCallback(action: string): string {
  return `${TUI_CALLBACK_PREFIX}${action}`;
}

export function decodeTuiCallback(data: string): string | undefined {
  return data.startsWith(TUI_CALLBACK_PREFIX) ? data.slice(TUI_CALLBACK_PREFIX.length) : undefined;
}

export function encodeMoreCallback(page: number): string {
  return `${MENU_MORE_CALLBACK_PREFIX}${page}`;
}

export function decodeMoreCallback(data: string): string | undefined {
  return data.startsWith(MENU_MORE_CALLBACK_PREFIX) ? data.slice(MENU_MORE_CALLBACK_PREFIX.length) : undefined;
}

export function encodeRunCallback(command: string): string {
  return `${MENU_RUN_CALLBACK_PREFIX}${command}`;
}

export function decodeRunCallback(data: string): string | undefined {
  return data.startsWith(MENU_RUN_CALLBACK_PREFIX) ? data.slice(MENU_RUN_CALLBACK_PREFIX.length) : undefined;
}