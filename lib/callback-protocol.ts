export const UI_CALLBACK_PREFIX = "tgplus:ui:";
export const TUI_CALLBACK_PREFIX = "tgplus:tui:";

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