// Comandos avulsos do Anti Janja (os mesmos recursos de resenha do Zap):
// /sorteio /enquete /meme Print /lembrar /lembretes /cancelarlembrete /gratis /avisos
import {
    SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType,
    AttachmentBuilder, MessageFlags, PermissionFlagsBits
} from 'discord.js';
import { tratarSorteio } from './roleta.mjs';
import * as grupo from './comunidade.mjs';
import * as imagens from './imagens.mjs';
import * as gym from './gym.mjs';
import path from 'node:path';

const efemero = { flags: MessageFlags.Ephemeral };

export const definicoes = [
    new SlashCommandBuilder().setName('sorteio').setDescription('Roleta de eliminação: vai riscando opções até sobrar a vencedora.')
        .addStringOption(o => o.setName('opcoes').setDescription('Opções separadas por vírgula (de 2 a 30)').setRequired(true).setMaxLength(1500)),
    new SlashCommandBuilder().setName('enquete').setDescription('Cria uma enquete (votação) no canal.')
        .addStringOption(o => o.setName('pergunta').setDescription('A pergunta').setRequired(true).setMaxLength(300))
        .addStringOption(o => o.setName('opcoes').setDescription('Opções separadas por | ou vírgula (de 2 a 10)').setRequired(true).setMaxLength(600))
        .addBooleanOption(o => o.setName('multipla').setDescription('Pode marcar mais de uma?'))
        .addIntegerOption(o => o.setName('horas').setDescription('Quanto tempo fica aberta (padrão 24h)').setMinValue(1).setMaxValue(168)),
    new SlashCommandBuilder().setName('meme').setDescription('Coloca uma frase numa foto, estilo meme.')
        .addAttachmentOption(o => o.setName('imagem').setDescription('A foto').setRequired(true))
        .addStringOption(o => o.setName('texto').setDescription('A frase').setRequired(true).setMaxLength(200))
        .addStringOption(o => o.setName('posicao').setDescription('Onde vai a frase (padrão: embaixo)')
            .addChoices({ name: 'embaixo', value: 'baixo' }, { name: 'em cima', value: 'cima' })),
    new ContextMenuCommandBuilder().setName('Print').setType(ApplicationCommandType.Message),
    new SlashCommandBuilder().setName('lembrar').setDescription('Marca um lembrete: o bot te chama aqui na hora.')
        .addStringOption(o => o.setName('lembrete').setDescription('<quando> <o quê> — ex.: amanhã 20h ..., sexta 20h30 ..., 30min ...').setRequired(true).setMaxLength(250)),
    new SlashCommandBuilder().setName('lembretes').setDescription('Seus lembretes marcados.'),
    new SlashCommandBuilder().setName('cancelarlembrete').setDescription('Cancela um lembrete seu.')
        .addIntegerOption(o => o.setName('numero').setDescription('Número do lembrete (veja em /lembretes)').setRequired(true).setMinValue(1)),
    new SlashCommandBuilder().setName('gratis').setDescription('Jogos de graça na Epic Games agora.'),
    new SlashCommandBuilder().setName('treino').setDescription('Gym Rats: marca o treino de hoje (com foto) e ganha 1 ponto.')
        .addAttachmentOption(o => o.setName('foto').setDescription('Foto do treino (obrigatória)').setRequired(true))
        .addStringOption(o => o.setName('legenda').setDescription('O que treinou hoje (opcional)').setMaxLength(200)),
    new SlashCommandBuilder().setName('gym').setDescription('Gym Rats: ranking do mês e sequências 🔥.'),
    new SlashCommandBuilder().setName('apagartreino').setDescription('Apaga o seu check-in de hoje (se mandou errado).'),
    new SlashCommandBuilder().setName('avisos').setDescription('Usa este canal para jogos grátis e a retrospectiva semanal (admin).')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
].map(c => c.toJSON());

// Devolve true se o comando era daqui
export async function tratar(interaction) {
    if (interaction.isMessageContextMenuCommand() && interaction.commandName === 'Print') {
        const m = interaction.targetMessage;
        if (!m.content?.trim()) { await interaction.reply({ ...efemero, content: 'Essa mensagem não tem texto pra virar print.' }); return true; }
        await interaction.deferReply();
        const cor = m.member?.displayHexColor && m.member.displayHexColor !== '#000000' ? m.member.displayHexColor : '#f0b232';
        const imagem = await imagens.print({
            nome: m.member?.displayName ?? m.author.displayName ?? m.author.username, cor,
            avatarUrl: (m.member ?? m.author).displayAvatarURL({ extension: 'png', size: 256 }),
            texto: m.cleanContent, quando: m.createdAt
        });
        await interaction.editReply({ files: [new AttachmentBuilder(imagem, { name: 'print.png' })] });
        return true;
    }
    if (!interaction.isChatInputCommand()) return false;

    switch (interaction.commandName) {
        case 'sorteio':
            await tratarSorteio(interaction);
            return true;
        case 'enquete': {
            const respostas = [...new Set(interaction.options.getString('opcoes').split(/[|,\n]+/).map(o => o.trim().slice(0, 55)).filter(Boolean))];
            if (respostas.length < 2 || respostas.length > 10) {
                await interaction.reply({ ...efemero, content: 'A enquete precisa de 2 a 10 opções, separadas por | ou vírgula.' });
                return true;
            }
            await interaction.reply({ poll: {
                question: { text: interaction.options.getString('pergunta') },
                answers: respostas.map(text => ({ text })),
                duration: interaction.options.getInteger('horas') ?? 24,
                allowMultiselect: interaction.options.getBoolean('multipla') ?? false
            } });
            return true;
        }
        case 'meme': {
            const anexo = interaction.options.getAttachment('imagem');
            if (!anexo.contentType?.startsWith('image/')) { await interaction.reply({ ...efemero, content: 'Manda uma imagem (foto, print ou GIF).' }); return true; }
            if (anexo.size > 10 * 1024 * 1024) { await interaction.reply({ ...efemero, content: 'Imagem grande demais (máx. 10 MB).' }); return true; }
            await interaction.deferReply();
            const imagem = await imagens.meme(anexo.url, interaction.options.getString('texto'), interaction.options.getString('posicao') === 'cima');
            await interaction.editReply({ files: [new AttachmentBuilder(imagem, { name: 'meme.jpg' })] });
            return true;
        }
        case 'lembrar': {
            const r = grupo.lembrar(interaction.options.getString('lembrete'), interaction.user.id, interaction.channelId);
            await interaction.reply({ ...(r.ok ? {} : efemero), content: r.texto, allowedMentions: { parse: [] } });
            return true;
        }
        case 'lembretes':
            await interaction.reply({ ...efemero, content: grupo.listarLembretes(interaction.user.id) });
            return true;
        case 'cancelarlembrete':
            await interaction.reply({ ...efemero, content: grupo.cancelarLembrete(interaction.options.getInteger('numero'), interaction.user.id) });
            return true;
        case 'gratis': {
            await interaction.deferReply();
            const jogos = await grupo.buscarGratis().catch(() => null);
            if (!jogos) await interaction.editReply('Não consegui falar com a Epic agora. Tenta daqui a pouco.');
            else if (!jogos.length) await interaction.editReply('Nenhum jogo de graça na Epic neste momento.');
            else await interaction.editReply({ embeds: jogos.slice(0, 5).map(grupo.embedGratis) });
            return true;
        }
        case 'treino': {
            const anexo = interaction.options.getAttachment('foto');
            if (!anexo.contentType?.startsWith('image/')) { await interaction.reply({ ...efemero, content: 'A foto tem que ser uma imagem 📸' }); return true; }
            if (anexo.size > 15 * 1024 * 1024) { await interaction.reply({ ...efemero, content: 'Foto grande demais (máx. 15 MB).' }); return true; }
            await interaction.deferReply();
            const r = await fetch(anexo.url, { signal: AbortSignal.timeout(20_000) });
            const nome = interaction.member?.displayName ?? interaction.user.displayName ?? interaction.user.username;
            const res = await gym.registrar({ userId: interaction.user.id, nome, foto: Buffer.from(await r.arrayBuffer()),
                legenda: interaction.options.getString('legenda'), origem: 'discord' });
            if (!res.ok) { await interaction.editReply(res.motivo); return true; }
            const fogo = res.sequencia >= 2 ? ` · 🔥 ${res.sequencia} dias seguidos` : '';
            const legenda = interaction.options.getString('legenda');
            await interaction.editReply({
                embeds: [{ color: 0xff8a00, title: `💪 ${nome} treinou!`, description: `${legenda ? `${legenda}\n\n` : ''}**${res.pontos}** ponto${res.pontos > 1 ? 's' : ''} no mês · ${res.posicao}º de ${res.total}${fogo}`,
                    image: { url: 'attachment://treino.jpg' }, footer: { text: 'Gym Rats do Regresso · /gym pra ver o ranking' } }],
                files: [new AttachmentBuilder(path.join(gym.FOTOS, res.arquivo), { name: 'treino.jpg' })]
            });
            return true;
        }
        case 'gym': {
            const ranking = gym.rankingMes();
            const linhas = ranking.slice(0, 15).map(r => `${r.posicao <= 3 ? ['🥇', '🥈', '🥉'][r.posicao - 1] : `${r.posicao}.`} **${r.nome}** — ${r.pontos} treino${r.pontos > 1 ? 's' : ''}${r.sequencia >= 2 ? ` · 🔥${r.sequencia}` : ''}`);
            await interaction.reply({ embeds: [{ color: 0xff8a00, title: `🏋️ Gym Rats — ${gym.nomeMes(gym.hoje().slice(0, 7))}`,
                description: linhas.join('\n') || 'Ninguém treinou ainda este mês. Bora ser o primeiro: `/treino` com a foto! 💪',
                footer: { text: '1 treino por dia = 1 ponto · empate: quem chegou primeiro' } }], allowedMentions: { parse: [] } });
            return true;
        }
        case 'apagartreino':
            await interaction.reply({ ...efemero, content: gym.apagarHoje(interaction.user.id) ? '🗑️ Check-in de hoje apagado. Pode mandar de novo.' : 'Você não tem check-in hoje.' });
            return true;
        case 'avisos':
            grupo.definirCanalAvisos(interaction.channelId);
            await interaction.reply({ content: '📣 Pronto: jogos grátis da Epic e a retrospectiva de domingo (20h) vão sair neste canal.' });
            return true;
        default:
            return false;
    }
}

// Lembretes (20 s) e avisos automáticos: jogos grátis e retrospectiva semanal (30 min)
export function iniciar(client) {
    setInterval(() => grupo.enviarLembretes(client).catch(e => console.error('Lembretes:', e.message)), 20_000);
    const avisos = () => {
        grupo.verificarEpic(client).catch(e => console.error('Jogos grátis:', e.message));
        grupo.verificarRetro(client).catch(e => console.error('Retrospectiva:', e.message));
    };
    avisos();
    setInterval(avisos, 30 * 60_000);
    // Gym Rats: campeão do mês no canal de avisos (dia 1, 9h)
    const campeao = async () => {
        const c = gym.campeaoPendente();
        const id = grupo.canalAvisos();
        if (!c || !id) return;
        const canal = await client.channels.fetch(id).catch(() => null);
        const top = c.ranking.slice(0, 5).map(r => `${r.posicao <= 3 ? ['🥇', '🥈', '🥉'][r.posicao - 1] : `${r.posicao}.`} **${r.nome}** — ${r.pontos} treinos`).join('\n');
        await canal?.send({ content: `🏆 **Gym Rats de ${gym.nomeMes(c.mes)}**\nCampeão: **${c.ranking[0].nome}** com ${c.ranking[0].pontos} treinos!\n\n${top}\n\nO ranking zerou: bora pro mês novo 💪`, allowedMentions: { parse: [] } });
    };
    setInterval(() => campeao().catch(e => console.error('Gym Rats:', e.message)), 15 * 60_000);
}
