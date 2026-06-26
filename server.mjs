#!/usr/bin/env node

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { connect as connectSocket } from "node:net";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ARGS = process.argv.slice(2);
const SCRIPT_PATH = fileURLToPath(import.meta.url);

function valueAfterFlag(args, shortFlag, longFlag) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === shortFlag || arg === longFlag) {
      return args[index + 1] || "";
    }
    if (arg.startsWith(`${longFlag}=`)) {
      return arg.slice(longFlag.length + 1);
    }
  }
  return "";
}

const TOKEN_ARG = valueAfterFlag(ARGS, "-t", "--token");
const PORT_ARG = valueAfterFlag(ARGS, "-p", "--port");
const TITLE_ARG = valueAfterFlag(ARGS, "-n", "--title");
const COMMAND_ARG = valueAfterFlag(ARGS, "-cmd", "--cmd");
const WORKDIR_ARG = valueAfterFlag(ARGS, "-w", "--workdir");
const SESSION_ARG = valueAfterFlag(ARGS, "-s", "--session");
const PORT_WAS_SPECIFIED = Boolean(PORT_ARG);
const PORT = Number(PORT_ARG || 8765);
const PORT_ATTEMPTS = PORT_WAS_SPECIFIED
  ? 1
  : Number(process.env.PHONE_CLI_PORT_ATTEMPTS || 20);
const HOST = process.env.PHONE_CLI_HOST || "0.0.0.0";
const SESSION = SESSION_ARG || "phone-cli";
const CLI_COMMAND = COMMAND_ARG || "";
const WORKDIR = WORKDIR_ARG || process.cwd();
const TITLE = TITLE_ARG || "Phone CLI";
const TOKEN = TOKEN_ARG || randomBytes(18).toString("base64url");
const CAPTURE_LINES = Number(process.env.PHONE_CLI_CAPTURE_LINES || 240);
const MAX_IMAGE_COUNT = Number(process.env.PHONE_CLI_MAX_IMAGES || 4);
const MAX_IMAGE_BYTES = Number(process.env.PHONE_CLI_MAX_IMAGE_BYTES || 12 * 1024 * 1024);
const MAX_SEND_BODY_BYTES = Number(
  process.env.PHONE_CLI_MAX_SEND_BODY_BYTES
    || Math.ceil(MAX_IMAGE_BYTES * MAX_IMAGE_COUNT * 1.4 + 1024 * 1024),
);
const SAFE_SESSION = SESSION.replace(/[^a-zA-Z0-9._-]/g, "_");
const UPLOAD_DIR = process.env.PHONE_CLI_UPLOAD_DIR
  || join(tmpdir(), "phone-cli-bridge", SAFE_SESSION);
const CONFIG_DIR = process.env.PHONE_CLI_CONFIG_DIR
  || join(homedir(), ".phone-cli-bridge");
const TOOLS_PATH = process.env.PHONE_CLI_TOOLS_PATH
  || join(CONFIG_DIR, "tools.json");
const HISTORY_PATH = join(CONFIG_DIR, "history.json");
const SENT_HISTORY_PATH = join(CONFIG_DIR, "sent-history", `${SAFE_SESSION}.json`);
const MAX_HISTORY_ITEMS = 200;
const MAX_HISTORY_TEXT_LENGTH = 4000;
const BATTERY_STATUS_TTL_MS = Number(process.env.PHONE_CLI_BATTERY_STATUS_TTL_MS || 30 * 1000);
const SNAPSHOT_STABLE_ALERT_MS = Number(process.env.PHONE_CLI_SNAPSHOT_STABLE_ALERT_MS || 10 * 1000);

const IMAGE_EXTENSIONS = new Map([
  ["image/gif", ".gif"],
  ["image/heic", ".heic"],
  ["image/heif", ".heif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);

const clients = new Set();
let lastSnapshot = "";
let observedSnapshotHash = "";
let observedSnapshotChangedAt = 0;
let activePort = PORT;
let currentWorkdir = resolve(WORKDIR);
let batteryStatusCache = { checkedAt: 0, value: null };

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const { stdin, ...spawnOptions } = options;
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...spawnOptions,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      resolve({ ok: false, code: -1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, code, stdout, stderr });
    });

    if (stdin !== undefined) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

function printHelp() {
  console.log(`
Phone CLI Bridge

用法：
  phone-bridge             显示这份使用说明
  phone-bridge -h          显示这份使用说明
  phone-bridge -r          启动手机网页 Bridge，并使用当前目录作为 CLI 工作目录
  phone-bridge -r -t xxx   使用固定 token 启动 Bridge
  phone-bridge -r -p 8766  指定端口启动 Bridge
  phone-bridge -r -n xxx   指定网页标题
  phone-bridge -r -w xxx   指定 CLI 工作目录
  phone-bridge -r -s xxx   指定 tmux 会话名
  phone-bridge -r -cmd xxx 指定 tmux 会话里启动的命令
  phone-bridge -k          关闭 Bridge 进程和 tmux 会话

常用参数：
  -p, --port               端口，默认 8765；指定后被占用会直接退出
  -t, --token              固定访问 token；不设置时每次启动自动生成
  -n, --title              网页标题，默认 Phone CLI
  -w, --workdir            CLI 工作目录，默认当前目录
  -s, --session            tmux 会话名，默认 phone-cli
  -cmd, --cmd              tmux 会话里启动的命令；不指定时只创建会话，不自动运行命令

示例：
  cd /Users/user_name/project_dir
  phone-bridge -r

  phone-bridge -r -p 8766

  phone-bridge -r -s phone-cli-project -p 8765 -t my-token -n Fun -cmd "your-cli-command"

  phone-bridge -k
`.trim());
}

async function killRelated() {
  console.log("正在关闭 Phone CLI Bridge 相关进程...");

  const tmux = await run("tmux", ["kill-session", "-t", SESSION]);
  if (tmux.ok) {
    console.log(`已关闭 tmux 会话：${SESSION}`);
  } else {
    const message = (tmux.stderr || tmux.stdout || "").trim();
    console.log(message ? `tmux 会话未关闭：${message}` : `没有找到 tmux 会话：${SESSION}`);
  }

  const ps = await run("ps", ["-axo", "pid=,command="]);
  if (!ps.ok) {
    console.log(`无法检查 Bridge 进程：${(ps.stderr || ps.stdout || "").trim()}`);
    return;
  }

  const currentPid = process.pid;
  const pids = ps.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), command: match[2] } : null;
    })
    .filter(Boolean)
    .filter(({ pid, command }) => {
      return pid !== currentPid
        && command.includes(SCRIPT_PATH)
        && command.includes("server.mjs");
    });

  for (const { pid } of pids) {
    try {
      process.kill(pid, "SIGTERM");
      console.log(`已停止 Bridge 进程：${pid}`);
    } catch (error) {
      console.log(`停止 Bridge 进程失败：${pid} ${error.message || error}`);
    }
  }

  if (pids.length === 0) {
    console.log("没有找到正在运行的 Bridge 进程。");
  }
}

if (ARGS.length === 0 || ARGS.includes("-h") || ARGS.includes("--help")) {
  printHelp();
  process.exit(0);
}

if (ARGS.includes("-k") || ARGS.includes("--kill")) {
  await killRelated();
  process.exit(0);
}

const shouldRun = ARGS.includes("-r") || ARGS.includes("--run");
if (shouldRun && ARGS.some((arg) => arg === "-t" || arg === "--token") && !TOKEN_ARG) {
  console.error("缺少 token 值。用法：phone-bridge -r -t your-token");
  process.exit(1);
}

if (shouldRun && ARGS.some((arg) => arg === "-n" || arg === "--title" || arg.startsWith("--title=")) && !TITLE_ARG) {
  console.error("缺少标题值。用法：phone-bridge -r -n Fun");
  process.exit(1);
}

if (shouldRun && ARGS.some((arg) => arg === "-cmd" || arg === "--cmd" || arg.startsWith("--cmd=")) && !COMMAND_ARG) {
  console.error('缺少命令值。用法：phone-bridge -r -cmd "your-cli-command"');
  process.exit(1);
}

if (shouldRun && ARGS.some((arg) => arg === "-w" || arg === "--workdir" || arg.startsWith("--workdir=")) && !WORKDIR_ARG) {
  console.error("缺少工作目录值。用法：phone-bridge -r -w /path/to/project");
  process.exit(1);
}

if (shouldRun && ARGS.some((arg) => arg === "-s" || arg === "--session" || arg.startsWith("--session=")) && !SESSION_ARG) {
  console.error("缺少 tmux 会话名。用法：phone-bridge -r -s phone-cli");
  process.exit(1);
}

if (shouldRun && ARGS.some((arg) => arg === "-p" || arg === "--port" || arg.startsWith("--port=")) && !PORT_ARG) {
  console.error("缺少端口值。用法：phone-bridge -r -p 8766");
  process.exit(1);
}

if (shouldRun && (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535)) {
  console.error(`端口无效：${PORT_ARG}`);
  console.error("用法：phone-bridge -r -p 8766");
  process.exit(1);
}

const allowedArgs = new Set([
  "-r",
  "--run",
  "-t",
  "--token",
  "-p",
  "--port",
  "-n",
  "--title",
  "-cmd",
  "--cmd",
  "-w",
  "--workdir",
  "-s",
  "--session",
]);
const unsupportedArgs = [];
for (let index = 0; index < ARGS.length; index += 1) {
  const arg = ARGS[index];
  if (arg.startsWith("--token=")) continue;
  if (arg.startsWith("--port=")) continue;
  if (arg.startsWith("--title=")) continue;
  if (arg.startsWith("--cmd=")) continue;
  if (arg.startsWith("--workdir=")) continue;
  if (arg.startsWith("--session=")) continue;
  if (!allowedArgs.has(arg)) {
    unsupportedArgs.push(arg);
    continue;
  }
  if (
    arg === "-t"
    || arg === "--token"
    || arg === "-p"
    || arg === "--port"
    || arg === "-n"
    || arg === "--title"
    || arg === "-cmd"
    || arg === "--cmd"
    || arg === "-w"
    || arg === "--workdir"
    || arg === "-s"
    || arg === "--session"
  ) {
    if (!ARGS[index + 1] || ARGS[index + 1].startsWith("-")) {
      unsupportedArgs.push(arg);
      continue;
    }
    index += 1;
  }
}

if (!shouldRun || unsupportedArgs.length > 0) {
  console.error(`不支持的参数：${ARGS.join(" ")}`);
  console.error("运行 phone-bridge -h 查看使用说明。");
  process.exit(1);
}

function safeEqual(left, right) {
  const a = Buffer.from(left || "");
  const b = Buffer.from(right || "");
  return a.length === b.length && timingSafeEqual(a, b);
}

function getAuthToken(req, url) {
  const header = req.headers["x-phone-cli-token"];
  if (typeof header === "string" && header.length > 0) return header;
  return url.searchParams.get("token") || "";
}

function isAuthed(req, url) {
  return safeEqual(getAuthToken(req, url), TOKEN);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sendSSE(client, event, data) {
  client.write(`event: ${event}\n`);
  client.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const client of clients) {
    sendSSE(client, event, data);
  }
}

function hashSnapshot(snapshot) {
  return createHash("sha256").update(String(snapshot || "")).digest("hex");
}

function snapshotStabilityPayload(now = Date.now()) {
  const stableMs = observedSnapshotChangedAt > 0 ? now - observedSnapshotChangedAt : 0;
  return {
    snapshotHash: observedSnapshotHash,
    snapshotChangedAt: observedSnapshotChangedAt,
    snapshotStableMs: stableMs,
    snapshotStable: stableMs >= SNAPSHOT_STABLE_ALERT_MS,
    snapshotStableAlertMs: SNAPSHOT_STABLE_ALERT_MS,
  };
}

function observeSnapshot(snapshot) {
  const hash = hashSnapshot(snapshot);
  const now = Date.now();

  if (hash !== observedSnapshotHash) {
    observedSnapshotHash = hash;
    observedSnapshotChangedAt = now;
  } else if (observedSnapshotChangedAt === 0) {
    observedSnapshotChangedAt = now;
  }

  return snapshotStabilityPayload(now);
}

async function readBody(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      throw new Error(`Request body is too large. Limit is ${Math.floor(maxBytes / 1024 / 1024)} MB.`);
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

async function hasTmux() {
  const result = await run("tmux", ["-V"]);
  return result.ok;
}

async function sessionExists() {
  const result = await run("tmux", ["has-session", "-t", SESSION]);
  return result.ok;
}

async function startSession() {
  if (!(await hasTmux())) {
    return {
      ok: false,
      error: "tmux is not installed or not in PATH. Install it first, then restart this bridge.",
    };
  }

  if (!existsSync(WORKDIR) || !statSync(WORKDIR).isDirectory()) {
    return {
      ok: false,
      error: `workdir is not a directory: ${WORKDIR}`,
    };
  }

  if (await sessionExists()) {
    return { ok: true, alreadyRunning: true };
  }

  const create = await run("tmux", ["new-session", "-d", "-s", SESSION, "-c", WORKDIR]);
  if (!create.ok) {
    return { ok: false, error: create.stderr || create.stdout || "Failed to create tmux session." };
  }

  if (CLI_COMMAND.trim()) {
    await run("tmux", ["send-keys", "-t", SESSION, CLI_COMMAND, "Enter"]);
  }
  return { ok: true, alreadyRunning: false };
}

async function capturePane() {
  if (!(await sessionExists())) {
    return "";
  }

  const result = await run("tmux", [
    "capture-pane",
    "-t",
    SESSION,
    "-p",
    "-S",
    `-${CAPTURE_LINES}`,
  ]);
  if (!result.ok) {
    return result.stderr || "";
  }
  return result.stdout.trimEnd();
}

async function paneCurrentPath() {
  if (!(await sessionExists())) return currentWorkdir;

  const result = await run("tmux", [
    "display-message",
    "-p",
    "-t",
    SESSION,
    "#{pane_current_path}",
  ]);
  if (!result.ok) return currentWorkdir;

  const path = result.stdout.trim();
  if (path) currentWorkdir = path;
  return currentWorkdir;
}

function safeFileStem(name) {
  const parsed = basename(String(name || "image"), extname(String(name || "")));
  return parsed
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "image";
}

function imageExtension(type, name) {
  const fromType = IMAGE_EXTENSIONS.get(String(type || "").toLowerCase());
  if (fromType) return fromType;

  const fromName = extname(String(name || "")).toLowerCase();
  if ([...IMAGE_EXTENSIONS.values()].includes(fromName)) return fromName;
  return ".img";
}

function saveUploadedImages(images) {
  if (!Array.isArray(images) || images.length === 0) return [];
  if (images.length > MAX_IMAGE_COUNT) {
    throw new Error(`Too many images. Limit is ${MAX_IMAGE_COUNT}.`);
  }

  mkdirSync(UPLOAD_DIR, { recursive: true });

  return images.map((image, index) => {
    const name = String(image?.name || `image-${index + 1}`);
    const type = String(image?.type || "");
    const dataUrl = String(image?.dataUrl || "");
    const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
    if (!match) {
      throw new Error(`Invalid image payload: ${name}`);
    }

    const mimeType = type || match[1];
    if (!mimeType.startsWith("image/")) {
      throw new Error(`Unsupported image type: ${mimeType || name}`);
    }

    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length === 0) {
      throw new Error(`Image is empty: ${name}`);
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new Error(`Image is too large: ${name}`);
    }

    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .replace("Z", "");
    const random = randomBytes(4).toString("hex");
    const filename = `${stamp}_${index + 1}_${random}_${safeFileStem(name)}${imageExtension(mimeType, name)}`;
    const path = join(UPLOAD_DIR, filename);
    writeFileSync(path, buffer, { mode: 0o600 });
    return { name, type: mimeType, path, bytes: buffer.length };
  });
}

function composeMessage(text, savedImages) {
  const value = String(text || "").trimEnd();
  if (savedImages.length === 0) return value;

  const imageLines = savedImages
    .map((image, index) => `${index + 1}. ${image.path}`)
    .join("\n");
  const note = [
    "Uploaded image files are saved locally at:",
    imageLines,
    "",
    "Please inspect these local image files as image inputs for this request.",
  ].join("\n");

  return value ? `${value}\n\n${note}` : note;
}

async function sendMessage(text, images = []) {
  if (!(await sessionExists())) {
    const started = await startSession();
    if (!started.ok) return started;
  }

  const savedImages = saveUploadedImages(images);
  const value = composeMessage(text, savedImages);
  if (!value) return { ok: false, error: "Message is empty." };

  const load = await run("tmux", ["load-buffer", "-"], { stdin: value });
  if (!load.ok) {
    return { ok: false, error: load.stderr || "Failed to load tmux buffer." };
  }

  const paste = await run("tmux", ["paste-buffer", "-t", SESSION, "-p"]);
  if (!paste.ok) {
    return { ok: false, error: paste.stderr || "Failed to paste into tmux session." };
  }

  const enter = await run("tmux", ["send-keys", "-t", SESSION, "Enter"]);
  if (!enter.ok) {
    return { ok: false, error: enter.stderr || "Failed to submit message." };
  }

  return { ok: true, images: savedImages.map((image) => image.path) };
}

async function sendKey(key) {
  if (!(await sessionExists())) {
    return { ok: false, error: "Session is not running." };
  }

  const allowed = new Set(["Enter", "Escape", "C-c", "C-d", "Up", "Down"]);
  if (!allowed.has(key)) {
    return { ok: false, error: "Unsupported key." };
  }

  const result = await run("tmux", ["send-keys", "-t", SESSION, key]);
  return result.ok
    ? { ok: true }
    : { ok: false, error: result.stderr || `Failed to send ${key}.` };
}

function normalizeDirectoryPath(value) {
  const raw = String(value || currentWorkdir || WORKDIR).trim();
  const expanded = raw === "~"
    ? homedir()
    : raw.startsWith("~/")
      ? join(homedir(), raw.slice(2))
      : raw;
  const absolute = isAbsolute(expanded) ? expanded : resolve(currentWorkdir, expanded);
  const path = resolve(absolute);

  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`Not a directory: ${path}`);
  }
  return path;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function listDirectories(pathValue) {
  const path = normalizeDirectoryPath(pathValue);
  const parent = dirname(path);
  const children = readdirSync(path, { withFileTypes: true })
    .flatMap((entry) => {
      const childPath = join(path, entry.name);
      try {
        if (!statSync(childPath).isDirectory()) return [];
      } catch {
        return [];
      }
      return [{
        name: entry.name,
        path: childPath,
        hidden: entry.name.startsWith("."),
      }];
    })
    .sort((a, b) => {
      if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

  return {
    ok: true,
    path,
    parent: parent === path ? "" : parent,
    children,
  };
}

async function changeDirectory(pathValue) {
  const path = normalizeDirectoryPath(pathValue);
  const result = await sendMessage(`cd ${shellQuote(path)}`);
  if (!result.ok) return result;
  currentWorkdir = path;
  return { ok: true, workdir: currentWorkdir };
}

function normalizeTools(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((tool) => {
    const name = String(tool?.name || "").trim();
    const command = String(tool?.command || "").trim();
    if (!name || !command) return [];
    return [{
      id: String(tool?.id || randomBytes(8).toString("hex")),
      name,
      command,
    }];
  });
}

function readTools() {
  if (!existsSync(TOOLS_PATH)) return [];
  const raw = readFileSync(TOOLS_PATH, "utf8");
  return normalizeTools(JSON.parse(raw));
}

function writeTools(tools) {
  const normalized = normalizeTools(tools);
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(TOOLS_PATH, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return normalized;
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const normalized = [];

  for (const item of value) {
    const text = String(typeof item === "string" ? item : item?.text || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    normalized.push(text.slice(0, MAX_HISTORY_TEXT_LENGTH));
    if (normalized.length >= MAX_HISTORY_ITEMS) break;
  }

  return normalized;
}

function readHistory() {
  if (!existsSync(HISTORY_PATH)) return [];
  try {
    const raw = readFileSync(HISTORY_PATH, "utf8");
    return normalizeHistory(JSON.parse(raw));
  } catch {
    return [];
  }
}

function writeHistory(history) {
  const normalized = normalizeHistory(history);
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(HISTORY_PATH, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return normalized;
}

function addHistory(text) {
  const value = String(text || "").trim();
  if (!value) return readHistory();
  try {
    return writeHistory([value, ...readHistory().filter((item) => item !== value)]);
  } catch {
    return readHistory();
  }
}

function readSentHistory() {
  if (!existsSync(SENT_HISTORY_PATH)) return [];
  try {
    const raw = readFileSync(SENT_HISTORY_PATH, "utf8");
    return normalizeHistory(JSON.parse(raw));
  } catch {
    return [];
  }
}

function writeSentHistory(history) {
  const normalized = normalizeHistory(history);
  mkdirSync(dirname(SENT_HISTORY_PATH), { recursive: true });
  writeFileSync(SENT_HISTORY_PATH, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return normalized;
}

function addSentHistory(text) {
  const value = String(text || "").trim();
  if (!value) return readSentHistory();
  try {
    return writeSentHistory([value, ...readSentHistory().filter((item) => item !== value)]);
  } catch {
    return readSentHistory();
  }
}

function localHistoryPaths() {
  const shellName = basename(process.env.SHELL || "");
  const candidates = [];

  if (shellName === "zsh") candidates.push(join(homedir(), ".zsh_history"));
  if (shellName === "bash") {
    candidates.push(join(homedir(), ".bash_history"));
    candidates.push(join(homedir(), ".bash_sessions"));
  }
  if (shellName === "fish") candidates.push(join(homedir(), ".config", "fish", "fish_history"));

  candidates.push(join(homedir(), ".zsh_history"));
  candidates.push(join(homedir(), ".bash_history"));
  candidates.push(join(homedir(), ".config", "fish", "fish_history"));

  return [...new Set(candidates)];
}

function parseLocalHistoryLine(line) {
  const value = String(line || "").trim();
  if (!value || value.startsWith("#")) return "";

  const zshMatch = value.match(/^:\s*\d+:\d+;(.*)$/);
  if (zshMatch) return zshMatch[1].trim();

  const fishMatch = value.match(/^-\s*cmd:\s*(.*)$/);
  if (fishMatch) {
    return fishMatch[1]
      .replace(/\\n/g, "\n")
      .replace(/\\:/g, ":")
      .trim();
  }

  if (value.startsWith("when: ") || value.startsWith("paths: ")) return "";
  return value;
}

function readLocalComputerHistory() {
  const newestToOldest = [];

  for (const path of localHistoryPaths()) {
    if (!existsSync(path)) continue;
    try {
      const stat = statSync(path);
      if (stat.isDirectory()) continue;
      const lines = readFileSync(path, "utf8").split(/\r?\n/);
      const fileItems = [];
      for (const line of lines) {
        const parsed = parseLocalHistoryLine(line);
        if (parsed) fileItems.push(parsed);
      }
      newestToOldest.push(...fileItems.reverse());
    } catch {
      // Ignore unreadable shell history files.
    }
  }

  return normalizeHistory(newestToOldest);
}

function seedHistoryIfEmpty() {
  if (readHistory().length > 0) return;

  const localHistory = readLocalComputerHistory();
  if (localHistory.length === 0) return;

  writeHistory(localHistory);
  console.log(`已从本机 shell history 导入 ${localHistory.length} 条历史输入。`);
}

function parseBatteryStatus(text) {
  const percentMatch = text.match(/(\d+)%/);
  if (!percentMatch) return null;

  const stateMatch = text.match(/;\s*([^;]+);/);
  const sourceMatch = text.match(/Now drawing from '([^']+)'/);
  return {
    percent: Number(percentMatch[1]),
    state: stateMatch ? stateMatch[1].trim() : "",
    source: sourceMatch ? sourceMatch[1] : "",
  };
}

async function batteryStatus() {
  const now = Date.now();
  if (now - batteryStatusCache.checkedAt < BATTERY_STATUS_TTL_MS) {
    return batteryStatusCache.value;
  }

  const result = await run("pmset", ["-g", "batt"]);
  const value = result.ok ? parseBatteryStatus(result.stdout) : null;
  batteryStatusCache = { checkedAt: now, value };
  return value;
}

function getLANAddresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family === "IPv4" && !item.internal) {
        addresses.push(item.address);
      }
    }
  }
  return addresses;
}

function probeAddress(address, port, timeoutMs = 350) {
  return new Promise((resolve) => {
    const socket = connectSocket({ host: address, port });
    let settled = false;

    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function probeLANAddresses(port) {
  const addresses = getLANAddresses();
  const results = await Promise.all(addresses.map(async (address) => {
    return {
      address,
      reachable: await probeAddress(address, port),
    };
  }));

  return results.sort((left, right) => Number(right.reachable) - Number(left.reachable));
}

async function statusPayload(snapshotStability = snapshotStabilityPayload()) {
  const [tmuxAvailable, running, workdir, battery] = await Promise.all([
    hasTmux(),
    sessionExists(),
    paneCurrentPath(),
    batteryStatus(),
  ]);

  return {
    session: SESSION,
    command: CLI_COMMAND,
    title: TITLE,
    workdir,
    port: activePort,
    tmuxAvailable,
    running,
    captureLines: CAPTURE_LINES,
    battery,
    ...snapshotStability,
  };
}

function page() {
  const pageTitle = escapeHtml(TITLE);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${pageTitle}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #10130f;
      --panel: #181d17;
      --panel-2: #20261f;
      --line: #333b31;
      --text: #f0f2e9;
      --muted: #aab3a2;
      --accent: #d7ff62;
      --accent-2: #61d6ff;
      --danger: #ff6d6d;
      --shadow: 0 18px 50px rgba(0, 0, 0, .35);
      font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    }

    * { box-sizing: border-box; }

    html,
    body {
      height: 100%;
      overflow: hidden;
    }

    body {
      margin: 0;
      background:
        linear-gradient(135deg, rgba(215, 255, 98, .08), transparent 28%),
        linear-gradient(315deg, rgba(97, 214, 255, .08), transparent 32%),
        var(--bg);
      color: var(--text);
    }

    .app {
      height: 100vh;
      height: 100dvh;
      display: flex;
      flex-direction: column;
      grid-template-rows: auto minmax(0, 1fr) auto;
      padding: max(14px, env(safe-area-inset-top)) 14px max(14px, env(safe-area-inset-bottom));
      gap: 12px;
      overflow: hidden;
    }

    header {
      flex: 0 0 auto;
      display: grid;
      gap: 10px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(24, 29, 23, .86);
      box-shadow: var(--shadow);
      backdrop-filter: blur(16px);
    }

    .topline {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }

    h1 {
      margin: 0;
      font-size: 17px;
      letter-spacing: 0;
      font-weight: 740;
    }

    .status {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }

    .dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--danger);
      box-shadow: 0 0 0 4px rgba(255, 109, 109, .13);
    }

    .dot.ok {
      background: var(--accent);
      box-shadow: 0 0 0 4px rgba(215, 255, 98, .13);
    }

    .target-row {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }

    .target {
      flex: 1 1 auto;
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      padding: 7px 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(12, 15, 11, .72);
    }

    .target-label {
      flex: 0 0 auto;
      color: var(--muted);
      font-size: 12px;
    }

    .target-path {
      flex: 1 1 auto;
      min-width: 0;
      color: var(--accent-2);
      font-size: 12px;
      line-height: 1.3;
      direction: rtl;
      overflow: hidden;
      text-align: left;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .target-go,
    .target-settings,
    .dir-close {
      flex: 0 0 auto;
      width: 30px;
      min-height: 30px;
      padding: 0;
      color: var(--accent);
      font-size: 12px;
      font-weight: 780;
    }

    .target-settings svg {
      display: block;
      width: 16px;
      height: 16px;
      margin: 0 auto;
    }

    .target-go.is-active,
    .target-settings.is-active,
    .sent-history-open.is-active {
      border-color: rgba(215, 255, 98, .72);
      background: rgba(215, 255, 98, .18);
      color: var(--accent);
      box-shadow: 0 0 0 3px rgba(215, 255, 98, .1);
    }

    .tool-menu {
      display: grid;
      gap: 0;
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(12, 15, 11, .92);
    }

    .tool-menu[hidden] {
      display: none;
    }

    .tool-list,
    .tool-form {
      display: grid;
      gap: 8px;
    }

    .tool-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 34px;
      gap: 8px;
      min-width: 0;
    }

    .tool-empty {
      padding: 8px 2px 2px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }

    .tool-run {
      min-width: 0;
      min-height: 34px;
      color: var(--accent);
      text-align: left;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tool-delete {
      min-height: 34px;
      padding: 0;
      color: var(--muted);
    }

    .tool-add-open {
      min-height: 34px;
      margin-top: 10px;
      border-color: rgba(215, 255, 98, .38);
      color: var(--accent);
    }

    .tool-modal {
      position: fixed;
      inset: 0;
      z-index: 20;
      display: grid;
      place-items: center;
      padding: 18px;
      background: rgba(0, 0, 0, .56);
    }

    .tool-modal[hidden] {
      display: none;
    }

    .tool-modal-panel {
      display: grid;
      gap: 10px;
      width: min(420px, 100%);
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(24, 29, 23, .98);
      box-shadow: var(--shadow);
    }

    .tool-modal-head,
    .tool-modal-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .tool-modal-title {
      flex: 1 1 auto;
      color: var(--text);
      font-size: 13px;
      font-weight: 780;
    }

    .tool-close {
      width: 30px;
      min-height: 30px;
      padding: 0;
      color: var(--muted);
    }

    .tool-modal-actions button {
      flex: 1 1 0;
      min-width: 0;
    }

    .tool-form {
      min-width: 0;
    }

    .tool-field {
      width: 100%;
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #0c0f0b;
      color: var(--text);
      outline: none;
      font-size: 16px;
    }

    input.tool-field {
      min-height: 34px;
      padding: 0 10px;
    }

    textarea.tool-field {
      height: 58px;
      min-height: 58px;
      max-height: 58px;
      padding: 9px 10px;
    }

    .tool-note {
      min-height: 16px;
      color: var(--muted);
      font-size: 12px;
    }

    .tool-note:empty {
      display: none;
    }

    .alert-modal {
      z-index: 30;
      display: block;
      padding: 0;
      background:
        radial-gradient(circle at 50% 42%, rgba(255, 196, 87, .18), transparent 34%),
        rgba(0, 0, 0, .72);
      backdrop-filter: blur(10px);
    }

    .alert-panel {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      gap: 12px;
      width: min(430px, calc(100vw - 32px));
      max-height: calc(100dvh - 32px);
      overflow: auto;
      padding: 14px;
      border-color: rgba(255, 196, 87, .78);
      background:
        linear-gradient(135deg, rgba(255, 196, 87, .23), rgba(255, 109, 109, .12)),
        rgba(33, 25, 15, .98);
      box-shadow:
        0 22px 70px rgba(0, 0, 0, .58),
        0 0 0 1px rgba(255, 243, 196, .08) inset,
        0 0 36px rgba(255, 196, 87, .16);
    }

    .alert-head {
      align-items: flex-start;
    }

    .alert-badge {
      flex: 0 0 auto;
      padding: 4px 7px;
      border: 1px solid rgba(255, 196, 87, .62);
      border-radius: 6px;
      background: rgba(255, 196, 87, .18);
      color: #ffd27a;
      font-size: 10px;
      font-weight: 780;
      line-height: 1;
    }

    .alert-title {
      color: #fff4d1;
      font-size: 15px;
    }

    .alert-message {
      min-height: 0;
      padding: 10px 11px;
      border: 1px solid rgba(255, 196, 87, .34);
      border-radius: 8px;
      background: rgba(12, 8, 3, .36);
      color: #fff8e6;
      font-size: 13px;
      line-height: 1.45;
    }

    .alert-panel .tool-close {
      color: #ffd27a;
    }

    .alert-panel .tool-modal-actions button {
      border-color: rgba(255, 196, 87, .58);
      background: #ffd27a;
      color: #23170a;
      font-weight: 780;
    }

    .alert-modal[data-tone="error"] {
      background:
        radial-gradient(circle at 50% 42%, rgba(255, 109, 109, .2), transparent 34%),
        rgba(0, 0, 0, .74);
    }

    .alert-modal[data-tone="error"] .alert-panel {
      border-color: rgba(255, 109, 109, .82);
      background:
        linear-gradient(135deg, rgba(255, 109, 109, .24), rgba(255, 196, 87, .08)),
        rgba(35, 17, 17, .98);
      box-shadow:
        0 22px 70px rgba(0, 0, 0, .58),
        0 0 0 1px rgba(255, 223, 223, .08) inset,
        0 0 36px rgba(255, 109, 109, .16);
    }

    .alert-modal[data-tone="error"] .alert-badge,
    .alert-modal[data-tone="error"] .alert-message {
      border-color: rgba(255, 109, 109, .46);
    }

    .alert-modal[data-tone="error"] .alert-badge {
      background: rgba(255, 109, 109, .18);
      color: #ffb7b7;
    }

    .alert-modal[data-tone="error"] .alert-title,
    .alert-modal[data-tone="error"] .tool-close {
      color: #ffe0e0;
    }

    .alert-modal[data-tone="error"] .tool-modal-actions button {
      border-color: rgba(255, 109, 109, .62);
      background: #ff8f8f;
      color: #240b0b;
    }

    .dir-picker {
      display: grid;
      gap: 8px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(12, 15, 11, .92);
    }

    .dir-picker[hidden] {
      display: none;
    }

    .dir-picker-head,
    .dir-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .dir-current {
      flex: 1 1 auto;
      min-width: 0;
      color: var(--accent-2);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .dir-breadcrumbs {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 0;
    }

    .dir-breadcrumbs button,
    .dir-list button,
    .dir-apply {
      min-height: 30px;
      color: var(--muted);
      font-size: 12px;
    }

    .dir-breadcrumbs button {
      padding: 0 8px;
    }

    .dir-list {
      display: grid;
      gap: 6px;
      max-height: 220px;
      overflow: auto;
    }

    .dir-list button {
      width: 100%;
      min-width: 0;
      padding: 0 10px;
      text-align: left;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .dir-empty {
      color: var(--muted);
      font-size: 12px;
      padding: 4px 2px;
    }

    .dir-apply {
      flex: 1 1 auto;
      border-color: rgba(215, 255, 98, .38);
      color: var(--accent);
    }

    textarea, button {
      font: inherit;
    }

    input {
      font: inherit;
    }

    input,
    textarea,
    select {
      font-size: 16px;
    }

    textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #0c0f0b;
      color: var(--text);
      outline: none;
    }

    textarea {
      height: 84px;
      min-height: 84px;
      max-height: 84px;
      resize: none;
      padding: 12px;
      overflow: auto;
      line-height: 1.42;
    }

    textarea:focus {
      border-color: rgba(215, 255, 98, .7);
      box-shadow: 0 0 0 3px rgba(215, 255, 98, .12);
    }

    button {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-2);
      color: var(--text);
      min-height: 38px;
      padding: 0 12px;
      cursor: pointer;
      touch-action: manipulation;
    }

    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #15180f;
      font-weight: 780;
    }

    button:disabled {
      opacity: .55;
      cursor: not-allowed;
    }

    main {
      flex: 1 1 0;
      min-height: 0;
      position: relative;
      display: flex;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(8, 10, 7, .92);
      overflow: hidden;
      box-shadow: var(--shadow);
    }

    pre {
      flex: 1;
      min-height: 0;
      height: auto;
      margin: 0;
      padding: 14px 52px 48px 14px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.38;
      font-size: 12px;
      color: #dfe7d6;
    }

    .term-command {
      color: var(--accent);
    }

    .term-warning {
      color: #ff8f8f;
    }

    .term-question {
      color: #f8ffe4;
    }

    .term-note,
    .term-muted {
      color: var(--muted);
    }

    .term-code {
      color: #ffd27a;
    }

    .term-key {
      color: #8ee6b9;
    }

    .term-path {
      color: var(--accent-2);
    }

    .term-url {
      color: #c9b7ff;
    }

    .term-flag {
      color: #8ee6b9;
    }

    .term-alert {
      color: #ff8f8f;
    }

    footer {
      flex: 0 0 auto;
      display: grid;
      gap: 8px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(24, 29, 23, .92);
      box-shadow: var(--shadow);
    }

    .input-row {
      display: flex;
      gap: 8px;
      align-items: stretch;
      min-width: 0;
    }

    .message-field {
      position: relative;
      flex: 1 1 auto;
      min-width: 0;
    }

    .input-row textarea {
      display: block;
      padding-right: 54px;
      padding-bottom: 34px;
    }

    .input-row > button {
      flex: 0 0 72px;
      min-height: 84px;
    }

    .image-input {
      position: absolute;
      width: 1px;
      height: 1px;
      opacity: 0;
      pointer-events: none;
    }

    .pick-image {
      position: absolute;
      right: 8px;
      bottom: 8px;
      width: 38px;
      min-height: 28px;
      padding: 0;
      border-color: rgba(215, 255, 98, .28);
      background: rgba(32, 38, 31, .88);
      color: var(--muted);
      font-size: 12px;
    }

    .sent-history-open {
      position: absolute;
      right: 8px;
      top: 8px;
      width: 38px;
      min-height: 28px;
      padding: 0;
      border-color: rgba(97, 214, 255, .28);
      background: rgba(32, 38, 31, .88);
      color: var(--muted);
      font-size: 12px;
    }

    .refresh-output {
      position: absolute;
      right: 8px;
      bottom: 8px;
      display: inline-grid;
      place-items: center;
      width: 30px;
      min-height: 28px;
      padding: 0;
      border-color: rgba(97, 214, 255, .28);
      background: rgba(32, 38, 31, .88);
      color: var(--muted);
    }

    .refresh-output svg {
      width: 16px;
      height: 16px;
    }

    .refresh-output.refreshing svg {
      animation: refresh-spin .75s linear infinite;
    }

    .refresh-toast {
      position: absolute;
      left: 50%;
      top: 50%;
      z-index: 12;
      transform: translate(-50%, -50%);
      min-width: 180px;
      max-width: min(86vw, 420px);
      padding: 14px 18px;
      border: 1px solid rgba(215, 255, 98, .72);
      border-radius: 8px;
      background:
        linear-gradient(135deg, rgba(215, 255, 98, .2), rgba(97, 214, 255, .12)),
        rgba(10, 13, 9, .98);
      color: #f8ffe4;
      font-size: 16px;
      font-weight: 780;
      line-height: 1.35;
      text-align: center;
      box-shadow:
        0 22px 70px rgba(0, 0, 0, .55),
        0 0 0 1px rgba(255, 255, 255, .08) inset,
        0 0 34px rgba(215, 255, 98, .18);
      pointer-events: none;
    }

    .refresh-toast[hidden] {
      display: none;
    }

    @keyframes refresh-spin {
      to { transform: rotate(360deg); }
    }

    .composer-note {
      position: absolute;
      left: 12px;
      right: 54px;
      bottom: 12px;
      color: var(--muted);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      pointer-events: none;
    }

    .history-suggestions {
      position: absolute;
      left: 0;
      right: 0;
      bottom: calc(100% + 6px);
      z-index: 30;
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 180px;
      padding: 6px;
      overflow: auto;
      border: 1px solid rgba(215, 255, 98, .24);
      border-radius: 8px;
      background: rgba(16, 20, 15, .98);
      box-shadow: var(--shadow);
    }

    .history-suggestions[hidden] {
      display: none;
    }

    .sent-history-panel {
      position: absolute;
      left: 0;
      right: 0;
      bottom: calc(100% + 6px);
      z-index: 31;
      display: grid;
      gap: 4px;
      max-height: 220px;
      padding: 6px;
      overflow: auto;
      border: 1px solid rgba(97, 214, 255, .24);
      border-radius: 8px;
      background: rgba(16, 20, 15, .98);
      box-shadow: var(--shadow);
    }

    .sent-history-panel[hidden] {
      display: none;
    }

    .history-suggestion {
      display: flex;
      align-items: center;
      min-height: 0;
      height: 34px;
      padding: 0 10px;
      border-radius: 6px;
      border-color: rgba(148, 160, 131, .18);
      background: rgba(28, 34, 26, .95);
      color: var(--text);
      font-size: 13px;
      line-height: 1.25;
      text-align: left;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .sent-history-item {
      min-height: 36px;
      padding: 8px 10px;
      border: 1px solid rgba(148, 160, 131, .18);
      border-radius: 6px;
      background: rgba(28, 34, 26, .95);
      color: var(--text);
      cursor: pointer;
      font-size: 13px;
      line-height: 1.25;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      user-select: none;
      -webkit-touch-callout: none;
    }

    .sent-history-item.is-pressing {
      border-color: rgba(97, 214, 255, .42);
      background: rgba(30, 47, 45, .96);
    }

    .sent-history-item.is-appended {
      border-color: rgba(215, 255, 98, .55);
      background: rgba(45, 55, 28, .96);
    }

    .sent-history-empty {
      padding: 8px 10px;
      color: var(--muted);
      font-size: 12px;
    }

    .history-suggestion:focus,
    .history-suggestion:hover {
      border-color: rgba(215, 255, 98, .45);
      background: rgba(39, 48, 35, .98);
    }

    .image-list {
      display: grid;
      gap: 8px;
    }

    .image-list[hidden] {
      display: none;
    }

    .image-chip {
      display: grid;
      grid-template-columns: 44px minmax(0, 1fr) 34px;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding: 6px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(12, 15, 11, .72);
    }

    .image-chip img {
      width: 44px;
      height: 44px;
      border-radius: 6px;
      object-fit: cover;
      background: #050604;
    }

    .image-meta {
      min-width: 0;
      display: grid;
      gap: 3px;
    }

    .image-name,
    .image-size {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .image-name {
      color: var(--text);
      font-size: 12px;
    }

    .image-size {
      color: var(--muted);
      font-size: 11px;
    }

    .remove-image {
      width: 34px;
      min-height: 34px;
      padding: 0;
      color: var(--muted);
    }

    .button-grid {
      display: grid;
      gap: 8px;
      grid-template-columns: repeat(3, 1fr);
      grid-template-rows: repeat(2, minmax(38px, 1fr));
    }

    .button-grid button {
      padding: 0 8px;
      color: var(--muted);
      white-space: nowrap;
    }

    .button-grid .enter-key {
      grid-column: 3;
      grid-row: 1 / span 2;
    }

    @media (max-width: 779px) {
      .app.composer-focused {
        padding-bottom: 4px;
        gap: 6px;
      }

      footer.composer-focused {
        gap: 4px;
        padding: 8px;
      }

      footer.composer-focused .button-grid {
        display: none;
      }
    }

    @media (min-width: 780px) {
      .app {
        max-width: 1040px;
        margin: 0 auto;
        grid-template-columns: 1fr 340px;
        grid-template-rows: auto 1fr;
        grid-template-areas:
          "head head"
          "term input";
      }

      header { grid-area: head; }
      main { grid-area: term; }
      footer {
        grid-area: input;
        align-self: start;
        position: sticky;
        top: 14px;
      }

      pre { min-height: 0; }
    }

    @media (orientation: landscape) and (max-height: 520px) {
      .app {
        max-width: none;
        grid-template-columns: 1fr;
        grid-template-rows: auto minmax(0, 1fr);
        grid-template-areas:
          "head"
          "term";
        padding: max(8px, env(safe-area-inset-top)) 8px max(8px, env(safe-area-inset-bottom));
        gap: 8px;
      }

      header {
        padding: 8px;
        gap: 6px;
      }

      footer {
        display: none;
      }

      main {
        min-height: 0;
      }

      pre {
        padding: 10px 10px 10px max(34px, calc(env(safe-area-inset-left) + 10px));
      }
    }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <div class="topline">
        <h1>${pageTitle}</h1>
        <div class="status"><span id="dot" class="dot"></span><span id="status">disconnected</span></div>
      </div>
      <div class="target-row">
        <div class="target">
          <div class="target-label">当前目录：</div>
          <div id="workdir" class="target-path">未连接</div>
          <button id="go-dir" class="target-go" type="button" aria-label="选择目录">Go</button>
        </div>
        <button id="tool-settings" class="target-settings" type="button" aria-label="快捷指令设置">
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"></path>
          </svg>
        </button>
      </div>
      <div id="tool-menu" class="tool-menu" hidden>
        <div id="tool-list" class="tool-list"></div>
        <button id="tool-add-open" class="tool-add-open" type="button">新增快捷指令</button>
        <div id="tool-note" class="tool-note"></div>
      </div>
      <div id="tool-modal" class="tool-modal" hidden>
        <div class="tool-modal-panel">
          <div class="tool-modal-head">
            <div class="tool-modal-title">新增快捷指令</div>
            <button id="tool-close" class="tool-close" type="button" aria-label="关闭新增快捷指令">x</button>
          </div>
        <form id="tool-form" class="tool-form">
          <input id="tool-name" class="tool-field" type="text" autocomplete="off" placeholder="快捷指令名字" />
          <textarea id="tool-command" class="tool-field" placeholder="发送的指令内容"></textarea>
            <div id="tool-modal-note" class="tool-note"></div>
            <div class="tool-modal-actions">
              <button id="tool-cancel" type="button">取消</button>
              <button id="tool-add" type="submit">保存</button>
            </div>
        </form>
        </div>
      </div>
      <div id="delete-tool-modal" class="tool-modal" hidden>
        <div class="tool-modal-panel">
          <div class="tool-modal-head">
            <div class="tool-modal-title">删除快捷指令</div>
            <button id="delete-tool-close" class="tool-close" type="button" aria-label="关闭删除确认">x</button>
          </div>
          <div id="delete-tool-message" class="tool-note"></div>
          <div class="tool-modal-actions">
            <button id="delete-tool-cancel" type="button">取消</button>
            <button id="delete-tool-confirm" type="button">删除</button>
          </div>
        </div>
      </div>
      <div id="dir-picker" class="dir-picker" hidden>
        <div class="dir-picker-head">
          <div id="dir-current" class="dir-current"></div>
          <button id="dir-close" class="dir-close" type="button" aria-label="关闭目录选择">x</button>
        </div>
        <div id="dir-breadcrumbs" class="dir-breadcrumbs"></div>
        <div id="dir-list" class="dir-list"></div>
        <div class="dir-actions">
          <button id="dir-apply" class="dir-apply" type="button">cd 到这里</button>
        </div>
      </div>
    </header>

    <main>
      <pre id="terminal">waiting for connection...</pre>
      <button id="refresh-output" class="refresh-output" type="button" aria-label="刷新终端输出">
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 0 1-15.2 6.5"></path>
          <path d="M3 12A9 9 0 0 1 18.2 5.5"></path>
          <path d="M18 2v4h4"></path>
          <path d="M6 22v-4H2"></path>
        </svg>
      </button>
      <div id="refresh-toast" class="refresh-toast" role="status" aria-live="polite" hidden>刷新中</div>
    </main>

    <footer id="composer">
      <div class="input-row">
        <div class="message-field">
          <div id="history-suggestions" class="history-suggestions" hidden></div>
          <div id="sent-history-panel" class="sent-history-panel" hidden></div>
          <textarea id="message" placeholder="输入要发送的话"></textarea>
          <button id="sent-history-open" class="sent-history-open" type="button" aria-label="显示发送历史">历史</button>
          <button id="pick-image" class="pick-image" type="button" aria-label="添加图片">图片</button>
          <input id="image-input" class="image-input" type="file" accept="image/*" multiple />
          <div id="composer-note" class="composer-note"></div>
        </div>
        <button id="send" class="primary">发送</button>
      </div>
      <div id="image-list" class="image-list" hidden></div>
      <div class="button-grid">
        <button data-key="Escape">Esc</button>
        <button data-key="Up">Up</button>
        <button class="enter-key" data-key="Enter">Enter</button>
        <button data-key="C-c">Ctrl-C</button>
        <button data-key="Down">Down</button>
      </div>
    </footer>
  </div>

  <div id="app-alert-modal" class="tool-modal alert-modal" role="alertdialog" aria-modal="true" aria-labelledby="app-alert-title" hidden>
    <div class="tool-modal-panel alert-panel">
      <div class="tool-modal-head alert-head">
        <div class="alert-badge" id="app-alert-badge">ALERT</div>
        <div id="app-alert-title" class="tool-modal-title alert-title">提示</div>
        <button id="app-alert-close" class="tool-close" type="button" aria-label="关闭提示">x</button>
      </div>
      <div id="app-alert-message" class="tool-note alert-message" aria-live="assertive"></div>
      <div class="tool-modal-actions">
        <button id="app-alert-ok" type="button">知道了</button>
      </div>
    </div>
  </div>

  <script>
    const terminal = document.querySelector("#terminal");
    const app = document.querySelector(".app");
    const statusText = document.querySelector("#status");
    const dot = document.querySelector("#dot");
    const workdir = document.querySelector("#workdir");
    const goDirButton = document.querySelector("#go-dir");
    const toolSettings = document.querySelector("#tool-settings");
    const toolMenu = document.querySelector("#tool-menu");
    const toolList = document.querySelector("#tool-list");
    const toolAddOpen = document.querySelector("#tool-add-open");
    const toolModal = document.querySelector("#tool-modal");
    const toolForm = document.querySelector("#tool-form");
    const toolName = document.querySelector("#tool-name");
    const toolCommand = document.querySelector("#tool-command");
    const toolCancel = document.querySelector("#tool-cancel");
    const toolClose = document.querySelector("#tool-close");
    const toolNote = document.querySelector("#tool-note");
    const toolModalNote = document.querySelector("#tool-modal-note");
    const appAlertModal = document.querySelector("#app-alert-modal");
    const appAlertBadge = document.querySelector("#app-alert-badge");
    const appAlertTitle = document.querySelector("#app-alert-title");
    const appAlertMessage = document.querySelector("#app-alert-message");
    const appAlertClose = document.querySelector("#app-alert-close");
    const appAlertOk = document.querySelector("#app-alert-ok");
    const deleteToolModal = document.querySelector("#delete-tool-modal");
    const deleteToolMessage = document.querySelector("#delete-tool-message");
    const deleteToolClose = document.querySelector("#delete-tool-close");
    const deleteToolCancel = document.querySelector("#delete-tool-cancel");
    const deleteToolConfirm = document.querySelector("#delete-tool-confirm");
    const dirPicker = document.querySelector("#dir-picker");
    const dirCurrent = document.querySelector("#dir-current");
    const dirBreadcrumbs = document.querySelector("#dir-breadcrumbs");
    const dirList = document.querySelector("#dir-list");
    const dirApply = document.querySelector("#dir-apply");
    const dirClose = document.querySelector("#dir-close");
    const message = document.querySelector("#message");
    const composer = document.querySelector("#composer");
    const sendButton = document.querySelector("#send");
    const sentHistoryOpen = document.querySelector("#sent-history-open");
    const sentHistoryPanel = document.querySelector("#sent-history-panel");
    const pickImage = document.querySelector("#pick-image");
    const refreshOutput = document.querySelector("#refresh-output");
    const refreshToast = document.querySelector("#refresh-toast");
    const imageInput = document.querySelector("#image-input");
    const imageList = document.querySelector("#image-list");
    const composerNote = document.querySelector("#composer-note");
    const historySuggestions = document.querySelector("#history-suggestions");
    const savedToken = new URL(location.href).searchParams.get("token") || localStorage.getItem("phone-cli-token") || "";
    const maxImageCount = ${MAX_IMAGE_COUNT};
    const maxImageBytes = ${MAX_IMAGE_BYTES};
    const batteryWarningThreshold = 10;
    const batteryWarningCooldownMs = 10 * 60 * 1000;
    const batteryWarningKey = "phone-cli-last-battery-warning-at";
    const terminalPullRefreshThreshold = 56;
    const alertSoundDurationMs = 520;
    const sentHistoryLongPressMs = 650;
    const sentHistoryLongPressMoveThreshold = 12;
    let customTools = [];
    let pendingDeleteToolId = "";
    let selectedImages = [];
    let displayedWorkdir = "";
    let selectedDir = "";
    let historyItems = [];
    let sentHistoryItems = [];
    let source = null;
    let terminalTouchStartY = 0;
    let terminalPullRefreshReady = false;
    let terminalAutoFollow = true;
    let terminalTouchActive = false;
    let terminalProgrammaticScroll = false;
    let terminalPendingSnapshot = null;
    let alertAudioContext = null;
    let alertSoundUnlocked = false;
    let lastObservedSnapshotHash = "";
    let stableSnapshotAlertArmed = false;
    let stableSnapshotAlertStartedAt = 0;
    let composerNoteTimer = 0;
    let toastTimer = 0;

    if (savedToken) {
      localStorage.setItem("phone-cli-token", savedToken);
    }

    function token() {
      return savedToken.trim();
    }

    function setStatus(text, ok) {
      statusText.textContent = text;
      dot.classList.toggle("ok", Boolean(ok));
    }

    function lastBatteryWarningAt() {
      return Number(localStorage.getItem(batteryWarningKey) || 0);
    }

    function markBatteryWarningShown() {
      localStorage.setItem(batteryWarningKey, String(Date.now()));
    }

    function showAlert({ title = "提示", message = "", badge = "ALERT", tone = "warning" } = {}) {
      appAlertBadge.textContent = badge;
      appAlertTitle.textContent = title;
      appAlertMessage.textContent = message;
      appAlertModal.dataset.tone = tone;
      appAlertModal.hidden = false;
    }

    function closeAlert() {
      appAlertModal.hidden = true;
    }

    function maybeShowBatteryWarning(battery) {
      if (!battery || typeof battery.percent !== "number") return;
      if (battery.percent >= batteryWarningThreshold) return;
      if (Date.now() - lastBatteryWarningAt() < batteryWarningCooldownMs) return;

      markBatteryWarningShown();
      const state = battery.state ? "，状态：" + battery.state : "";
      showAlert({
        title: "电脑电量不足",
        badge: "POWER",
        tone: "warning",
        message: "电脑当前电量 " + battery.percent + "%" + state + "，请尽快连接电源。",
      });
    }

    function getAlertAudioContext() {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return null;
      if (!alertAudioContext) alertAudioContext = new AudioContextClass();
      return alertAudioContext;
    }

    function unlockAlertSound() {
      if (alertSoundUnlocked) return;
      const context = getAlertAudioContext();
      if (!context) return;

      const resume = context.state === "suspended" ? context.resume() : Promise.resolve();
      resume
        .then(() => {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          gain.gain.setValueAtTime(0, context.currentTime);
          oscillator.connect(gain);
          gain.connect(context.destination);
          oscillator.start();
          oscillator.stop(context.currentTime + 0.01);
          alertSoundUnlocked = true;
        })
        .catch(() => {
          alertSoundUnlocked = false;
        });
    }

    function playStableSnapshotSound() {
      const context = getAlertAudioContext();
      if (!context) return;

      const startSound = () => {
        const start = context.currentTime;
        const gain = context.createGain();
        const first = context.createOscillator();
        const second = context.createOscillator();

        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.34, start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + alertSoundDurationMs / 1000);

        first.type = "sine";
        first.frequency.setValueAtTime(880, start);
        first.frequency.setValueAtTime(740, start + 0.16);

        second.type = "triangle";
        second.frequency.setValueAtTime(1320, start + 0.18);

        first.connect(gain);
        second.connect(gain);
        gain.connect(context.destination);

        first.start(start);
        second.start(start + 0.18);
        first.stop(start + 0.34);
        second.stop(start + alertSoundDurationMs / 1000);
      };

      const resume = context.state === "suspended" ? context.resume() : Promise.resolve();
      resume.then(startSound).catch(() => {});
    }

    function armStableSnapshotAlert() {
      stableSnapshotAlertArmed = true;
      stableSnapshotAlertStartedAt = Date.now();
    }

    function cancelStableSnapshotAlert() {
      stableSnapshotAlertArmed = false;
      stableSnapshotAlertStartedAt = 0;
    }

    function maybePlayStableSnapshotAlert(payload) {
      const hash = String(payload.snapshotHash || "");
      if (!hash) return;
      const stableAlertMs = Number(payload.snapshotStableAlertMs || 10000);
      const now = Date.now();

      if (!lastObservedSnapshotHash) {
        lastObservedSnapshotHash = hash;
        if (stableSnapshotAlertArmed && stableSnapshotAlertStartedAt === 0) {
          stableSnapshotAlertStartedAt = now;
        }
        return;
      }

      if (hash !== lastObservedSnapshotHash) {
        lastObservedSnapshotHash = hash;
        if (stableSnapshotAlertArmed) stableSnapshotAlertStartedAt = now;
        return;
      }

      if (!stableSnapshotAlertArmed) return;
      if (stableSnapshotAlertStartedAt === 0) stableSnapshotAlertStartedAt = now;
      if (now - stableSnapshotAlertStartedAt < stableAlertMs) return;

      stableSnapshotAlertArmed = false;
      stableSnapshotAlertStartedAt = 0;
      playStableSnapshotSound();
    }

    function formatBytes(bytes) {
      if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
      if (bytes >= 1024) return Math.ceil(bytes / 1024) + " KB";
      return bytes + " B";
    }

    function inferImageType(name) {
      const lower = String(name || "").toLowerCase();
      if (lower.endsWith(".gif")) return "image/gif";
      if (lower.endsWith(".heic")) return "image/heic";
      if (lower.endsWith(".heif")) return "image/heif";
      if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
      if (lower.endsWith(".png")) return "image/png";
      if (lower.endsWith(".webp")) return "image/webp";
      return "";
    }

    function setComposerNote(text) {
      if (composerNoteTimer) {
        clearTimeout(composerNoteTimer);
        composerNoteTimer = 0;
      }
      composerNote.textContent = text || "";
    }

    function setTemporaryComposerNote(text, timeoutMs = 1600) {
      setComposerNote(text);
      composerNoteTimer = setTimeout(() => {
        composerNote.textContent = "";
        composerNoteTimer = 0;
      }, timeoutMs);
    }

    function showToast(text, timeoutMs = 1800) {
      if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = 0;
      }
      refreshToast.textContent = text;
      refreshToast.hidden = false;
      toastTimer = setTimeout(() => {
        refreshToast.hidden = true;
        toastTimer = 0;
      }, timeoutMs);
    }

    function hideToast() {
      if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = 0;
      }
      refreshToast.hidden = true;
    }

    const terminalCommandWords = new Set([
      "airchat",
      "bazel",
      "brew",
      "cat",
      "cd",
      "chmod",
      "cp",
      "curl",
      "docker",
      "gh",
      "git",
      "go",
      "kill",
      "ls",
      "mkdir",
      "mv",
      "node",
      "npm",
      "pnpm",
      "python",
      "python3",
      "rg",
      "rm",
      "rsync",
      "sed",
      "swift",
      "tmux",
      "xcodebuild",
      "yarn",
    ]);
    const terminalAlertWords = [
      "error",
      "exception",
      "fail",
      "failed",
      "fatal",
      "warn",
      "warning",
      "崩溃",
      "报错",
      "错误",
      "失败",
      "异常",
      "警告",
    ];
    const terminalRequestStarts = [
      "can ",
      "could ",
      "fix ",
      "help ",
      "how ",
      "please ",
      "what ",
      "why ",
      "帮",
      "检查",
      "看看",
      "能不能",
      "能否",
      "请",
      "为什么",
      "怎么",
      "如何",
      "修复",
    ];

    function firstTerminalWord(text) {
      let end = 0;
      while (end < text.length && text[end] !== " " && text[end] !== "\t") end += 1;
      return text.slice(0, end).toLowerCase();
    }

    function trimTerminalToken(value) {
      const open = String.fromCharCode(34, 39, 40, 91, 123);
      const close = String.fromCharCode(34, 39, 41, 93, 125, 46, 44, 59, 58);
      let start = 0;
      let end = value.length;
      while (start < end && open.includes(value[start])) start += 1;
      while (end > start && close.includes(value[end - 1])) end -= 1;
      return value.slice(start, end);
    }

    function isLikelyTerminalPath(value) {
      const lower = value.toLowerCase();
      if (!value || value.includes("://")) return false;
      if (value.startsWith("/") || value.startsWith("~/") || value.startsWith("./") || value.startsWith("../")) return true;
      if (["app/", "lib/", "src/", "test/", "tests/", "tools/", "projects/"].some((prefix) => lower.startsWith(prefix))) return true;
      return value.includes("/") && value.includes(".");
    }

    function terminalLineTone(line) {
      const trimmed = line.trim();
      if (!trimmed) return "";

      const lower = trimmed.toLowerCase();
      const backtick = String.fromCharCode(96);
      if (terminalAlertWords.some((word) => lower.includes(word))) return "term-warning";
      if (trimmed.startsWith(backtick + backtick + backtick) || trimmed.startsWith("    ")) return "term-code";
      if (trimmed.startsWith("#") || trimmed.startsWith("//")) return "term-note";
      if (trimmed.startsWith("|") && trimmed.endsWith("|")) return "term-muted";
      if (trimmed.startsWith("$ ") || trimmed.startsWith("> ") || terminalCommandWords.has(firstTerminalWord(trimmed))) {
        return "term-command";
      }
      if (trimmed.endsWith("?") || trimmed.endsWith("？") || terminalRequestStarts.some((word) => lower.startsWith(word))) {
        return "term-question";
      }
      return "";
    }

    function terminalTokenTone(value) {
      const clean = trimTerminalToken(value);
      if (!clean) return "";

      const lower = clean.toLowerCase();
      if (lower.startsWith("http://") || lower.startsWith("https://")) return "term-url";
      if (terminalAlertWords.some((word) => lower.includes(word))) return "term-alert";
      if (isLikelyTerminalPath(clean)) return "term-path";
      if (clean.length > 1 && clean.startsWith("-")) return "term-flag";
      if (clean.endsWith(":") && clean.length > 1) return "term-key";
      return "";
    }

    function appendTerminalSpan(parent, text, className) {
      const span = document.createElement("span");
      if (className) span.className = className;
      span.textContent = text || String.fromCharCode(8203);
      parent.append(span);
    }

    function appendTerminalHighlightedLine(parent, line) {
      const lineSpan = document.createElement("span");
      const lineTone = terminalLineTone(line);
      if (lineTone) lineSpan.className = lineTone;

      if (!line) {
        appendTerminalSpan(lineSpan, "", "");
        parent.append(lineSpan);
        return;
      }

      let chunk = "";
      let chunkIsSpace = null;
      for (const char of line) {
        const isSpace = char === " " || char === "\t";
        if (chunk && isSpace !== chunkIsSpace) {
          appendTerminalSpan(lineSpan, chunk, chunkIsSpace ? "" : terminalTokenTone(chunk));
          chunk = "";
        }
        chunk += char;
        chunkIsSpace = isSpace;
      }
      if (chunk) appendTerminalSpan(lineSpan, chunk, chunkIsSpace ? "" : terminalTokenTone(chunk));
      parent.append(lineSpan);
    }

    function renderTerminalText(text) {
      terminal.textContent = "";
      const fragment = document.createDocumentFragment();
      const lines = String(text || "").split("\\n");
      for (let index = 0; index < lines.length; index += 1) {
        appendTerminalHighlightedLine(fragment, lines[index]);
        if (index < lines.length - 1) fragment.append(document.createTextNode("\\n"));
      }
      terminal.append(fragment);
    }

    function appendTextToMessage(text) {
      const value = String(text || "");
      if (!value) return;
      const current = message.value;
      const separator = current && !current.endsWith("\\n") ? "\\n" : "";
      message.value = current + separator + value;
      message.dispatchEvent(new Event("input", { bubbles: true }));
      if (document.activeElement === message) {
        message.setSelectionRange(message.value.length, message.value.length);
      }
    }

    function appendSentHistoryItem(text, item) {
      appendTextToMessage(text);
      item.classList.add("is-appended");
      showToast("已追加到输入框");
      setTimeout(() => item.classList.remove("is-appended"), 900);
    }

    function renderImages() {
      imageList.hidden = selectedImages.length === 0;
      imageList.textContent = "";

      for (const image of selectedImages) {
        const chip = document.createElement("div");
        chip.className = "image-chip";

        const preview = document.createElement("img");
        preview.src = image.url;
        preview.alt = "";

        const meta = document.createElement("div");
        meta.className = "image-meta";

        const name = document.createElement("div");
        name.className = "image-name";
        name.textContent = image.file.name || "image";

        const size = document.createElement("div");
        size.className = "image-size";
        size.textContent = formatBytes(image.file.size);

        const remove = document.createElement("button");
        remove.className = "remove-image";
        remove.type = "button";
        remove.textContent = "x";
        remove.setAttribute("aria-label", "移除图片");
        remove.addEventListener("click", () => {
          URL.revokeObjectURL(image.url);
          selectedImages = selectedImages.filter((item) => item.id !== image.id);
          renderImages();
        });

        meta.append(name, size);
        chip.append(preview, meta, remove);
        imageList.append(chip);
      }
    }

    function clearImages() {
      for (const image of selectedImages) {
        URL.revokeObjectURL(image.url);
      }
      selectedImages = [];
      imageInput.value = "";
      renderImages();
    }

    function fileToDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => resolve(String(reader.result || "")));
        reader.addEventListener("error", () => reject(reader.error || new Error("读取图片失败")));
        reader.readAsDataURL(file);
      });
    }

    async function imagePayloads() {
      return Promise.all(selectedImages.map(async (image) => {
        const type = image.file.type || inferImageType(image.file.name);
        const dataUrl = await fileToDataUrl(image.file);
        return {
          name: image.file.name || "image",
          type,
          dataUrl: type ? dataUrl.replace(/^data:;base64,/, "data:" + type + ";base64,") : dataUrl,
        };
      }));
    }

    async function api(path, body) {
      const res = await fetch(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-phone-cli-token": token(),
        },
        body: JSON.stringify(body || {}),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload.ok === false) {
        throw new Error(payload.error || res.statusText);
      }
      return payload;
    }

    async function runTool(tool, button) {
      try {
        if (button) button.disabled = true;
        showToast("发送中");
        await api("/send", { text: tool.command, images: [], recordSent: false });
        showToast("已发送：" + tool.name);
        closeToolMenu();
        await refresh();
      } catch (error) {
        showToast(error.message, 1800);
      } finally {
        if (button) button.disabled = false;
      }
    }

    async function loadTools() {
      try {
        const payload = await api("/tools", {});
        customTools = Array.isArray(payload.tools) ? payload.tools : [];
        renderTools();
      } catch (error) {
        showToast(error.message, 1800);
      }
    }

    function hideHistorySuggestions() {
      historySuggestions.hidden = true;
      historySuggestions.textContent = "";
    }

    function hideSentHistoryPanel() {
      sentHistoryPanel.hidden = true;
      sentHistoryPanel.textContent = "";
      sentHistoryOpen.classList.remove("is-active");
    }

    function closeToolMenu() {
      toolMenu.hidden = true;
      toolSettings.classList.remove("is-active");
    }

    function closeDirPicker() {
      dirPicker.hidden = true;
      goDirButton.classList.remove("is-active");
    }

    function previewHistoryText(text) {
      return String(text || "").replace(/\\s+/g, " ").trim();
    }

    function attachSentHistoryLongPress(item, text) {
      let timer = 0;
      let startX = 0;
      let startY = 0;
      let didAppend = false;
      let longPressReached = false;

      const clearLongPress = () => {
        if (!timer) return;
        clearTimeout(timer);
        timer = 0;
      };

      const startLongPress = (event) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        event.preventDefault();
        clearLongPress();
        didAppend = false;
        longPressReached = false;
        startX = event.clientX;
        startY = event.clientY;
        item.classList.add("is-pressing");
        timer = setTimeout(() => {
          timer = 0;
          longPressReached = true;
          item.classList.remove("is-pressing");
          item.classList.add("is-pressing");
          setTemporaryComposerNote("松手追加");
        }, sentHistoryLongPressMs);
      };

      const moveLongPress = (event) => {
        if (!timer) return;
        const moved = Math.hypot(event.clientX - startX, event.clientY - startY);
        if (moved < sentHistoryLongPressMoveThreshold) return;
        clearLongPress();
        longPressReached = false;
        item.classList.remove("is-pressing");
      };

      const endLongPress = () => {
        clearLongPress();
        item.classList.remove("is-pressing");
        const shouldAppend = longPressReached && !didAppend;
        longPressReached = false;
        if (shouldAppend) {
          appendSentHistoryItem(text, item);
          didAppend = true;
        }
      };

      item.addEventListener("pointerdown", startLongPress);
      item.addEventListener("pointermove", moveLongPress);
      item.addEventListener("pointerup", endLongPress);
      item.addEventListener("pointercancel", endLongPress);
      item.addEventListener("pointerleave", endLongPress);
      item.addEventListener("contextmenu", (event) => {
        if (!didAppend) {
          appendSentHistoryItem(text, item);
          didAppend = true;
        }
        event.preventDefault();
      });
    }

    function renderSentHistoryPanel() {
      sentHistoryPanel.textContent = "";

      if (sentHistoryItems.length === 0) {
        const empty = document.createElement("div");
        empty.className = "sent-history-empty";
        empty.textContent = "暂无发送历史";
        sentHistoryPanel.append(empty);
        return;
      }

      for (const text of sentHistoryItems) {
        const item = document.createElement("div");
        item.className = "sent-history-item";
        item.textContent = text;
        item.title = previewHistoryText(text);
        attachSentHistoryLongPress(item, text);
        sentHistoryPanel.append(item);
      }
    }

    async function loadSentHistory() {
      try {
        const payload = await api("/sent-history", {});
        sentHistoryItems = Array.isArray(payload.history) ? payload.history : [];
      } catch {
        sentHistoryItems = [];
      }
    }

    async function toggleSentHistoryPanel() {
      if (!sentHistoryPanel.hidden) {
        hideSentHistoryPanel();
        return;
      }

      hideHistorySuggestions();
      await loadSentHistory();
      renderSentHistoryPanel();
      sentHistoryPanel.hidden = false;
      sentHistoryOpen.classList.add("is-active");
    }

    function renderHistorySuggestions() {
      const prefix = message.value.trimStart();
      historySuggestions.textContent = "";
      if (!prefix) {
        hideHistorySuggestions();
        return;
      }

      const matches = historyItems
        .filter((item) => item.startsWith(prefix) && item !== prefix)
        .slice(0, 6);

      if (matches.length === 0) {
        hideHistorySuggestions();
        return;
      }

      for (const text of matches.slice().reverse()) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "history-suggestion";
        button.textContent = previewHistoryText(text);
        button.title = text;
        button.addEventListener("mousedown", (event) => {
          event.preventDefault();
        });
        button.addEventListener("click", () => {
          message.value = text;
          hideHistorySuggestions();
          message.focus();
        });
        historySuggestions.append(button);
      }

      historySuggestions.hidden = false;
      historySuggestions.scrollTop = historySuggestions.scrollHeight;
    }

    async function loadHistory() {
      try {
        const payload = await api("/history", {});
        historyItems = Array.isArray(payload.history) ? payload.history : [];
        renderHistorySuggestions();
      } catch {
        historyItems = [];
        hideHistorySuggestions();
      }
    }

    async function saveTools(tools) {
      const payload = await api("/tools/save", { tools });
      customTools = Array.isArray(payload.tools) ? payload.tools : [];
      renderTools();
    }

    function closeDeleteToolModal() {
      deleteToolModal.hidden = true;
      pendingDeleteToolId = "";
    }

    function requestDeleteTool(tool) {
      pendingDeleteToolId = tool.id;
      deleteToolMessage.textContent = "确认删除“" + tool.name + "”？";
      deleteToolModal.hidden = false;
    }

    async function deleteTool(id) {
      try {
        showToast("删除中");
        await saveTools(customTools.filter((tool) => tool.id !== id));
        closeDeleteToolModal();
        showToast("已删除");
      } catch (error) {
        showToast(error.message, 1800);
      }
    }

    function renderTools() {
      toolList.textContent = "";
      if (customTools.length === 0) {
        const empty = document.createElement("div");
        empty.className = "tool-empty";
        empty.textContent = "快捷指令可以保存常用输入，一点就能发送。";
        toolList.append(empty);
        return;
      }

      for (const tool of customTools) {
        const item = document.createElement("div");
        item.className = "tool-item";

        const runButton = document.createElement("button");
        runButton.type = "button";
        runButton.className = "tool-run";
        runButton.textContent = tool.name;
        runButton.title = tool.command;
        runButton.addEventListener("click", () => runTool(tool, runButton));

        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "tool-delete";
        deleteButton.textContent = "x";
        deleteButton.setAttribute("aria-label", "删除快捷指令");
        deleteButton.addEventListener("click", () => requestDeleteTool(tool));

        item.append(runButton, deleteButton);
        toolList.append(item);
      }
    }

    function openToolModal() {
      toolName.value = "";
      toolCommand.value = "";
      toolNote.textContent = "";
      toolModalNote.textContent = "";
      toolModal.hidden = false;
      requestAnimationFrame(() => toolName.focus());
    }

    function closeToolModal() {
      toolModal.hidden = true;
    }

    function renderBreadcrumbs(path) {
      dirBreadcrumbs.textContent = "";

      const rootButton = document.createElement("button");
      rootButton.type = "button";
      rootButton.textContent = "/";
      rootButton.addEventListener("click", () => loadDirectories("/"));
      dirBreadcrumbs.append(rootButton);

      let nextPath = "";
      for (const part of path.split("/").filter(Boolean)) {
        nextPath += "/" + part;
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = part;
        button.title = nextPath;
        button.addEventListener("click", () => loadDirectories(button.title));
        dirBreadcrumbs.append(button);
      }
    }

    function renderDirectories(payload) {
      selectedDir = payload.path;
      dirCurrent.textContent = payload.path;
      renderBreadcrumbs(payload.path);
      dirList.textContent = "";

      if (payload.parent) {
        const parent = document.createElement("button");
        parent.type = "button";
        parent.textContent = "../";
        parent.addEventListener("click", () => loadDirectories(payload.parent));
        dirList.append(parent);
      }

      for (const child of payload.children || []) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = child.name + "/";
        button.title = child.path;
        button.addEventListener("click", () => loadDirectories(child.path));
        dirList.append(button);
      }

      if (!dirList.childElementCount) {
        const empty = document.createElement("div");
        empty.className = "dir-empty";
        empty.textContent = "没有子目录";
        dirList.append(empty);
      }
    }

    async function loadDirectories(path) {
      dirList.textContent = "";
      const loading = document.createElement("div");
      loading.className = "dir-empty";
      loading.textContent = "读取中...";
      dirList.append(loading);

      try {
        renderDirectories(await api("/dirs", { path }));
      } catch (error) {
        dirCurrent.textContent = error.message;
        dirList.textContent = "";
      }
    }

    function terminalIsAtBottom() {
      return terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight <= 2;
    }

    function scrollTerminalToBottom() {
      terminalProgrammaticScroll = true;
      terminal.scrollTop = terminal.scrollHeight;
      requestAnimationFrame(() => {
        terminalProgrammaticScroll = false;
      });
    }

    function renderTerminalSnapshot(snapshot, { follow = false } = {}) {
      renderTerminalText(snapshot || "");
      if (follow) scrollTerminalToBottom();
    }

    function resumeTerminalAutoFollow() {
      terminalAutoFollow = true;
      if (terminalPendingSnapshot !== null) {
        const snapshot = terminalPendingSnapshot;
        terminalPendingSnapshot = null;
        renderTerminalSnapshot(snapshot, { follow: true });
        return;
      }
      scrollTerminalToBottom();
    }

    function updateTerminalSnapshot(snapshot, { forceFollow = false } = {}) {
      const shouldFollow = forceFollow || terminalAutoFollow || terminalIsAtBottom();
      if (!shouldFollow) {
        terminalPendingSnapshot = snapshot || "";
        return;
      }

      terminalAutoFollow = true;
      terminalPendingSnapshot = null;
      renderTerminalSnapshot(snapshot, { follow: true });
    }

    async function refresh({ forceFollow = true } = {}) {
      const res = await fetch("/snapshot?token=" + encodeURIComponent(token()));
      const payload = await res.json();
      if (!res.ok || payload.ok === false) throw new Error(payload.error || res.statusText);
      maybePlayStableSnapshotAlert(payload);
      updateTerminalSnapshot(payload.snapshot, { forceFollow });
    }

    async function refreshOutputView() {
      const startedAt = Date.now();
      try {
        refreshOutput.disabled = true;
        refreshOutput.classList.add("refreshing");
        showToast("刷新中");
        await refresh();
      } catch (error) {
        renderTerminalSnapshot(error.message, { follow: true });
      } finally {
        const remaining = 1000 - (Date.now() - startedAt);
        if (remaining > 0) {
          await new Promise((resolve) => setTimeout(resolve, remaining));
        }
        refreshOutput.disabled = false;
        refreshOutput.classList.remove("refreshing");
        hideToast();
      }
    }

    async function connect() {
      if (!token()) {
        setStatus("missing token", false);
        return;
      }
      try {
        await api("/start");
      } catch (error) {
        renderTerminalSnapshot(error.message, { follow: true });
      }
      if (source) source.close();
      source = new EventSource("/events?token=" + encodeURIComponent(token()));
      source.addEventListener("open", () => setStatus("connected", true));
      source.addEventListener("error", () => setStatus("reconnecting", false));
      source.addEventListener("snapshot", (event) => {
        const payload = JSON.parse(event.data);
        updateTerminalSnapshot(payload.snapshot);
      });
      source.addEventListener("status", (event) => {
        const payload = JSON.parse(event.data);
        setStatus(payload.running ? "running" : "idle", payload.running);
        displayedWorkdir = payload.workdir || "";
        workdir.textContent = displayedWorkdir || "未知";
        maybeShowBatteryWarning(payload.battery);
        maybePlayStableSnapshotAlert(payload);
      });
    }

    toolSettings.addEventListener("click", () => {
      toolMenu.hidden = !toolMenu.hidden;
      toolSettings.classList.toggle("is-active", !toolMenu.hidden);
      if (!toolMenu.hidden) {
        closeDirPicker();
        hideSentHistoryPanel();
        toolNote.textContent = "";
        renderTools();
      }
    });

    toolAddOpen.addEventListener("click", openToolModal);
    toolCancel.addEventListener("click", closeToolModal);
    toolClose.addEventListener("click", closeToolModal);
    toolModal.addEventListener("click", (event) => {
      if (event.target === toolModal) closeToolModal();
    });

    appAlertClose.addEventListener("click", closeAlert);
    appAlertOk.addEventListener("click", closeAlert);
    appAlertModal.addEventListener("click", (event) => {
      if (event.target === appAlertModal) closeAlert();
    });

    deleteToolClose.addEventListener("click", closeDeleteToolModal);
    deleteToolCancel.addEventListener("click", closeDeleteToolModal);
    deleteToolModal.addEventListener("click", (event) => {
      if (event.target === deleteToolModal) closeDeleteToolModal();
    });
    deleteToolConfirm.addEventListener("click", async () => {
      if (!pendingDeleteToolId) return;
      deleteToolConfirm.disabled = true;
      await deleteTool(pendingDeleteToolId);
      deleteToolConfirm.disabled = false;
    });

    toolForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = toolName.value.trim();
      const command = toolCommand.value.trim();
      if (!name || !command) {
        toolModalNote.textContent = "名字和指令都要填写";
        return;
      }

      try {
        const id = window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : String(Date.now() + Math.random());
        await saveTools(customTools.concat([{ id, name, command }]));
        closeToolModal();
        showToast("已新增：" + name);
      } catch (error) {
        toolModalNote.textContent = error.message;
      }
    });

    goDirButton.addEventListener("click", async () => {
      dirPicker.hidden = !dirPicker.hidden;
      goDirButton.classList.toggle("is-active", !dirPicker.hidden);
      if (!dirPicker.hidden) {
        closeToolMenu();
        hideSentHistoryPanel();
        try {
          const payload = await api("/status", {});
          displayedWorkdir = payload.workdir || displayedWorkdir;
          workdir.textContent = displayedWorkdir || "未知";
        } catch {
          // Keep the last known directory if status refresh fails.
        }
        await loadDirectories(displayedWorkdir || selectedDir || ".");
      }
    });

    dirClose.addEventListener("click", () => {
      closeDirPicker();
    });

    dirApply.addEventListener("click", async () => {
      try {
        dirApply.disabled = true;
        const payload = await api("/cd", { path: selectedDir });
        displayedWorkdir = payload.workdir || selectedDir;
        workdir.textContent = displayedWorkdir || "未知";
        closeDirPicker();
        await refresh();
      } catch (error) {
        dirCurrent.textContent = error.message;
      } finally {
        dirApply.disabled = false;
      }
    });

    pickImage.addEventListener("click", () => imageInput.click());

    sentHistoryOpen.addEventListener("click", toggleSentHistoryPanel);

    refreshOutput.addEventListener("click", refreshOutputView);

    window.addEventListener("pointerdown", unlockAlertSound, { passive: true });
    window.addEventListener("keydown", unlockAlertSound);

    terminal.addEventListener("scroll", () => {
      if (terminalProgrammaticScroll) return;
      if (terminalIsAtBottom()) {
        resumeTerminalAutoFollow();
        return;
      }

      terminalAutoFollow = false;
    }, { passive: true });

    terminal.addEventListener("touchstart", (event) => {
      if (event.touches.length !== 1) return;
      terminalTouchActive = true;
      terminalTouchStartY = event.touches[0].clientY;
      terminalPullRefreshReady = false;
    }, { passive: true });

    terminal.addEventListener("touchmove", (event) => {
      if (event.touches.length !== 1) return;
      const pulledUp = terminalTouchStartY - event.touches[0].clientY;
      terminalPullRefreshReady = pulledUp >= terminalPullRefreshThreshold && terminalIsAtBottom();
    }, { passive: true });

    terminal.addEventListener("touchend", () => {
      if (terminalPullRefreshReady && terminalIsAtBottom()) {
        refreshOutputView();
      } else if (terminalIsAtBottom()) {
        resumeTerminalAutoFollow();
      } else {
        terminalAutoFollow = false;
      }
      terminalTouchActive = false;
      terminalPullRefreshReady = false;
    }, { passive: true });

    terminal.addEventListener("touchcancel", () => {
      terminalTouchActive = false;
      terminalPullRefreshReady = false;
      if (!terminalIsAtBottom()) terminalAutoFollow = false;
    });

    imageInput.addEventListener("change", () => {
      const files = [...imageInput.files];
      const accepted = [];

      for (const file of files) {
        const type = file.type || inferImageType(file.name);
        if (!type.startsWith("image/")) {
          showToast("只能选择图片文件");
          continue;
        }
        if (file.size > maxImageBytes) {
          showToast(file.name + " 超过 " + formatBytes(maxImageBytes));
          continue;
        }
        if (selectedImages.length + accepted.length >= maxImageCount) {
          showToast("最多选择 " + maxImageCount + " 张图片");
          break;
        }
        accepted.push({
          id: window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : String(Date.now() + Math.random()),
          file,
          url: URL.createObjectURL(file),
        });
      }

      selectedImages = selectedImages.concat(accepted);
      imageInput.value = "";
      if (accepted.length > 0) setComposerNote("");
      renderImages();
    });

    sendButton.addEventListener("click", async () => {
      try {
        sendButton.disabled = true;
        const text = message.value;
        const images = await imagePayloads();
        armStableSnapshotAlert();
        const payload = await api("/send", { text, images, recordSent: true });
        sentHistoryItems = Array.isArray(payload.sentHistory) ? payload.sentHistory : sentHistoryItems;
        message.value = "";
        hideHistorySuggestions();
        hideSentHistoryPanel();
        await loadHistory();
        clearImages();
        await refresh();
      } catch (error) {
        cancelStableSnapshotAlert();
        renderTerminalSnapshot(error.message, { follow: true });
      } finally {
        sendButton.disabled = false;
      }
    });

    for (const button of document.querySelectorAll("[data-key]")) {
      button.addEventListener("click", async () => {
        try {
          await api("/key", { key: button.dataset.key });
          await refresh();
        } catch (error) {
          renderTerminalSnapshot(error.message, { follow: true });
        }
      });
    }

    message.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        document.querySelector("#send").click();
        return;
      }
      if (event.key === "Escape") {
        hideHistorySuggestions();
        hideSentHistoryPanel();
      }
    });

    message.addEventListener("input", () => {
      hideSentHistoryPanel();
      renderHistorySuggestions();
    });
    message.addEventListener("focus", () => {
      app.classList.add("composer-focused");
      composer.classList.add("composer-focused");
      loadHistory();
    });
    message.addEventListener("blur", () => {
      setTimeout(() => {
        hideHistorySuggestions();
        app.classList.remove("composer-focused");
        composer.classList.remove("composer-focused");
      }, 120);
    });

    renderTools();
    loadTools();
    loadHistory();
    connect();
  </script>
</body>
</html>`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/") {
      const html = page();
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(html),
        "cache-control": "no-store",
      });
      res.end(html);
      return;
    }

    if (url.pathname !== "/" && !isAuthed(req, url)) {
      json(res, 401, { ok: false, error: "Unauthorized." });
      return;
    }

    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      clients.add(res);
      const snapshot = await capturePane();
      const snapshotStability = observeSnapshot(snapshot);
      sendSSE(res, "status", await statusPayload(snapshotStability));
      sendSSE(res, "snapshot", { snapshot, ...snapshotStability });
      req.on("close", () => clients.delete(res));
      return;
    }

    if (req.method === "GET" && url.pathname === "/status") {
      json(res, 200, { ok: true, ...(await statusPayload()) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/snapshot") {
      const snapshot = await capturePane();
      const snapshotStability = observeSnapshot(snapshot);
      json(res, 200, { ok: true, snapshot, ...snapshotStability });
      return;
    }

    if (req.method === "POST" && url.pathname === "/start") {
      const result = await startSession();
      json(res, result.ok ? 200 : 500, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/send") {
      const body = await readBody(req, MAX_SEND_BODY_BYTES);
      const result = await sendMessage(body.text, body.images);
      if (result.ok) addHistory(body.text);
      if (result.ok && body.recordSent === true) {
        result.sentHistory = addSentHistory(body.text);
      }
      json(res, result.ok ? 200 : 400, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/history") {
      json(res, 200, { ok: true, history: readHistory() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/sent-history") {
      json(res, 200, { ok: true, history: readSentHistory() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/dirs") {
      const body = await readBody(req);
      json(res, 200, listDirectories(body.path));
      return;
    }

    if (req.method === "POST" && url.pathname === "/cd") {
      const body = await readBody(req);
      const result = await changeDirectory(body.path);
      json(res, result.ok ? 200 : 400, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/tools") {
      json(res, 200, { ok: true, tools: readTools() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/tools/save") {
      const body = await readBody(req);
      json(res, 200, { ok: true, tools: writeTools(body.tools) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/key") {
      const body = await readBody(req);
      const result = await sendKey(body.key);
      json(res, result.ok ? 200 : 400, result);
      return;
    }

    json(res, 404, { ok: false, error: "Not found." });
  } catch (error) {
    json(res, 500, { ok: false, error: error.message || String(error) });
  }
});

setInterval(async () => {
  if (clients.size === 0) return;
  const snapshot = await capturePane();
  const snapshotStability = observeSnapshot(snapshot);
  const status = await statusPayload(snapshotStability);
  broadcast("status", status);
  if (snapshot !== lastSnapshot) {
    lastSnapshot = snapshot;
    broadcast("snapshot", { snapshot, ...snapshotStability });
  }
}, 1200).unref();

async function printStartup(port, fallbackFrom) {
  activePort = port;
  const addresses = await probeLANAddresses(port);
  const reachableUrls = addresses
    .filter((item) => item.reachable)
    .map((item) => `http://${item.address}:${port}`);
  const unverifiedUrls = addresses
    .filter((item) => !item.reachable)
    .map((item) => `http://${item.address}:${port}`);

  console.log("");
  console.log("Phone CLI Bridge 已启动。");
  if (fallbackFrom !== null) {
    console.log(`端口 ${fallbackFrom} 被占用，已自动改用端口 ${port}。`);
  }
  console.log("");
  if (reachableUrls.length > 0) {
    console.log("1. 在手机浏览器打开下面任意一个已自检可达的地址：");
    for (const url of reachableUrls) {
      console.log(`   ${url}?token=${TOKEN}`);
    }
    if (unverifiedUrls.length > 0) {
      console.log("");
      console.log("   下面地址本机自检未通过，手机连不上时先不要用：");
      for (const url of unverifiedUrls) {
        console.log(`   ${url}?token=${TOKEN}`);
      }
    }
  } else if (unverifiedUrls.length > 0) {
    console.log("1. 检测到下面地址，但本机自检未通过；如果手机连不上，请换网络或用 Tailscale/WireGuard 等内网地址：");
    for (const url of unverifiedUrls) {
      console.log(`   ${url}?token=${TOKEN}`);
    }
  } else {
    console.log("1. 没有检测到可供手机访问的局域网 IP。");
    console.log("   请确认 Mac 和手机在同一个 Wi-Fi，或用 Tailscale/WireGuard 等内网地址访问。");
  }
  console.log("");
  console.log(`   本机调试地址： http://localhost:${port}?token=${TOKEN}`);
  console.log("   注意：手机浏览器不能使用 localhost，手机上的 localhost 指向手机自己。");
  console.log("");
  console.log("2. 如果 CLI 要求输入 Mac 密码，请在 iTerm2 里处理：");
  console.log(`   tmux attach -t ${SESSION}`);
  console.log("");
  console.log("3. 当前目标：");
  console.log(`   session: ${SESSION}`);
  console.log(`   command: ${CLI_COMMAND}`);
  console.log(`   workdir: ${WORKDIR}`);
  console.log("");
  console.log("4. 停止方式：");
  console.log("   停止 Bridge：在这个终端按 Ctrl-C");
  console.log("   停止所有相关进程：phone-bridge -k");
  console.log(`   停止 tmux 会话：tmux kill-session -t ${SESSION}`);
  console.log("");
  console.log("使用手机页面时，请保持这个终端窗口打开。");
}

function listen(port, attemptsLeft, firstPort = port) {
  const onListening = () => {
    server.off("error", onError);
    printStartup(port, firstPort === port ? null : firstPort).catch((error) => {
      console.error(`启动信息生成失败：${error.message || error}`);
    });
  };

  const onError = (error) => {
    server.off("listening", onListening);
    if (error.code === "EADDRINUSE" && attemptsLeft > 1) {
      const nextPort = port + 1;
      console.log(`端口 ${port} 已被占用，正在尝试端口 ${nextPort}...`);
      listen(nextPort, attemptsLeft - 1, firstPort);
      return;
    }

    if (error.code === "EADDRINUSE" && PORT_WAS_SPECIFIED) {
      console.error(`指定端口 ${port} 已被占用，启动退出。`);
      console.error("请关闭占用该端口的进程，或用 -p/--port 指定其他端口，例如：");
      console.error("phone-bridge -r -p 8766");
    } else if (error.code === "EADDRINUSE") {
      console.error(`端口 ${port} 已被占用，且没有可自动尝试的备用端口。`);
      console.error("可以用 -p/--port 换一个起始端口，例如：");
      console.error("phone-bridge -r -p 8766");
    } else if (error.code === "EACCES" || error.code === "EPERM") {
      console.error(`没有权限监听 ${HOST}:${port}。`);
      console.error("可以用 -p/--port 换一个较高端口，例如：");
      console.error("phone-bridge -r -p 8766");
    } else {
      console.error(`Bridge 启动失败：${error.message || error}`);
    }
    process.exit(1);
  };

  server.once("listening", onListening);
  server.once("error", onError);
  server.listen(port, HOST);
}

seedHistoryIfEmpty();
listen(PORT, PORT_ATTEMPTS);
