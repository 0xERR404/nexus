import { readFile, writeFile, appendFile, mkdir, unlink, rm } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { TokenUsage } from "./usage.js";
import { withFileLock } from "../fileLock.js";

const HUB_DATA_DIR = process.env.HUB_DATA_DIR ?? "/app/data";
const CHAT_DIR = path.join(HUB_DATA_DIR, "chat");
const TOPICS_FILE = path.join(CHAT_DIR, "topics.json");

export interface Topic {
  id: string;
  title: string;
  provider: "deepseek" | "gemini" | "flowmusic" | "claude";
  createdAt: string;
  lastMessageAt: string | null;
  // Только для provider === "flowmusic" — id проекта на стороне FlowMusic,
  // переиспользуется на каждое следующее сообщение в этой же теме, а не
  // создаётся заново — иначе на стороне самого FlowMusic каждое сообщение
  // в одной теме хаба превращалось бы в отдельную новую сессию/проект.
  flowmusicProjectId?: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  provider?: "deepseek" | "gemini" | "flowmusic" | "claude";
  model?: string;
  usage?: TokenUsage;
}

async function ensureDir() {
  await mkdir(CHAT_DIR, { recursive: true });
}

function messagesFile(topicId: string): string {
  if (!/^[a-f0-9-]{36}$/.test(topicId)) throw new Error("некорректный id темы");
  return path.join(CHAT_DIR, `${topicId}.jsonl`);
}

// Без блокировки — вызывать только изнутри функций, уже держащих
// withFileLock(TOPICS_FILE, ...); лок не реентерабельный.
async function readTopicsRaw(): Promise<Topic[]> {
  try {
    return JSON.parse(await readFile(TOPICS_FILE, "utf-8")) as Topic[];
  } catch {
    return [];
  }
}

async function writeTopicsRaw(topics: Topic[]): Promise<void> {
  await writeFile(TOPICS_FILE, JSON.stringify(topics, null, 2));
}

export async function listTopics(): Promise<Topic[]> {
  await ensureDir();
  return withFileLock(TOPICS_FILE, async () => {
    const topics = await readTopicsRaw();
    // Миграция тем без provider (созданы до его появления) — по последнему
    // сообщению-ответу, иначе deepseek (был единственным провайдером).
    let changed = false;
    for (const t of topics) {
      if (!t.provider) {
        t.provider = await inferTopicProvider(t.id);
        changed = true;
      }
    }
    if (changed) await writeTopicsRaw(topics);
    return topics;
  });
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
    // темы без сообщений — не ошибка
  }
  return "deepseek";
}

export async function createTopic(title: string, provider: Topic["provider"]): Promise<Topic> {
  await ensureDir();
  return withFileLock(TOPICS_FILE, async () => {
    const topics = await readTopicsRaw();
    const topic: Topic = { id: crypto.randomUUID(), title: title || "Новый разговор", provider, createdAt: new Date().toISOString(), lastMessageAt: null };
    topics.push(topic);
    await writeTopicsRaw(topics);
    return topic;
  });
}

export async function getTopic(topicId: string): Promise<Topic | undefined> {
  return (await listTopics()).find((t) => t.id === topicId);
}

export async function deleteTopic(topicId: string): Promise<boolean> {
  const deleted = await withFileLock(TOPICS_FILE, async () => {
    const topics = await readTopicsRaw();
    const idx = topics.findIndex((t) => t.id === topicId);
    if (idx === -1) return false;
    topics.splice(idx, 1);
    await writeTopicsRaw(topics);
    return true;
  });
  if (!deleted) return false;

  await unlink(messagesFile(topicId)).catch(() => {});
  await rm(path.join(CHAT_DIR, "attachments", topicId), { recursive: true, force: true }).catch(() => {});
  return true;
}

export async function getMessages(topicId: string, limit = 50): Promise<Message[]> {
  try {
    const raw = await readFile(messagesFile(topicId), "utf-8");
    const messages = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Message);
    return messages.slice(-limit);
  } catch {
    return [];
  }
}

export async function appendMessage(topicId: string, message: Message): Promise<void> {
  await ensureDir();
  await appendFile(messagesFile(topicId), JSON.stringify(message) + "\n");
  await withFileLock(TOPICS_FILE, async () => {
    const topics = await readTopicsRaw();
    const t = topics.find((x) => x.id === topicId);
    if (t) {
      t.lastMessageAt = message.timestamp;
      await writeTopicsRaw(topics);
    }
  });
}

// Сохраняется один раз при первом сообщении FlowMusic в теме, дальше
// переиспользуется — см. Topic.flowmusicProjectId.
export async function setTopicFlowMusicProjectId(topicId: string, projectId: string): Promise<void> {
  await withFileLock(TOPICS_FILE, async () => {
    const topics = await readTopicsRaw();
    const t = topics.find((x) => x.id === topicId);
    if (t) {
      t.flowmusicProjectId = projectId;
      await writeTopicsRaw(topics);
    }
  });
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

// Жёсткая обрезка по символам, поднята вместе с max_tokens у провайдеров.
const MAX_MESSAGE_LENGTH = 8000;
function truncateMessage(content: string): string {
  if (content.length <= MAX_MESSAGE_LENGTH) return content;
  return content.slice(0, MAX_MESSAGE_LENGTH) + "\n\n[...сообщение обрезано, было длиннее]";
}
