const params = new URLSearchParams(location.search);
const sessionId = location.pathname.split("/").pop();
const key = params.get("key");
const statusEl = document.getElementById("status");
const video = document.getElementById("video");
const placeholder = document.getElementById("placeholder");
const soundBtn = document.getElementById("sound");

let socket;
let pc;
let hostId;
const pendingCandidates = [];

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  const tone = kind === "good" ? "success" : kind === "bad" ? "danger" : "secondary";
  statusEl.className = `alert alert-${tone} mt-3 mb-0`;
}

function iceServers() {
  return [
    { urls: "stun:stun.l.google.com:19302" },
    ...(window.STREAM_TURN_URL ? [{
      urls: window.STREAM_TURN_URL,
      username: window.STREAM_TURN_USERNAME,
      credential: window.STREAM_TURN_CREDENTIAL
    }] : [])
  ];
}

function createPeer() {
  if (pc) pc.close();
  pc = new RTCPeerConnection({ iceServers: iceServers() });
  pc.ontrack = async event => {
    video.srcObject = event.streams[0] || video.srcObject;
    video.muted = false;
    video.volume = 1;
    try {
      await video.play();
      soundBtn.hidden = true;
      const hasAudio = video.srcObject?.getAudioTracks().length > 0;
      setStatus(hasAudio ? "Você está assistindo ao vivo com áudio." : "Vídeo recebido, mas o transmissor não enviou faixa de áudio.", hasAudio ? "good" : "bad");
    } catch {
      soundBtn.hidden = false;
      setStatus("Transmissão recebida. Clique em Ativar áudio / iniciar vídeo.");
    }
    placeholder.hidden = true;
  };
  pc.onicecandidate = ({ candidate }) => {
    if (candidate && hostId) socket.emit("signal", { to: hostId, data: { candidate } });
  };
  pc.onconnectionstatechange = () => {
    if (pc?.connectionState === "failed") setStatus("Não foi possível estabelecer a conexão. Atualize a página ou tente outra rede.", "bad");
  };
}

function connect() {
  socket = io({ auth: { sessionId, key, role: "viewer" } });
  socket.on("connect", () => setStatus("Conectado à sala. Aguardando o transmissor...", "good"));
  socket.on("connect_error", error => setStatus(error.message, "bad"));
  socket.on("room-full", data => setStatus(data.message, "bad"));
  socket.on("room-info", info => {
    if (!info.hostOnline) setStatus("Sala aberta. O transmissor ainda não está conectado.");
  });
  socket.on("host-ready", () => {
    setStatus("Transmissor disponível. Negociando conexão...");
    socket.emit("request-stream");
  });
  socket.on("signal", async ({ from, data }) => {
    hostId = from;
    try {
      if (data.description) {
        createPeer();
        await pc.setRemoteDescription(data.description);
        for (const candidate of pendingCandidates.splice(0)) await pc.addIceCandidate(candidate);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("signal", { to: hostId, data: { description: pc.localDescription } });
      }
      if (data.candidate) {
        if (pc?.remoteDescription) await pc.addIceCandidate(data.candidate);
        else pendingCandidates.push(data.candidate);
      }
    } catch (error) {
      console.error("Falha na negociação WebRTC:", error);
      setStatus("Falha ao negociar o vídeo. Atualize a página.", "bad");
    }
  });
  socket.on("stream-ended", ({ message }) => {
    video.srcObject = null;
    placeholder.hidden = false;
    soundBtn.hidden = true;
    pc?.close();
    pc = null;
    pendingCandidates.length = 0;
    setStatus(message || "Transmissão encerrada.");
  });
  socket.on("disconnect", () => setStatus("Conexão perdida. Tentando reconectar...", "bad"));
}

soundBtn.addEventListener("click", () => {
  video.muted = false;
  video.volume = 1;
  video.play().then(() => {
    soundBtn.hidden = true;
    setStatus("Reprodução com áudio ativada.", "good");
  }).catch(() => setStatus("Não foi possível iniciar a reprodução. Verifique o volume do dispositivo.", "bad"));
});

connect();
