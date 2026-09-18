process.loadEnvFile('.dev.vars');

export {};

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const url = process.argv[2];
if (!token || !secret || !url) throw new Error('Usage: pnpm telegram:set-webhook <worker-url> with Telegram variables in .dev.vars');
const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: `${url.replace(/\/$/, '')}/telegram/webhook`, secret_token: secret }),
});
if (!response.ok) throw new Error(`setWebhook failed: ${response.status} ${await response.text()}`);
console.log('Telegram webhook configured.');
