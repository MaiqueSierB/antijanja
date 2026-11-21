require("dotenv").config();

const crypto = require("node:crypto");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { Server } = require("socket.io");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");

const REQUIRED_ENV = ["DISCORD_TOKEN", "DISCORD_CLIENT_ID", "PUBLIC_URL"];
for (const name of REQUIRED_ENV) {
  if (!process.env[name]) {
    console.error(`Variável obrigatória ausente no .env: ${name}`);
    process.exit(1);
  }
}

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.PUBLIC_URL.replace(/\/$/, "");
const SESSION_TTL_MS = Math.max(5, Number(process.env.SESSION_TTL_MINUTES || 240)) * 60_000;
const MAX_VIEWERS = Math.max(1, Number(process.env.MAX_VIEWERS_PER_SESSION || 6));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 64 * 1024,
  pingInterval: 25_000,
  pingTimeout: 20_000
});

app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), display-capture=(self)");
  next();
});
app.use(express.static(PUBLIC_DIR, {
  etag: true,
  maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
  fallthrough: true
}));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/host/:id", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "host.html")));
app.get("/watch/:id", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "watch.html")));
app.get("/room/:id", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "room.html")));

const sessions = new Map();
const ownerSessions = new Map();
const randomToken = () => crypto.randomBytes(32).toString("base64url");

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sessionLinks(session) {
  const room = `${PUBLIC_URL}/room/${session.id}?key=${session.viewerKey}`;
  return { room, host: `${PUBLIC_URL}/host/${session.id}?key=${session.hostKey}&viewer=${session.viewerKey}`, viewer: `${PUBLIC_URL}/watch/${session.id}?key=${session.viewerKey}` };
}

function stopSession(id, reason = "A transmissão foi encerrada.") {
  const session = sessions.get(id);
  if (!session) return false;
  clearTimeout(session.expiryTimer);
  io.to(`session:${id}`).emit("stream-ended", { message: reason });
  io.in(`session:${id}`).disconnectSockets(true);
  sessions.delete(id);
  if (ownerSessions.get(session.ownerId) === id) ownerSessions.delete(session.ownerId);
  return true;
}

function createSession(interaction) {
  const session = {
    id: crypto.randomBytes(12).toString("hex"),
    ownerId: interaction.user.id,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    hostKey: randomToken(),
    viewerKey: randomToken(),
    hostSocketId: null,
    viewerSocketIds: new Set(),
    publishers: new Map(),
    roomViewers: new Map(),
    createdAt: Date.now(),
    expiryTimer: null
  };
  session.expiryTimer = setTimeout(
    () => stopSession(session.id, "A sala expirou por tempo limite."),
    SESSION_TTL_MS
  );
  session.expiryTimer.unref?.();
  sessions.set(session.id, session);
  ownerSessions.set(session.ownerId, session.id);
  return session;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const commands = [
  new SlashCommandBuilder()
    .setName("transmitir")
    .setDescription("Cria uma sala pública onde todos com o link podem assistir e transmitir."),
  new SlashCommandBuilder()
    .setName("parar")
    .setDescription("Encerra sua transmissão ativa.")
];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  const body = commands.map(command => command.toJSON());
  const route = process.env.DISCORD_GUILD_ID
    ? Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID)
    : Routes.applicationCommands(process.env.DISCORD_CLIENT_ID);
  await rest.put(route, { body });
  console.log(process.env.DISCORD_GUILD_ID
    ? "Comandos registrados no servidor configurado."
    : "Comandos globais registrados (podem demorar para aparecer).");
}

client.once("clientReady", () => {
  console.log(`Bot conectado como ${client.user.tag}`);
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "transmitir") {
      const existingId = ownerSessions.get(interaction.user.id);
      const existing = existingId && sessions.get(existingId);
      if (existing) {
        const links = sessionLinks(existing);
        return interaction.reply({
          ephemeral: true,
          content: `Você já tem uma sala criada. Compartilhe este link com os participantes: ${links.room}\n\nQualquer pessoa com o link pode assistir e transmitir. Use \`/parar\` para encerrar a sala.`
        });
      }

      const session = createSession(interaction);
      const links = sessionLinks(session);
      return interaction.reply({
        ephemeral: true,
        content:
          `**Sua sala pública do Anti Janja está pronta!**\n\n` +
          `Compartilhe este único link. Qualquer pessoa com ele poderá assistir e iniciar sua própria transmissão.\n\n` +
          `🔗 **Entrar na sala:** ${links.room}\n\n` +
          `Todos os participantes poderão transmitir. Use \`/parar\` para encerrar a sala inteira.\n` +
          `A sala expira em ${Math.round(SESSION_TTL_MS / 60_000)} minutos.`
      });
    }

    if (interaction.commandName === "parar") {
      const sessionId = ownerSessions.get(interaction.user.id);
      if (!sessionId || !sessions.has(sessionId)) {
        return interaction.reply({ ephemeral: true, content: "Você não tem uma transmissão ativa." });
      }
      stopSession(sessionId, "O transmissor encerrou a sessão.");
      return interaction.reply({ ephemeral: true, content: "Transmissão encerrada. Os espectadores foram desconectados." });
    }
  } catch (error) {
    console.error("Falha ao processar comando:", error);
    const response = { ephemeral: true, content: "Não foi possível concluir o comando. Tente novamente." };
    if (interaction.replied || interaction.deferred) await interaction.followUp(response).catch(() => {});
    else await interaction.reply(response).catch(() => {});
  }
});

io.use((socket, next) => {
  const { sessionId, key, role, participantId } = socket.handshake.auth || {};
  const session = sessions.get(sessionId);
  if (!session) return next(new Error("Sala inexistente ou encerrada."));

  const roomRole = role === "publisher" || role === "room-viewer";
  const authorized = roomRole
    ? safeEqual(key, session.viewerKey) && typeof participantId === "string" && participantId.length >= 8 && participantId.length <= 80
    : (role === "host" && safeEqual(key, session.hostKey)) || (role === "viewer" && safeEqual(key, session.viewerKey));
  if (!authorized) return next(new Error("Link inválido ou sem autorização."));

  socket.data.sessionId = sessionId;
  socket.data.role = role;
  if (roomRole) socket.data.participantId = participantId;
  return next();
});

io.on("connection", socket => {
  const { sessionId, role } = socket.data;
  const session = sessions.get(sessionId);
  if (!session) return socket.disconnect(true);
  const room = `session:${sessionId}`;
  socket.join(room);

  // Modo sala pública: cada participante pode publicar uma transmissão e assistir às demais.
  if (role === "publisher" || role === "room-viewer") {
    const participantId = socket.data.participantId;
    const isPublisher = role === "publisher";

    if (isPublisher) {
      for (const [publisherId, info] of session.publishers) {
        if (info.participantId === participantId) {
          io.sockets.sockets.get(publisherId)?.disconnect(true);
        }
      }
      session.publishers.set(socket.id, { participantId, startedAt: Date.now() });
      socket.emit("room-viewers", [...session.roomViewers.entries()]
        .filter(([, info]) => info.participantId !== participantId)
        .map(([viewerId]) => ({ viewerId })));
      socket.emit("room-publishers", [...session.publishers.entries()]
        .filter(([, info]) => info.participantId !== participantId)
        .map(([id]) => ({ publisherId: id })));
      for (const [viewerId, info] of session.roomViewers) {
        if (info.participantId !== participantId) io.to(viewerId).emit("publisher-joined", { publisherId: socket.id });
      }
      socket.to(room).emit("room-count", { publishers: session.publishers.size });
    } else {
      if (session.roomViewers.size >= MAX_VIEWERS) {
        socket.emit("room-full", { message: `A sala atingiu o limite de ${MAX_VIEWERS} espectadores conectados.` });
        return socket.disconnect(true);
      }
      session.roomViewers.set(socket.id, { participantId });
      socket.emit("room-publishers", [...session.publishers.entries()]
        .filter(([, info]) => info.participantId !== participantId)
        .map(([publisherId]) => ({ publisherId })));
      for (const [publisherId, info] of session.publishers) {
        if (info.participantId !== participantId) io.to(publisherId).emit("viewer-joined", { viewerId: socket.id });
      }
      socket.emit("room-count", { publishers: session.publishers.size });
    }

    socket.on("request-stream", ({ publisherId } = {}) => {
      if (isPublisher || typeof publisherId !== "string") return;
      const publisher = session.publishers.get(publisherId);
      if (publisher && publisher.participantId !== participantId) {
        io.to(publisherId).emit("viewer-request", { viewerId: socket.id });
      }
    });

    socket.on("signal", payload => {
      if (!payload || typeof payload.to !== "string" || !payload.data || typeof payload.data !== "object") return;
      const target = io.sockets.sockets.get(payload.to);
      if (!target || target.data.sessionId !== sessionId || target.data.participantId === participantId) return;
      if (isPublisher) {
        if (!session.roomViewers.has(target.id)) return;
      } else {
        if (!session.publishers.has(target.id)) return;
      }
      target.emit("signal", { from: socket.id, data: payload.data });
    });

    socket.on("disconnect", () => {
      if (isPublisher) {
        session.publishers.delete(socket.id);
        for (const [viewerId, info] of session.roomViewers) {
          if (info.participantId !== participantId) io.to(viewerId).emit("publisher-left", { publisherId: socket.id });
        }
      } else {
        session.roomViewers.delete(socket.id);
        for (const [publisherId, info] of session.publishers) {
          if (info.participantId !== participantId) io.to(publisherId).emit("viewer-left", { viewerId: socket.id });
        }
      }
      io.to(room).emit("room-count", { publishers: session.publishers.size });
    });
    return;
  }

  // Compatibilidade com os links privados da versão anterior.
  if (role === "host") {
    if (session.hostSocketId && session.hostSocketId !== socket.id) {
      io.sockets.sockets.get(session.hostSocketId)?.disconnect(true);
    }
    session.hostSocketId = socket.id;
    socket.emit("host-connected");
    socket.on("host-ready", () => socket.to(room).emit("host-ready"));
  } else {
    if (session.viewerSocketIds.size >= MAX_VIEWERS) {
      socket.emit("room-full", { message: `Esta sala atingiu o limite de ${MAX_VIEWERS} espectadores.` });
      return socket.disconnect(true);
    }
    session.viewerSocketIds.add(socket.id);
    socket.emit("room-info", { hostOnline: Boolean(session.hostSocketId) });
    if (session.hostSocketId) io.to(session.hostSocketId).emit("viewer-joined", { viewerId: socket.id });
  }

  socket.on("request-stream", () => {
    if (role === "viewer" && session.hostSocketId) io.to(session.hostSocketId).emit("viewer-request", { viewerId: socket.id });
  });
  socket.on("signal", payload => {
    if (!payload || typeof payload.to !== "string" || !payload.data || typeof payload.data !== "object") return;
    const target = io.sockets.sockets.get(payload.to);
    if (!target || target.data.sessionId !== sessionId || target.data.role === role) return;
    if (role === "viewer" && target.id !== session.hostSocketId) return;
    if (role === "host" && !session.viewerSocketIds.has(target.id)) return;
    target.emit("signal", { from: socket.id, data: payload.data });
  });
  socket.on("disconnect", () => {
    const current = sessions.get(sessionId);
    if (!current) return;
    if (role === "host" && current.hostSocketId === socket.id) {
      current.hostSocketId = null;
      io.to(room).emit("stream-ended", { message: "O transmissor desconectou." });
    } else if (role === "viewer") {
      current.viewerSocketIds.delete(socket.id);
      if (current.hostSocketId) io.to(current.hostSocketId).emit("viewer-left", { viewerId: socket.id });
    }
  });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nEncerrando servidor (${signal})...`);
  for (const id of sessions.keys()) stopSession(id, "Servidor desligado.");
  io.close();
  client.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

(async () => {
  try {
    server.listen(PORT, () => console.log(`Servidor disponível na porta ${PORT}`));
  } catch (error) {
    console.error("Falha ao iniciar o servidor web:", error);
    await shutdown("startup-error");
    return;
  }
  try {
    await registerCommands();
    await client.login(process.env.DISCORD_TOKEN);
  } catch (error) {
    // O site continua no ar mesmo se o bot falhar, para facilitar o diagnóstico.
    console.error("Falha ao conectar o bot no Discord:", error);
  }
})();

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
