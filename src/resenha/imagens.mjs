// Imagens iguais às figurinhas do Zap, para o Discord:
//  - /meme: foto com frase (estilo meme, letra branca com contorno)
//  - "Print" (clique direito numa mensagem → Apps → Print): a mensagem vira imagem de citação
// Usa o sharp com 1 thread (a hospedagem limita threads) e a fonte que vem junto com o bot.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FONTES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fontes');
try {
    const conf = path.join(os.tmpdir(), 'antijanja-fonts.conf');
    fs.writeFileSync(conf, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>` +
        `<dir>${FONTES}</dir><cachedir>${path.join(os.tmpdir(), 'antijanja-fontcache')}</cachedir></fontconfig>`);
    process.env.FONTCONFIG_FILE = conf;
} catch (e) {
    console.warn('Imagens: não deu para configurar as fontes:', e.message);
}

let sharpCache;
async function sharp() {
    if (!sharpCache) {
        sharpCache = (await import('sharp')).default;
        sharpCache.concurrency(1);
    }
    return sharpCache;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// A fonte não tem emoji: tira para não virar quadradinho
const semEmoji = s => String(s ?? '').replace(/\p{Extended_Pictographic}|️|‍/gu, '').replace(/<a?:(\w+):\d+>/g, ':$1:');

// Quebra o texto em linhas de no máximo `max` caracteres (a DejaVu Bold tem ~0,62 da altura por caractere)
function quebrar(texto, max) {
    const linhas = [];
    for (const paragrafo of texto.split('\n')) {
        let linha = '';
        for (const palavra of paragrafo.split(/\s+/).filter(Boolean)) {
            const p = palavra.length > max ? palavra.slice(0, max - 1) + '…' : palavra;
            if ((linha + ' ' + p).trim().length > max) { linhas.push(linha); linha = p; } else linha = (linha + ' ' + p).trim();
        }
        linhas.push(linha);
    }
    return linhas.filter((l, i, a) => l || (i > 0 && i < a.length - 1));
}

async function baixar(url, limite = 10 * 1024 * 1024) {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`download ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > limite) throw new Error('arquivo grande demais');
    return buf;
}

// ---------- /meme ----------
export async function meme(urlImagem, texto, emCima = false) {
    const s = await sharp();
    const base = await s(await baixar(urlImagem), { animated: false }).rotate()
        .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: false }).png().toBuffer();
    const { width: w, height: h } = await s(base).metadata();
    const limpo = semEmoji(texto).toUpperCase().trim().slice(0, 200);
    let tamanho = Math.round(w / 10);
    let linhas = quebrar(limpo, Math.max(6, Math.floor(w / (tamanho * 0.62))));
    while (linhas.length > 4 && tamanho > w / 22) {           // texto longo: diminui a letra
        tamanho = Math.round(tamanho * 0.85);
        linhas = quebrar(limpo, Math.max(6, Math.floor(w / (tamanho * 0.62))));
    }
    const altura = tamanho * 1.1;
    const y0 = emCima ? tamanho * 1.1 : h - altura * (linhas.length - 1) - tamanho * 0.45;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
<g font-family="DejaVu Sans" font-weight="bold" font-size="${tamanho}" text-anchor="middle" fill="#fff" stroke="#000" stroke-width="${Math.max(2, tamanho / 9)}" paint-order="stroke" stroke-linejoin="round">
${linhas.map((l, i) => `<text x="${w / 2}" y="${y0 + i * altura}">${esc(l)}</text>`).join('\n')}
</g></svg>`;
    return s(base).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 88 }).toBuffer();
}

// ---------- Print (citação) ----------
export async function print({ nome, cor, avatarUrl, texto, quando }) {
    const s = await sharp();
    const W = 1000, PAD = 48, AV = 120;
    const limpo = semEmoji(texto).trim().slice(0, 600) || '(mensagem sem texto)';
    const tamanho = limpo.length > 280 ? 34 : limpo.length > 120 ? 40 : 48;
    const linhas = quebrar(limpo, Math.floor((W - PAD * 3 - AV) / (tamanho * 0.6))).slice(0, 14);
    const topoTexto = PAD + 64 + tamanho;
    const H = Math.max(AV + PAD * 2, topoTexto + (linhas.length - 1) * tamanho * 1.3 + PAD + 40);
    const x = PAD * 2 + AV;
    const data = quando.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<rect width="${W}" height="${H}" rx="36" fill="#1e1f22"/>
<text x="${W - PAD}" y="${H - PAD / 1.5}" font-family="DejaVu Sans" font-weight="bold" font-size="22" fill="#6d6f78" text-anchor="end">REGRESSO · ${esc(data)}</text>
<g font-family="DejaVu Sans" font-weight="bold">
<text x="${x}" y="${PAD + 40}" font-size="38" fill="${cor}">${esc(semEmoji(nome).slice(0, 32))}</text>
${linhas.map((l, i) => `<text x="${x}" y="${topoTexto + i * tamanho * 1.3}" font-size="${tamanho}" fill="#f2f3f5">${esc(l)}</text>`).join('\n')}
</g></svg>`;
    const camadas = [];
    try {
        const mascara = Buffer.from(`<svg width="${AV}" height="${AV}"><circle cx="${AV / 2}" cy="${AV / 2}" r="${AV / 2}"/></svg>`);
        const avatar = await s(await baixar(avatarUrl, 4 * 1024 * 1024)).resize(AV, AV).composite([{ input: mascara, blend: 'dest-in' }]).png().toBuffer();
        camadas.push({ input: avatar, left: PAD, top: PAD });
    } catch { /* sem avatar, só o texto */ }
    return s(Buffer.from(svg)).composite(camadas).png().toBuffer();
}
