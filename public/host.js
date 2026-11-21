const params = new URLSearchParams(location.search);
const sessionId = location.pathname.split("/").pop();
const key = params.get("key");
const statusEl = document.getElementById("status");
const video = document.getElementById("preview");
const placeholder = document.getElementById("placeholder");
const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");
const viewerLink = document.getElementById("viewerLink");
const qualitySelect = document.getElementById("quality");
const systemAudioToggle = document.getElementById("systemAudio");
const microphoneAudioToggle = document.getElementById("microphoneAudio");
const copyBtn = document.getElementById("copy");

const QUALITY = {
  "720p30": { width: 1280, height: 720, fps: 30, bitrate: 5_000_000 },
  "1080p30": { width: 1920, height: 1080, fps: 30, bitrate: 10_000_000 },
  "720p60": { width: 1280, height: 720, fps: 60, bitrate: 7_000_000 },
  "1080p60": { width: 1920, height: 1080, fps: 60, bitrate: 14_000_000 },
  "1440p30": { width: 2560, height: 1440, fps: 30, bitrate: 16_000_000 },
  "1440p60": { width: 2560, height: 1440, fps: 60, bitrate: 24_000_000 }
};

let socket;
let stream;
const peers = new Map();

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

async function makePeer(viewerId) {
  if (!stream || peers.has(viewerId)) return;

  const pc = new RTCPeerConnection({ iceServers: iceServers() });
  const peer = { pc, pendingCandidates: [] };
  peers.set(viewerId, peer);

  for (const track of stream.getTracks()) {
    const sender = pc.addTrack(track, stream);
    if (track.kind !== "video") continue;

    const selected = QUALITY[qualitySelect.value] || QUALITY["1080p30"];
    const params = sender.getParameters();
    params.encodings = params.encodings?.length ? params.encodings : [{}];
    Object.assign(params.encodings[0], {
      maxBitrate: selected.bitrate,
      maxFramerate: selected.fps,
      scaleResolutionDownBy: 1
    });
    params.degradationPreference = "maintain-resolution";
    try {
      await sender.setParameters(params);
    } catch (error) {
      console.warn("Não foi possível aplicar os parâmetros de qualidade:", error);
    }
  }

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit("signal", { to: viewerId, data: { candidate } });
  };
  pc.onconnectionstatechange = () => {
    if (["failed", "closed"].includes(pc.connectionState)) {
      pc.close();
      peers.delete(viewerId);
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("signal", { to: viewerId, data: { description: pc.localDescription } });
  } catch (error) {
    console.error("Erro ao criar oferta:", error);
    pc.close();
    peers.delete(viewerId);
  }
}

function connectSocket() {
  socket = io({ auth: { sessionId, key, role: "host" } });
  socket.on("connect", () => setStatus("Conectado. Aguardando espectadores.", "good"));
  socket.on("connect_error", error => setStatus(error.message, "bad"));
  socket.on("viewer-joined", ({ viewerId }) => makePeer(viewerId));
  socket.on("viewer-request", ({ viewerId }) => makePeer(viewerId));
  socket.on("signal", async ({ from, data }) => {
    const peer = peers.get(from);
    if (!peer) return;
    try {
      if (data.description) {
        await peer.pc.setRemoteDescription(data.description);
        for (const candidate of peer.pendingCandidates.splice(0)) {
          await peer.pc.addIceCandidate(candidate);
        }
      }
      if (data.candidate) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate);
        else peer.pendingCandidates.push(data.candidate);
      }
    } catch (error) {
      console.warn("Falha na sinalização WebRTC:", error);
    }
  });
  socket.on("viewer-left", ({ viewerId }) => {
    peers.get(viewerId)?.pc.close();
    peers.delete(viewerId);
    setStatus(`Espectador desconectou. Conexões ativas: ${peers.size}.`, "good");
  });
  socket.on("disconnect", () => setStatus("Conexão com o servidor perdida. Reconectando...", "bad"));
}

async function startStream() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    setStatus("Este navegador não oferece captura de tela. Use uma versão atual do Chrome ou Edge.", "bad");
    return;
  }

  try {
    const selected = QUALITY[qualitySelect.value] || QUALITY["1080p30"];
    // Áudio do sistema vem do seletor de compartilhamento do navegador.
    // O microfone precisa de uma captura getUserMedia separada.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: selected.width },
        height: { ideal: selected.height },
        frameRate: { ideal: selected.fps, max: selected.fps }
      },
      audio: systemAudioToggle.checked
    });

    if (microphoneAudioToggle.checked) {
      const microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      for (const audioTrack of microphoneStream.getAudioTracks()) stream.addTrack(audioTrack);
    }

    const [videoTrack] = stream.getVideoTracks();
    if (!videoTrack) throw new Error("O navegador não forneceu uma faixa de vídeo.");

    video.srcObject = stream;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    videoTrack.contentHint = "detail";
    videoTrack.addEventListener("ended", stopStream, { once: true });

    try {
      await videoTrack.applyConstraints({
        width: { ideal: selected.width },
        height: { ideal: selected.height },
        frameRate: { ideal: selected.fps, max: selected.fps }
      });
    } catch (error) {
      console.warn("A captura manteve os limites definidos pelo navegador:", error);
    }

    await new Promise((resolve, reject) => {
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return resolve();
      const timeout = setTimeout(() => reject(new Error("Tempo esgotado aguardando a prévia.")), 10_000);
      video.addEventListener("loadedmetadata", () => { clearTimeout(timeout); resolve(); }, { once: true });
      video.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Não foi possível carregar a prévia.")); }, { once: true });
    });
    await video.play();
    placeholder.hidden = true;

    const settings = videoTrack.getSettings();
    const dimensions = settings.width && settings.height ? `${settings.width}×${settings.height}` : "resolução automática";
    const fps = settings.frameRate ? `${Math.round(settings.frameRate)} FPS` : `${selected.fps} FPS solicitados`;
    const systemAudioAvailable = stream.getAudioTracks().some(track => track.label && !track.label.toLowerCase().includes("microphone"));
    const audioTrackCount = stream.getAudioTracks().length;
    const audioMessage = audioTrackCount
      ? `${audioTrackCount} faixa(s) de áudio capturada(s)`
      : (systemAudioToggle.checked ? "nenhum áudio do sistema foi fornecido pela fonte selecionada" : "áudio do sistema desligado; microfone não selecionado");
    setStatus(`Captura ativa (${dimensions}, ${fps}). Áudio: ${audioMessage}. Limite de até ${(selected.bitrate / 1_000_000).toFixed(0)} Mbps por espectador.`, audioTrackCount ? "good" : "bad");
    socket.emit("host-ready");
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
    placeholder.hidden = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    setStatus(error.name === "NotAllowedError"
      ? "Compartilhamento cancelado ou permissão negada."
      : `Não foi possível iniciar: ${error.message}`, "bad");
  }
}

function stopStream() {
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  video.srcObject = null;
  placeholder.hidden = false;
  for (const { pc } of peers.values()) pc.close();
  peers.clear();
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus("Transmissão encerrada. Você pode iniciar novamente.");
}

startBtn.addEventListener("click", startStream);
stopBtn.addEventListener("click", stopStream);
copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(viewerLink.value);
    copyBtn.textContent = "Copiado!";
  } catch {
    viewerLink.select();
    document.execCommand("copy");
  }
});

viewerLink.value = `${location.origin}/watch/${sessionId}?key=${params.get("viewer") || ""}`;
connectSocket();
