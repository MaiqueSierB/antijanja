const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const http = require("node:http");
const dotenv = require("dotenv");
const express = require("express");
const { Server } = require("socket.io");
const { Client, GatewayIntentBits, MessageFlags, REST, Routes, SlashCommandBuilder } = require("discord.js");

// Segredos: .env local ou, na Hostinger, um arquivo fora da public_html que não some nos deploys.
dotenv.config();
const SECRETS_FILE = process.env.SECRETS_FILE || "/home/u243267678/domains/mrbnexus.com.br/.antijanja.env";
if (fs.existsSync(SECRETS_FILE)) dotenv.config({ path: SECRETS_FILE });
else console.warn(`Arquivo de segredos não encontrado: ${SECRETS_FILE}`);

for (const name of ["DISCORD_TOKEN", "DISCORD_CLIENT_ID", "PUBLIC_URL"]) {
  if (!process.env[name]) {
    console.error(`Variável obrigatória ausente: ${name}`);
    process.exit(1);
  }
}

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.PUBLIC_URL.replace(/\/$/, "");
const SESSION_TTL_MS = Math.max(5, Number(process.env.SESSION_TTL_MINUTES || 240)) * 60_000;
const MAX_VIEWERS = Math.max(1, Number(process.env.MAX_VIEWERS_PER_SESSION || 6));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
// Chave da API interna (usada pelo bot do WhatsApp). Gerada aqui; o Zap lê o mesmo arquivo.
const API_KEY_FILE = process.env.API_KEY_FILE || "/home/u243267678/domains/mrbnexus.com.br/zap-data/antijanja.key";

// ---------- Salas ----------
const sessions = new Map();       // id -> sala
const ownerSessions = new Map();  // id do dono no Discord -> id da sala
const randomToken = () => crypto.randomBytes(32).toString("base64url");
const roomLink = session => `${PUBLIC_URL}/room/${session.id}?key=${session.key}`;

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createSession(ownerId) {
  const session = {
    id: crypto.randomBytes(12).toString("hex"),
    ownerId,
    key: randomToken(),
    publishers: new Map(),  // socket id -> { participantId }
    viewers: new Map(),     // socket id -> { participantId }
    expiryTimer: null
  };
  session.expiryTimer = setTimeout(() => stopSession(session.id, "A sala expirou por tempo limite."), SESSION_TTL_MS);
  session.expiryTimer.unref?.();
  sessions.set(session.id, session);
  ownerSessions.set(ownerId, session.id);
  return session;
}

function sessionOf(ownerId) {
  const id = ownerSessions.get(ownerId);
  return (id && sessions.get(id)) || null;
}

function stopSession(id, reason) {
  const session = sessions.get(id);
  if (!session) return false;
  clearTimeout(session.expiryTimer);
  io.to(`session:${id}`).emit("stream-ended", { message: reason });
  io.in(`session:${id}`).disconnectSockets(true);
  sessions.delete(id);
  if (ownerSessions.get(session.ownerId) === id) ownerSessions.delete(session.ownerId);
  return true;
}

// ---------- Web ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 64 * 1024, pingInterval: 25_000, pingTimeout: 20_000 });

app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), display-capture=(self)");
  next();
});
app.use(express.static(PUBLIC_DIR, { maxAge: process.env.NODE_ENV === "production" ? "1h" : 0 }));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/room/:id", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "room.html")));

let apiKey = null;
try {
  fs.mkdirSync(path.dirname(API_KEY_FILE), { recursive: true });
  if (!fs.existsSync(API_KEY_FILE)) fs.writeFileSync(API_KEY_FILE, randomToken(), { mode: 0o600 });
  apiKey = fs.readFileSync(API_KEY_FILE, "utf8").trim();
} catch (error) {
  console.warn("API interna desativada (não consegui criar/ler a chave):", error.message);
}

function autorizado(req, res, next) {
  if (!apiKey || !safeEqual(req.get("x-api-key") || "", apiKey)) return res.status(401).json({ erro: "não autorizado" });
  next();
}

app.post("/api/salas", express.json({ limit: "2kb" }), autorizado, (req, res) => {
  const ownerId = String(req.body?.ownerId || "");
  if (!/^\d{5,25}$/.test(ownerId)) return res.status(400).json({ erro: "ownerId inválido" });
  const existing = sessionOf(ownerId);
  const session = existing || createSession(ownerId);
  res.json({ link: roomLink(session), nova: !existing, expiraMin: Math.round(SESSION_TTL_MS / 60_000) });
});

app.delete("/api/salas/:ownerId", autorizado, (req, res) => {
  const session = sessionOf(req.params.ownerId);
  res.json({ encerrada: Boolean(session && stopSession(session.id, "O criador encerrou a sala.")) });
});

// ---------- Sinalização WebRTC (o vídeo vai direto entre os navegadores) ----------
io.use((socket, next) => {
  const { sessionId, key, role, participantId } = socket.handshake.auth || {};
  const session = sessions.get(sessionId);
  if (!session) return next(new Error("Sala inexistente ou encerrada."));
  const ok = (role === "publisher" || role === "room-viewer") && safeEqual(key, session.key) &&
    typeof participantId === "string" && participantId.length >= 8 && participantId.length <= 80;
  if (!ok) return next(new Error("Link inválido ou sem autorização."));
  socket.data = { sessionId, role, participantId };
  next();
});

io.on("connection", socket => {
  const { sessionId, role, participantId } = socket.data;
  const session = sessions.get(sessionId);
  if (!session) return socket.disconnect(true);
  const room = `session:${sessionId}`;
  const isPublisher = role === "publisher";
  const others = map => [...map.entries()].filter(([, info]) => info.participantId !== participantId);
  socket.join(room);

  if (isPublisher) {
    // Uma transmissão por participante: derruba a anterior da mesma pessoa.
    for (const [id, info] of session.publishers) {
      if (info.participantId === participantId) io.sockets.sockets.get(id)?.disconnect(true);
    }
    session.publishers.set(socket.id, { participantId });
    socket.emit("room-viewers", others(session.viewers).map(([viewerId]) => ({ viewerId })));
    socket.emit("room-publishers", others(session.publishers).map(([publisherId]) => ({ publisherId })));
    for (const [viewerId] of others(session.viewers)) io.to(viewerId).emit("publisher-joined", { publisherId: socket.id });
    socket.to(room).emit("room-count", { publishers: session.publishers.size });
  } else {
    if (session.viewers.size >= MAX_VIEWERS) {
      socket.emit("room-full", { message: `A sala atingiu o limite de ${MAX_VIEWERS} espectadores conectados.` });
      return socket.disconnect(true);
    }
    session.viewers.set(socket.id, { participantId });
    socket.emit("room-publishers", others(session.publishers).map(([publisherId]) => ({ publisherId })));
    for (const [publisherId] of others(session.publishers)) io.to(publisherId).emit("viewer-joined", { viewerId: socket.id });
    socket.emit("room-count", { publishers: session.publishers.size });
  }

  socket.on("request-stream", ({ publisherId } = {}) => {
    if (isPublisher || typeof publisherId !== "string") return;
    const publisher = session.publishers.get(publisherId);
    if (publisher && publisher.participantId !== participantId) io.to(publisherId).emit("viewer-request", { viewerId: socket.id });
  });

  socket.on("signal", payload => {
    if (!payload || typeof payload.to !== "string" || !payload.data || typeof payload.data !== "object") return;
    const target = io.sockets.sockets.get(payload.to);
    if (!target || target.data.sessionId !== sessionId || target.data.participantId === participantId) return;
    if (!(isPublisher ? session.viewers : session.publishers).has(target.id)) return;
    target.emit("signal", { from: socket.id, data: payload.data });
  });

  socket.on("disconnect", () => {
    if (isPublisher) {
      session.publishers.delete(socket.id);
      for (const [viewerId] of others(session.viewers)) io.to(viewerId).emit("publisher-left", { publisherId: socket.id });
    } else {
      session.viewers.delete(socket.id);
      for (const [publisherId] of others(session.publishers)) io.to(publisherId).emit("viewer-left", { viewerId: socket.id });
    }
    io.to(room).emit("room-count", { publishers: session.publishers.size });
  });
});

// ---------- Discord ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Comandos avulsos de resenha (sorteio, enquete, meme, Print, lembretes, jogos grátis). Ficam em módulos
// à parte; se falharem ao carregar, a transmissão continua funcionando.
let resenha = null;
const carregarResenha = import("./resenha/comandos.mjs")
  .then(m => { resenha = m; })
  .catch(error => console.error("Comandos de resenha desligados:", error.message));
const efemero = content => ({ content, flags: MessageFlags.Ephemeral });

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName("transmitir").setDescription("Cria uma sala pública onde todos com o link podem assistir e transmitir."),
    new SlashCommandBuilder().setName("parar").setDescription("Encerra sua transmissão ativa.")
  ].map(c => c.toJSON());
  await carregarResenha;
  if (resenha) commands.push(...resenha.definicoes);
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  const route = process.env.DISCORD_GUILD_ID
    ? Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID)
    : Routes.applicationCommands(process.env.DISCORD_CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log(`Comandos registrados (${commands.length}).`);
}

client.once("clientReady", () => {
  console.log(`Bot conectado como ${client.user.tag}`);
  resenha?.iniciar(client);
});

client.on("interactionCreate", async interaction => {
  try {
    if (resenha && await resenha.tratar(interaction)) return;
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === "transmitir") {
      const existing = sessionOf(interaction.user.id);
      if (existing) {
        return interaction.reply(efemero(`Você já tem uma sala criada. Compartilhe este link com os participantes: ${roomLink(existing)}\n\n` +
          "Qualquer pessoa com o link pode assistir e transmitir. Use `/parar` para encerrar a sala."));
      }
      const session = createSession(interaction.user.id);
      return interaction.reply(efemero(
        "**Sua sala pública do Anti Janja está pronta!**\n\n" +
        "Compartilhe este único link. Qualquer pessoa com ele poderá assistir e iniciar sua própria transmissão.\n\n" +
        `🔗 **Entrar na sala:** ${roomLink(session)}\n\n` +
        "Todos os participantes poderão transmitir. Use `/parar` para encerrar a sala inteira.\n" +
        `A sala expira em ${Math.round(SESSION_TTL_MS / 60_000)} minutos.`));
    }
    if (interaction.commandName === "parar") {
      const session = sessionOf(interaction.user.id);
      if (!session) return interaction.reply(efemero("Você não tem uma transmissão ativa."));
      stopSession(session.id, "O transmissor encerrou a sessão.");
      return interaction.reply(efemero("Transmissão encerrada. Os espectadores foram desconectados."));
    }
  } catch (error) {
    console.error("Falha ao processar comando:", error);
    const response = efemero("Não foi possível concluir o comando. Tente novamente.");
    if (interaction.replied || interaction.deferred) await interaction.followUp(response).catch(() => {});
    else await interaction.reply(response).catch(() => {});
  }
});

// ---------- Início e encerramento ----------
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Encerrando servidor (${signal})...`);
  for (const id of sessions.keys()) stopSession(id, "Servidor desligado.");
  io.close();
  client.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// O site sobe primeiro; se o bot falhar, a página continua no ar e o erro fica no log.
server.listen(PORT, () => console.log(`Servidor disponível na porta ${PORT}`));
registerCommands()
  .then(() => client.login(process.env.DISCORD_TOKEN))
  .catch(error => console.error("Falha ao conectar o bot no Discord:", error));
