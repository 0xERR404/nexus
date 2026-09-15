import { readFile, writeFile, appendFile, mkdir, unlink, rm } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { TokenUsage } from "./usage.js";

const HUB_DATA_DIR = process.env.HUB_DATA_DIR ?? "/app/data";
const CHAT_DIR = path.join(HUB_DATA_DIR, "chat");
const TOPICS_FILE = path.join(CHAT_DIR, "topics.json");

export interface Topic {
  id: string;
  title: string;
  // Закреплена за одним ИИ при создании, дальше не меняется — список тем
  // в интерфейсе фильтруется по этому полю.
  provider: "deepseek" | "gemini" | "flowmusic" | "claude";
  createdAt: string;
  lastMessageAt: string | null;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  // Только для role="assistant" — сохраняется вместе с сообщением, чтобы
  // подпись при перезагрузке отражала реальную модель, не текущий переключатель.
  provider?: "deepseek" | "gemini" | "flowmusic" | "claude";
  // Только для provider="deepseek" — конкретная модель (flash/pro). Не
  // свойство темы, выбирается заново на каждое сообщение (см. index.ts).
  model?: string;
  // Реальный расход из usage/usageMetadata API — виден под сообщением и
  // после перезагрузки. У FlowMusic поля нет (генерация аудио).
  usage?: TokenUsage;
}

async function ensureDir() {
  await mkdir(CHAT_DIR, { recursive: true });
}

function messagesFile(topicId: string): string {
  // topicId — UUID, но всё равно проверяем формат перед подстановкой в путь.
  if (!/^[a-f0-9-]{36}$/.test(topicId)) {
    throw new Error("некорректный id темы");
  }
  return path.join(CHAT_DIR, `${topicId}.jsonl`);
}

export async function listTopics(): Promise<Topic[]> {
  await ensureDir();
  let topics: Topic[];
  try {
    const raw = await readFile(TOPICS_FILE, "utf-8");
    topics = JSON.parse(raw) as Topic[];
  } catch {
    return [];
  }

  // Миграция: темы без явного provider (созданные до этой правки) —
  // определяем по последнему сообщению-ответу, пустую тему — deepseek
  // (был единственным провайдером на старте). Пишем на диск один раз.
  let changed = false;
  for (const t of topics) {
    if (!t.provider) {
      t.provider = await inferTopicProvider(t.id);
      changed = true;
    }
  }
  if (changed) {
    await writeFile(TOPICS_FILE, JSON.stringify(topics, null, 2));
  }
  return topics;
}

async function inferTopicProvider(topicId: string): Promise<Topic["provider"]> {
  try {
    const raw = await readFile(messagesFile(topicId), "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const msg = JSON.parse(lines[i]) as Message;
      if (msg.role === "assistant" && msg.provider) return msg.provider;
    }
  } catch {
    // файла сообщений нет (тема без единого сообщения) — не ошибка
  }
  return "deepseek";
}

export async function createTopic(title: string, provider: Topic["provider"]): Promise<Topic> {
  await ensureDir();
  const topics = await listTopics();
  const topic: Topic = {
    id: crypto.randomUUID(),
    title: title || "Новый разговор",
    provider,
    createdAt: new Date().toISOString(),
    lastMessageAt: null,
  };
  topics.push(topic);
  await writeFile(TOPICS_FILE, JSON.stringify(topics, null, 2));
  return topic;
}

export async function getTopic(topicId: string): Promise<Topic | undefined> {
  const topics = await listTopics();
  return topics.find((t) => t.id === topicId);
}

export async function deleteTopic(topicId: string): Promise<boolean> {
  const topics = await listTopics();
  const idx = topics.findIndex((t) => t.id === topicId);
  if (idx === -1) return false;

  topics.splice(idx, 1);
  await writeFile(TOPICS_FILE, JSON.stringify(topics, null, 2));

  // Файл сообщений и вложения — реально удаляем, не оставляем сиротами.
  try {
    await unlink(messagesFile(topicId));
  } catch {
    // файла могло не быть (тема без единого сообщения) — не ошибка
  }
  try {
    await rm(path.join(CHAT_DIR, "attachments", topicId), { recursive: true, force: true });
  } catch {
    // папки вложений могло не быть — не ошибка
  }

  return true;
}

// limit — сколько последних сообщений вернуть. Полная история читается
// целиком из JSONL и обрезается — для реального объёма нормально.
export async function getMessages(topicId: string, limit = 50): Promise<Message[]> {
  try {
    const raw = await readFile(messagesFile(topicId), "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const messages = lines.map((l) => JSON.parse(l) as Message);
    return messages.slice(-limit);
  } catch {
    return [];
  }
}

export async function appendMessage(topicId: string, message: Message): Promise<void> {
  await ensureDir();
  const line = JSON.stringify(message) + "\n";
  await appendFile(messagesFile(topicId), line);

  const topics = await listTopics();
  const t = topics.find((x) => x.id === topicId);
  if (t) {
    t.lastMessageAt = message.timestamp;
    await writeFile(TOPICS_FILE, JSON.stringify(topics, null, 2));
  }
}

export function newMessage(
  role: "user" | "assistant",
  content: string,
  provider?: "deepseek" | "gemini" | "flowmusic" | "claude",
  usage?: TokenUsage,
  model?: string
): Message {
  return {
    id: crypto.randomUUID(),
    role,
    content: truncateMessage(content),
    timestamp: new Date().toISOString(),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(usage ? { usage } : {}),
  };
}

// Жёсткая обрезка по символам — единственный потолок на длину сообщения,
// сжатия истории нет вообще (голый чат). Поднят вместе с max_tokens у
// провайдеров, иначе обрезали бы то, что сами разрешили генерировать длиннее.
const MAX_MESSAGE_LENGTH = 8000;

function truncateMessage(content: string): string {
  if (content.length <= MAX_MESSAGE_LENGTH) return content;
  return content.slice(0, MAX_MESSAGE_LENGTH) + "\n\n[...сообщение обрезано, было длиннее]";
}
