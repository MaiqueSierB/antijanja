// Comandos avulsos do Anti Janja (os mesmos recursos de resenha do Zap):
// /sorteio /enquete /meme Print /lembrar /lembretes /cancelarlembrete /gratis /avisos
import {
    SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType,
    AttachmentBuilder, MessageFlags, PermissionFlagsBits
} from 'discord.js';
import { tratarSorteio } from './roleta.mjs';
import * as grupo from './comunidade.mjs';
import * as imagens from './imagens.mjs';

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
}
