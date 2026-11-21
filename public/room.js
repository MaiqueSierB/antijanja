(() => {
  const params = new URLSearchParams(location.search);
  const roomId = location.pathname.split("/").pop();
  const key = params.get("key");
  const participantId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).slice(0, 70);
  const $ = id => document.getElementById(id);
  const statusEl = $("status");
  const grid = $("streamGrid");
  const mainVideo = $("mainVideo");
  const stageEmpty = $("stageEmpty");
  const startBtn = $("startShare");
  const stopBtn = $("stopShare");
  const enableSoundBtn = $("enableSound");
  const qualitySelect = $("quality");
  const QUALITY = {
    "720p30": { width: 1280, height: 720, fps: 30, bitrate: 4_000_000 },
    "1080p30": { width: 1920, height: 1080, fps: 30, bitrate: 7_000_000 },
    "720p60": { width: 1280, height: 720, fps: 60, bitrate: 5_000_000 },
    "1080p60": { width: 1920, height: 1080, fps: 60, bitrate: 9_000_000 }
  };
  const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

  let viewerSocket;
  let publisherSocket;
  let localStream = null;
  let localCard = null;
  // Faixas vindas de getDisplayMedia são loopback do áudio do computador.
  // Se reproduzirmos o áudio remoto enquanto essas faixas estão ativas,
  // o som remoto pode ser capturado novamente e circular pela sala.
  let systemAudioTracks = [];
  let listeningToRoom = false;
  let selectedId = null;
  const incoming = new Map(); // publisher socket id -> { pc, stream, card, video }
  const outgoing = new Map(); // viewer socket id -> { pc, pendingCandidates }

  function status(message, type = "secondary") {
    statusEl.textContent = message;
    statusEl.className = `alert alert-${type} mt-3 mb-0`;
  }

  function updateCounts() {
    const count = incoming.size + (localStream ? 1 : 0);
    $("streamCount").textContent = `${count} ${count === 1 ? "participante" : "participantes"}`;
    $("roomCount").textContent = `${count} AO VIVO`;
  }

  function isSystemAudioBeingSent() {
    return systemAudioTracks.some(track => track.readyState === "live" && track.enabled);
  }

  function updateAudioModeUI() {
    const button = $("toggleRoomAudio");
    const active = systemAudioTracks.some(track => track.readyState === "live");
    button.hidden = !active;
    button.textContent = listeningToRoom
      ? "Voltar a compartilhar o áudio do PC"
      : "Ouvir a sala (pausar áudio do PC)";
    $("audioModeNotice").hidden = !active;
    $("audioModeNotice").textContent = listeningToRoom
      ? "Você está ouvindo os outros participantes. O áudio do PC está pausado e não será enviado."
      : "Para evitar retorno digital, o áudio recebido fica mudo enquanto você compartilha o áudio do PC.";
  }

  function setSystemAudioEnabled(enabled) {
    for (const track of systemAudioTracks) track.enabled = enabled;
    listeningToRoom = !enabled;
    updateAudioModeUI();
    if (selectedId && selectedId !== "local") {
      mainVideo.muted = !enabled;
      if (enabled) mainVideo.play().catch(() => { enableSoundBtn.hidden = false; });
    }
    status(enabled
      ? "Áudio do PC retomado. O áudio recebido será silenciado para evitar retorno."
      : "Áudio do PC pausado. Você pode ouvir os outros participantes.", "info");
  }

  function setMain(id) {
    selectedId = id;
    const item = id === "local" ? null : incoming.get(id);
    const stream = id === "local" ? localStream : item?.stream;
    if (!stream) return;
    mainVideo.srcObject = stream;
    // Nunca reproduzir o áudio da própria transmissão localmente: isso evita
    // realimentação acústica quando o microfone está capturando os alto-falantes.
    mainVideo.muted = id === "local" || (isSystemAudioBeingSent() && !listeningToRoom);
    mainVideo.volume = 1;
    mainVideo.hidden = false;
    stageEmpty.hidden = true;
    $("stageTitle").textContent = id === "local" ? "Sua transmissão" : `Transmissão ${String(id).slice(0, 5)}`;
    $("stageAudioState").textContent = id === "local"
      ? "Prévia local silenciada"
      : (stream.getAudioTracks().length
        ? (mainVideo.muted ? "Áudio remoto silenciado para evitar retorno do áudio do PC" : "Áudio disponível · volume no player")
        : "Sem faixa de áudio");
    enableSoundBtn.hidden = true;
    mainVideo.play().catch(() => { enableSoundBtn.hidden = false; });
    document.querySelectorAll(".stream-card").forEach(card => card.classList.toggle("active", card.dataset.streamId === id));
  }

  function clearMainIf(id) {
    if (selectedId !== id) return;
    const fallback = incoming.keys().next().value || (localStream ? "local" : null);
    if (fallback) setMain(fallback);
    else {
      selectedId = null;
      mainVideo.pause();
      mainVideo.srcObject = null;
      mainVideo.hidden = true;
      stageEmpty.hidden = false;
      $("stageTitle").textContent = "Tela principal";
      $("stageAudioState").textContent = "Selecione uma transmissão";
      enableSoundBtn.hidden = true;
    }
  }

  function makeCard(id, label, stream, isLocal = false) {
    const col = document.createElement("div");
    col.className = "col";
    const card = document.createElement("div");
    card.className = "card stream-card bg-body-tertiary border-secondary h-100";
    card.dataset.streamId = id;
    const thumb = document.createElement("div");
    thumb.className = "stream-thumb rounded-top overflow-hidden";
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.srcObject = stream;
    thumb.append(video);
    const body = document.createElement("div");
    body.className = "card-body p-2 d-flex align-items-center justify-content-between gap-2";
    const name = document.createElement("span");
    name.className = "small fw-semibold text-truncate";
    name.textContent = label;
    const badge = document.createElement("span");
    badge.className = `badge ${isLocal ? "text-bg-primary" : "text-bg-success"}`;
    badge.textContent = isLocal ? "VOCÊ" : "AO VIVO";
    body.append(name, badge);
    card.append(thumb, body);
    card.addEventListener("click", () => setMain(id));
    col.append(card);
    grid.append(col);
    card._col = col;
    video.play().catch(() => {});
    return { card, video, col };
  }

  function removeIncoming(publisherId) {
    const item = incoming.get(publisherId);
    if (!item) return;
    item.pc.close();
    item.card._col.remove();
    incoming.delete(publisherId);
    clearMainIf(publisherId);
    updateCounts();
  }

  function connectViewerSocket() {
    viewerSocket = io({ auth: { sessionId: roomId, key, role: "room-viewer", participantId } });
    viewerSocket.on("connect", () => status("Você entrou na sala. Pode assistir ou iniciar sua transmissão.", "success"));
    viewerSocket.on("connect_error", error => status(error.message, "danger"));
    viewerSocket.on("room-full", data => status(data.message, "danger"));
    viewerSocket.on("room-publishers", list => list.forEach(({ publisherId }) => connectToPublisher(publisherId)));
    viewerSocket.on("publisher-joined", ({ publisherId }) => connectToPublisher(publisherId));
    viewerSocket.on("publisher-left", ({ publisherId }) => removeIncoming(publisherId));
    viewerSocket.on("signal", async ({ from, data }) => {
      const item = incoming.get(from);
      if (!item) return;
      try {
        if (data.description) {
          await item.pc.setRemoteDescription(data.description);
          for (const candidate of item.pendingCandidates.splice(0)) await item.pc.addIceCandidate(candidate);
          const answer = await item.pc.createAnswer();
          await item.pc.setLocalDescription(answer);
          viewerSocket.emit("signal", { to: from, data: { description: item.pc.localDescription } });
        }
        if (data.candidate) {
          if (item.pc.remoteDescription) await item.pc.addIceCandidate(data.candidate);
          else item.pendingCandidates.push(data.candidate);
        }
      } catch (error) {
        console.warn("Erro recebendo transmissão:", error);
        status("Falha ao conectar uma transmissão. Tente atualizar a página.", "danger");
      }
    });
    viewerSocket.on("room-count", updateCounts);
    viewerSocket.on("disconnect", () => status("Conexão com a sala perdida. Tentando reconectar...", "warning"));
  }

  function connectToPublisher(publisherId) {
    if (incoming.has(publisherId) || !viewerSocket?.connected) return;
    const pc = new RTCPeerConnection({ iceServers });
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
    const item = { pc, stream: new MediaStream(), card: null, video: null, pendingCandidates: [] };
    incoming.set(publisherId, item);
    pc.ontrack = event => {
      const track = event.track;
      if (!item.stream.getTracks().some(existing => existing.id === track.id)) item.stream.addTrack(track);
      if (!item.card) {
        const elements = makeCard(publisherId, `Transmissão ${String(publisherId).slice(0, 5)}`, item.stream);
        item.card = elements.card;
        item.video = elements.video;
      }
      if (selectedId === null) setMain(publisherId);
      updateCounts();
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) viewerSocket.emit("signal", { to: publisherId, data: { candidate } });
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "closed"].includes(pc.connectionState)) removeIncoming(publisherId);
    };
    viewerSocket.emit("request-stream", { publisherId });
  }

  async function makeOutgoingPeer(viewerId) {
    if (!localStream || outgoing.has(viewerId) || !publisherSocket?.connected) return;
    const pc = new RTCPeerConnection({ iceServers });
    const peer = { pc, pendingCandidates: [] };
    outgoing.set(viewerId, peer);
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) publisherSocket.emit("signal", { to: viewerId, data: { candidate } });
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "closed"].includes(pc.connectionState)) {
        pc.close();
        outgoing.delete(viewerId);
      }
    };
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      publisherSocket.emit("signal", { to: viewerId, data: { description: pc.localDescription } });
    } catch (error) {
      console.error("Erro criando transmissão:", error);
      pc.close();
      outgoing.delete(viewerId);
    }
  }

  function connectPublisherSocket() {
    publisherSocket = io({ auth: { sessionId: roomId, key, role: "publisher", participantId } });
    publisherSocket.on("connect", () => status("Sua transmissão está ativa para todos na sala.", "success"));
    publisherSocket.on("connect_error", error => status(`Falha ao publicar: ${error.message}`, "danger"));
    publisherSocket.on("room-viewers", list => list.forEach(({ viewerId }) => makeOutgoingPeer(viewerId)));
    publisherSocket.on("viewer-joined", ({ viewerId }) => makeOutgoingPeer(viewerId));
    publisherSocket.on("viewer-request", ({ viewerId }) => makeOutgoingPeer(viewerId));
    publisherSocket.on("viewer-left", ({ viewerId }) => {
      outgoing.get(viewerId)?.pc.close();
      outgoing.delete(viewerId);
    });
    publisherSocket.on("signal", async ({ from, data }) => {
      const peer = outgoing.get(from);
      if (!peer) return;
      try {
        if (data.description) {
          await peer.pc.setRemoteDescription(data.description);
          for (const candidate of peer.pendingCandidates.splice(0)) await peer.pc.addIceCandidate(candidate);
        }
        if (data.candidate) {
          if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate);
          else peer.pendingCandidates.push(data.candidate);
        }
      } catch (error) { console.warn("Falha na sinalização de saída:", error); }
    });
  }

  async function startShare() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      status("Seu navegador não oferece captura de tela. Use Chrome ou Edge atualizado.", "danger");
      return;
    }
    startBtn.disabled = true;
    try {
      const selected = QUALITY[qualitySelect.value] || QUALITY["1080p30"];
      localStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: selected.width }, height: { ideal: selected.height }, frameRate: { ideal: selected.fps, max: selected.fps } },
        // Áudio: ao compartilhar uma JANELA, pede o som só daquela janela (windowAudio), e não o do PC inteiro —
        // senão entram junto o Discord e o resto. Navegador sem suporte ignora essas opções.
        audio: $("systemAudio").checked
          ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false, restrictOwnAudio: true }
          : false,
        windowAudio: "window",
        systemAudio: "include",
        selfBrowserSurface: "exclude",
        surfaceSwitching: "include"
      });
      // Guardar apenas as faixas de loopback do sistema antes de adicionar o microfone.
      systemAudioTracks = localStream.getAudioTracks().slice();
      listeningToRoom = false;
      if ($("microphoneAudio").checked) {
        const mic = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: false,
            channelCount: 1
          },
          video: false
        });
        mic.getAudioTracks().forEach(track => localStream.addTrack(track));
      }
      const videoTrack = localStream.getVideoTracks()[0];
      if (!videoTrack) throw new Error("A captura não forneceu vídeo.");
      videoTrack.addEventListener("ended", stopShare, { once: true });
      const elements = makeCard("local", "Minha transmissão", localStream, true);
      localCard = elements.card;
      setMain("local");
      updateAudioModeUI();
      connectPublisherSocket();
      stopBtn.disabled = false;
      const audioCount = localStream.getAudioTracks().length;
      // Janela compartilhada mas o navegador entregou o som do PC inteiro (Chrome antigo): avisa
      const superficie = videoTrack.getSettings?.().displaySurface;
      const somDoPcInteiro = superficie === "window" && systemAudioTracks.some(t => /system|sistema/i.test(t.label));
      if (somDoPcInteiro) {
        status("Transmitindo, mas o navegador pegou o som do PC inteiro (inclui o Discord e o que mais tocar). " +
          "Pra mandar só o som do jogo: atualize o Chrome/Edge, ou silencie o Discord enquanto transmite, ou desligue “Áudio do sistema”.", "warning");
      } else {
        status(`Transmitindo. ${audioCount ? `${audioCount} faixa(s) de áudio capturada(s).` : "Nenhuma faixa de áudio foi capturada; confira as opções de áudio."} Se o áudio do PC estiver ativo, use “Ouvir a sala” para alternar entre compartilhar o som do PC e escutar os participantes.`, audioCount ? "success" : "warning");
      }
      updateCounts();
    } catch (error) {
      localStream?.getTracks().forEach(track => track.stop());
      localStream = null;
      systemAudioTracks = [];
      listeningToRoom = false;
      updateAudioModeUI();
      startBtn.disabled = false;
      stopBtn.disabled = true;
      status(error.name === "NotAllowedError" ? "Compartilhamento cancelado ou permissão negada." : `Não foi possível iniciar: ${error.message}`, "danger");
    }
  }

  function stopShare() {
    localStream?.getTracks().forEach(track => track.stop());
    localStream = null;
    systemAudioTracks = [];
    listeningToRoom = false;
    updateAudioModeUI();
    for (const peer of outgoing.values()) peer.pc.close();
    outgoing.clear();
    publisherSocket?.disconnect();
    publisherSocket = null;
    localCard?._col.remove();
    localCard = null;
    clearMainIf("local");
    startBtn.disabled = false;
    stopBtn.disabled = true;
    updateCounts();
    status("Sua transmissão foi encerrada. Você continua na sala e pode assistir às outras.", "secondary");
  }

  startBtn.addEventListener("click", startShare);
  stopBtn.addEventListener("click", stopShare);
  $("copyRoom").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      $("copyRoom").innerHTML = '<i class="bi bi-check2 me-1"></i>Copiado!';
    } catch { status("Não foi possível copiar automaticamente. Copie o endereço da barra do navegador.", "warning"); }
  });
  enableSoundBtn.addEventListener("click", () => {
    if (isSystemAudioBeingSent() && !listeningToRoom) {
      status("Para ouvir os participantes, use “Ouvir a sala”. Isso pausa temporariamente o áudio do PC para evitar realimentação.", "warning");
      return;
    }
    mainVideo.muted = false;
    mainVideo.play().then(() => { enableSoundBtn.hidden = true; }).catch(() => status("O navegador ainda bloqueou o áudio. Verifique as permissões.", "warning"));
  });

  $("toggleRoomAudio").addEventListener("click", () => {
    if (!systemAudioTracks.length) return;
    setSystemAudioEnabled(listeningToRoom);
  });

  updateAudioModeUI();

  if (!key || !roomId) {
    status("Link da sala inválido. Peça ao criador um novo link pelo Discord.", "danger");
    startBtn.disabled = true;
  } else {
    connectViewerSocket();
  }
  window.addEventListener("beforeunload", () => {
    localStream?.getTracks().forEach(track => track.stop());
    publisherSocket?.disconnect();
    viewerSocket?.disconnect();
  });
})();
