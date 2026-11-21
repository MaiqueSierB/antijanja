# Anti Janja — Sala pública multi-transmissor

Bot Discord e aplicação web para criar salas nas quais qualquer pessoa com o link pode assistir e iniciar sua própria transmissão de tela.

## Funcionalidades

- `/transmitir`: cria uma sala e devolve um único link compartilhável.
- Qualquer pessoa com o link pode entrar, assistir e transmitir.
- Grade com todas as transmissões ativas e palco principal selecionável.
- Cada participante pode iniciar e encerrar apenas a própria transmissão.
- Captura opcional de áudio do sistema e microfone.
- `/parar`: o criador encerra a sala inteira.
- Página inicial pública em `/`; o link de sala é `/room/:id?key=...`.

## Requisitos

- Node.js 20 ou superior.
- Aplicação/bot configurado no Discord Developer Portal.
- HTTPS para acesso externo e para permitir captura de tela no navegador. Cloudflare Quick Tunnel pode ser usado em testes.

## Instalação no Windows

1. Extraia o ZIP em uma pasta.
2. Copie seu `.env` antigo para a pasta do projeto (ou copie `.env.example` para `.env` e preencha as variáveis).
3. Confira principalmente `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID` e `PUBLIC_URL`.
4. Instale as dependências e inicie:

```powershell
npm install
npm start
```

5. Abra `http://localhost:3000/health`; a resposta esperada é `{"ok":true}`.
6. Use `/transmitir` no Discord. Compartilhe o link retornado.
7. Cada participante abre o mesmo link. Para transmitir, clica em **Transmitir minha tela**; para assistir, não precisa fazer nada.

## Variáveis de ambiente

```env
DISCORD_TOKEN=SEU_TOKEN_DO_BOT
DISCORD_CLIENT_ID=ID_DA_APLICACAO
DISCORD_GUILD_ID=ID_DO_SERVIDOR
PUBLIC_URL=https://seu-endereco-publico.trycloudflare.com
PORT=3000
SESSION_TTL_MINUTES=240
MAX_VIEWERS_PER_SESSION=6
```

`PUBLIC_URL` precisa ser o endereço HTTPS atual do túnel ou domínio público. Se o endereço do Quick Tunnel mudar, atualize `PUBLIC_URL` e reinicie `npm start`.

## Áudio

- Áudio do sistema depende do navegador e da fonte escolhida no seletor de compartilhamento. No Chrome/Edge, compartilhe uma aba ou a tela e marque a opção de compartilhar áudio quando ela estiver disponível.
- Microfone é capturado separadamente e exige permissão do navegador.
- Nem todos os sistemas operacionais/navegadores permitem capturar áudio de qualquer janela.
- O navegador pode exigir um clique do espectador para liberar reprodução de áudio.

## Arquitetura e limites

O Node.js/Express serve as páginas e o Socket.IO faz apenas a sinalização. O áudio e o vídeo trafegam diretamente entre os navegadores via WebRTC; o servidor não recebe nem grava mídia.

Esta versão usa topologia **mesh**: cada participante que transmite envia uma cópia da mídia para cada outro participante. O limite padrão é 6 conexões de participantes por sala (`MAX_VIEWERS_PER_SESSION`). Isso é deliberadamente conservador para evitar sobrecarregar upload, CPU e navegador. Aumentar o limite sem mudar a arquitetura pode degradar bastante a qualidade. Para salas maiores, o próximo passo é migrar para um SFU como LiveKit ou mediasoup.

STUN ajuda a estabelecer conexões, mas não resolve todas as redes. Para participantes atrás de NAT restritivo, firewall corporativo ou CGNAT, configure um servidor TURN e injete suas credenciais na configuração do cliente. O Quick Tunnel do Cloudflare publica a aplicação e a sinalização; ele não substitui TURN nem retransmite o vídeo WebRTC.

## Segurança

- O link da sala é uma credencial: qualquer pessoa que o possuir poderá assistir e transmitir.
- Não publique nem envie o `.env`; nunca coloque o token do Discord no frontend.
- O criador pode encerrar a sala com `/parar`; cada participante pode encerrar sua própria transmissão na página.
- As salas ficam na memória. Reiniciar o servidor encerra todas as salas.
- O Quick Tunnel gratuito é temporário e não oferece garantia de disponibilidade.
- Não use esta versão para conteúdo sensível ou para grandes públicos sem autenticação, moderação, rate limiting e SFU.

## Estrutura

```text
discord-screen-stream/
├── public/
│   ├── index.html
│   ├── room.html
│   ├── room.js
│   ├── host.html        # compatibilidade com links antigos
│   ├── host.js
│   ├── watch.html       # compatibilidade com links antigos
│   └── watch.js
├── src/
│   └── index.js
├── .env.example
├── .gitignore
├── package.json
└── README.md
```


## Correção de retorno do áudio do sistema (sala pública)

Em navegadores no Windows, a captura de áudio do sistema pode incluir o áudio que o próprio navegador está reproduzindo. Se um participante transmite o áudio do PC e, ao mesmo tempo, ouve outra transmissão na sala, esse áudio remoto pode ser capturado e enviado de volta para a sala, criando um ciclo digital de retorno/chiado. Fones de ouvido não necessariamente resolvem esse caso, porque o loop ocorre no áudio digital do sistema.

Nesta versão:
- Quando uma faixa de áudio do sistema está sendo enviada, o player principal de transmissões remotas fica silenciado localmente.
- O botão **“Ouvir a sala (pausar áudio do PC)”** pausa temporariamente as faixas de áudio do sistema enviadas e permite ouvir os demais participantes.
- Ao voltar a compartilhar o áudio do PC, o áudio remoto é silenciado novamente.
- O áudio recebido não é retransmitido diretamente pelo código; o bloqueio é aplicado para impedir que o loopback de `getDisplayMedia` recapture o áudio reproduzido pelo navegador.

Limitação do navegador: com captura padrão de áudio do sistema via `getDisplayMedia`, não há uma forma web universal de excluir apenas o áudio recebido de outros elementos/aplicativos e manter todo o restante do áudio do Windows. Por isso, esta versão oferece alternância entre **compartilhar o áudio do PC** e **ouvir os participantes**. Para manter ambos simultaneamente com isolamento garantido, será necessário um caminho de captura/roteamento de áudio específico do sistema operacional ou um aplicativo desktop.

Para testar, inicie uma transmissão com “Áudio do sistema” ativado, selecione outra transmissão na tela principal e confirme que ela fica silenciada. Clique em “Ouvir a sala (pausar áudio do PC)” para ouvir os demais; nesse modo, o áudio do PC deixa de ser enviado aos outros.
