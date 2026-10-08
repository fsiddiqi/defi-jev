// Telegram notifications — adapted from the adjacent defi-strategy project
// (src/common/telegram.ts). Enabled only when both env vars are present:
//
//   TELEGRAM_BOT_TOKEN — bot API token
//   TELEGRAM_CHAT_ID   — destination chat id
//
// Every send is best-effort: a missing token, a network error, or a bad chat
// id must NEVER break the trading loop. When unconfigured, notifyTelegram()
// is a no-op (no log spam).
export function isTelegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

/**
 * Sends a message to the configured Telegram chat.
 * @returns the message id if sent, otherwise null.
 */
export async function sendTelegramMessage(message: string): Promise<number | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null;

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (!response.ok) {
      console.warn(`[telegram] send failed: ${response.status} ${await response.text().catch(() => "")}`);
      return null;
    }
    const data = (await response.json()) as { result?: { message_id?: number } };
    return data.result?.message_id ?? null;
  } catch (e) {
    console.warn(`[telegram] send error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Fire-and-forget notify that only acts when Telegram is configured. */
export function notifyTelegram(message: string): void {
  if (!isTelegramConfigured()) return;
  void sendTelegramMessage(message).catch(() => {});
}