# Anti Janja — sala pública multi-transmissor

Bot de Discord + página web para salas onde qualquer pessoa com o link assiste e transmite a própria tela.

## Como usar

- `/transmitir` (Discord) ou `!transmitir` (grupo do WhatsApp): cria a sala e devolve um link.
- Quem abre o link vê todas as transmissões em grade e pode clicar em **Transmitir minha tela**.
- `/parar` ou `!parar`: o criador encerra a sala para todo mundo.
- Áudio do sistema e microfone são opcionais (dependem do navegador; no Chrome/Edge, marque "compartilhar áudio").

## Arquitetura

- Express serve as páginas (`/`, `/room/:id?key=...`) e o Socket.IO faz só a sinalização.
- Vídeo e áudio vão direto entre os navegadores (WebRTC, topologia mesh). Limite padrão: 6 espectadores por sala.
- Salas ficam na memória: reiniciar o servidor encerra todas.
- `POST /api/salas` e `DELETE /api/salas/:ownerId`: API interna usada pelo bot do WhatsApp, protegida por uma chave
  gerada automaticamente em `zap-data/antijanja.key` (fora da public_html).
- `/health` responde `{"ok":true}`.

## Configuração

Variáveis (ver `.env.example`): `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `PUBLIC_URL` obrigatórias.
Na Hostinger os segredos ficam em `/home/u243267678/domains/mrbnexus.com.br/.antijanja.env`.

```
npm install
npm start
```
