import crypto from "node:crypto";
import bcrypt from "bcryptjs";

const AUTH_USER = process.env.AUTH_USER ?? "";
const AUTH_HASH = process.env.AUTH_HASH ?? "";
const SESSION_SECRET = process.env.SESSION_SECRET ?? "";
const SESSION_COOKIE = "nexus_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней — единственный пользователь, свой хаб

if (!AUTH_HASH || !SESSION_SECRET) {
  // Хаб остаётся живым и отвечает, но вход физически невозможен без этих
  // переменных — безопаснее, чем тихо работать с пустым паролем.
  console.error(
    "[auth] AUTH_HASH или SESSION_SECRET не заданы — вход будет отклоняться для всех"
  );
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
}

export function createSessionToken(): string {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = String(expiresAt);
  const sig = sign(payload);
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

export function verifySessionToken(token: string | undefined): boolean {
  if (!token || !SESSION_SECRET) return false;
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf-8");
    const [payload, sig] = decoded.split(".");
    if (!payload || !sig) return false;
    const expected = sign(payload);
    // Постоянное время сравнения — не через === (побочный канал по времени).
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return false;
    }
    const expiresAt = Number(payload);
    return Number.isFinite(expiresAt) && Date.now() < expiresAt;
  } catch {
    return false;
  }
}

export async function checkCredentials(username: string, password: string): Promise<boolean> {
  if (!AUTH_HASH || !AUTH_USER) return false;
  // Сравнение имени тоже постоянным временем — единообразие с паролем.
  const userBuf = Buffer.from(username);
  const expectedUserBuf = Buffer.from(AUTH_USER);
  const userMatches =
    userBuf.length === expectedUserBuf.length && crypto.timingSafeEqual(userBuf, expectedUserBuf);
  if (!userMatches) {
    // Всё равно считаем хэш — не выдавать по времени ответа, что не так.
    await bcrypt.compare(password, AUTH_HASH || "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva");
    return false;
  }
  return bcrypt.compare(password, AUTH_HASH);
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
export const SESSION_MAX_AGE_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

// Страница входа — терминальная стилистика, один инпут пароля не считая
// логина, это личный хаб одного человека.
export function renderLoginPage(error?: string): string {
  const errorLine = error
    ? `<div class="line err"><span class="prefix">system ::</span><span class="msg">${escapeHtml(error)}</span></div>`
    : "";
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<title>NEXUS404 — вход</title>
<meta name="theme-color" content="#08070c" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet" />
<style>
  :root {
    --bg: #08070c;
    --line: rgba(179, 136, 255, 0.15);
    --text: #ddd6ff;
    --muted: #7a72a0;
    --accent: #b388ff;
    --red: #ef5350;
    --font-sans: 'Space Grotesk', -apple-system, system-ui, sans-serif;
    --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { font-size: 14px; }
  * { scrollbar-width: none; -ms-overflow-style: none; }
  *::-webkit-scrollbar { display: none; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-sans);
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    padding: 20px 16px;
  }
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    background: repeating-linear-gradient(
      to bottom,
      rgba(179, 136, 255, 0.03) 0px,
      rgba(179, 136, 255, 0.03) 1px,
      transparent 1px,
      transparent 3px
    );
  }
  .box {
    max-width: 460px;
    width: 100%;
    position: relative;
    z-index: 1;
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 20px 22px;
    background: rgba(12, 11, 20, 0.4);
    backdrop-filter: blur(2px);
    box-shadow: 0 0 40px rgba(179, 136, 255, 0.06);
  }
  .prompt {
    font-family: var(--font-mono);
    color: var(--accent);
    font-size: 0.95rem;
    margin-bottom: 14px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--line);
  }
  .prompt .user { color: #ffcc66; }
  .prompt .muted { color: var(--muted); }
  .lines { font-family: var(--font-mono); font-size: 0.9rem; margin-bottom: 10px; display: flex; flex-direction: column; gap: 4px; }
  .lines .line { display: flex; gap: 8px; }
  .lines .line .prefix { color: var(--muted); flex-shrink: 0; }
  .lines .line.err .prefix { color: var(--red); }
  .lines .line.err .msg { color: var(--red); }
  form { font-family: var(--font-mono); font-size: 0.95rem; border-top: 1px solid var(--line); padding-top: 12px; margin-top: 4px; }
  .login-btn {
    width: 100%; margin-top: 8px; padding: 8px; background: transparent;
    border: 1px solid var(--accent); border-radius: 4px; color: var(--accent);
    font-family: var(--font-mono); font-size: 0.9rem; letter-spacing: 1px;
    text-transform: uppercase; cursor: pointer; transition: box-shadow 0.15s, background 0.15s;
  }
  .login-btn:hover { background: rgba(179, 136, 255, 0.08); box-shadow: 0 0 18px rgba(179, 136, 255, 0.3); }
  .field-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .field-row:last-child { margin-bottom: 0; }
  .field-row:focus-within { text-shadow: 0 0 10px rgba(179, 136, 255, 0.5); }
  form .sym { color: var(--accent); flex-shrink: 0; }
  form input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 0.95rem;
    padding: 4px 0;
  }
  form input::placeholder { color: var(--muted); }
  .cursor {
    display: inline-block;
    width: 7px;
    height: 1em;
    background: var(--accent);
    vertical-align: -2px;
    animation: blink 1s step-end infinite;
    box-shadow: 0 0 16px rgba(179, 136, 255, 0.6);
  }
  @keyframes blink { 50% { opacity: 0; } }
</style>
</head>
<body>
  <div class="box">
    <div class="prompt"><span class="user">root</span><span class="muted">@</span>nexus404<span class="muted">:~$</span> authenticate</div>
    <div class="lines">
      <div class="line"><span class="prefix">system ::</span><span class="msg">введите логин и пароль, чтобы продолжить</span></div>
      ${errorLine}
    </div>
    <form method="POST" action="/api/auth/login" autocomplete="off">
      <div class="field-row">
        <span class="sym">&gt;</span>
        <input type="text" name="username" placeholder="логин" autofocus required autocapitalize="off" autocorrect="off" spellcheck="false" />
      </div>
      <div class="field-row">
        <span class="sym">&gt;</span>
        <input type="password" name="password" placeholder="пароль" required />
        <span class="cursor"></span>
      </div>
      <button type="submit" class="login-btn">войти</button>
    </form>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
