// /sorteio: roleta de eliminação, igual à do Zap (!sorteio). Uma mensagem que vai sendo editada,
// riscando opções até sobrar a vencedora. Mesmas regras: até 30 opções, no máximo 8 rodadas,
// mais eliminações no começo e a última rodada tira só uma.
import { randomInt } from 'node:crypto';

const MAX_OPCOES = 30;
const MAX_RODADAS = 8;
const pausa = () => 3_500 + randomInt(2_000);   // 3,5 a 5,5 s entre rodadas
const rodando = new Set();                       // uma roleta por canal de cada vez
const espera = ms => new Promise(r => setTimeout(r, ms));

// Opções separadas por vírgula, ponto e vírgula, barra vertical ou uma por linha (sem repetidas)
export function lerOpcoes(texto) {
    const vistas = new Set();
    return String(texto ?? '').split(/[\n,;|]+/).map(o => o.trim().slice(0, 60)).filter(o => {
        const k = o.toLowerCase();
        if (!o || vistas.has(k)) return false;
        vistas.add(k);
        return true;
    });
}

// Ex.: 30 opções → 4,4,4,4,4,4,4,1
export function planoDeRodadas(n) {
    const total = Math.min(MAX_RODADAS, n - 1);
    if (total <= 1) return n > 1 ? [n - 1] : [];
    const antes = total - 1, tirar = n - 2;
    const base = Math.floor(tirar / antes), extra = tirar % antes;
    return [...Array.from({ length: antes }, (_, i) => base + (i < extra ? 1 : 0)), 1];
}

const semMarkdown = s => s.replace(/[*_~`|>\\]/g, c => `\\${c}`);

function tela(opcoes, eliminadas, rodada, ultimas) {
    const linhas = opcoes.map(o => (eliminadas.includes(o) ? `❌ ~~${semMarkdown(o)}~~` : `✅ ${semMarkdown(o)}`));
    const saiu = ultimas?.length ? `\n\n💥 Saiu: ${ultimas.map(o => `**${semMarkdown(o)}**`).join(', ')}` : '\n\nRodando...';
    return `🎡 **ROLETA DO REGRESSO** — rodada ${rodada}\n\n${linhas.join('\n')}${saiu}`;
}

export async function tratarSorteio(interaction) {
    const efemero = { flags: 64 };
    const opcoes = lerOpcoes(interaction.options.getString('opcoes'));
    if (opcoes.length < 2) {
        return interaction.reply({ ...efemero, content: '🎡 Mande pelo menos 2 opções separadas por vírgula. Ex.: `/sorteio opcoes: opção 1, opção 2, opção 3`' });
    }
    if (opcoes.length > MAX_OPCOES) return interaction.reply({ ...efemero, content: `Muita opção! O máximo é ${MAX_OPCOES}.` });
    const canal = interaction.channelId;
    if (rodando.has(canal)) return interaction.reply({ ...efemero, content: '⏳ Já tem uma roleta rodando neste canal. Espera ela terminar.' });

    rodando.add(canal);
    try {
        const restantes = [...opcoes];
        const eliminadas = [];
        await interaction.reply({ content: tela(opcoes, eliminadas, 0), allowedMentions: { parse: [] } });
        let rodada = 0;
        for (const quantas of planoDeRodadas(opcoes.length)) {
            await espera(pausa());
            const saiu = [];
            for (let k = 0; k < quantas; k++) saiu.push(restantes.splice(randomInt(restantes.length), 1)[0]);
            eliminadas.push(...saiu);
            rodada++;
            await interaction.editReply({ content: tela(opcoes, eliminadas, rodada, saiu), allowedMentions: { parse: [] } });
        }
        await espera(1_000);
        const ordem = eliminadas.map((o, i) => `${i + 1}. ${semMarkdown(o)}`).join('\n');
        await interaction.followUp({ content: `🏆 **DEU: ${semMarkdown(restantes[0])}!**\n\nOrdem de eliminação:\n${ordem}`, allowedMentions: { parse: [] } });
    } finally {
        rodando.delete(canal);
    }
}
