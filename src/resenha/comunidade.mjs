// Recursos "de grupo" iguais aos do Zap, para o Discord:
//  - lembretes (/lembrar, /lembretes, /cancelarlembrete) com o mesmo jeito de escrever a data
//  - jogos grátis da Epic (/gratis e aviso automático no canal de avisos)
//  - retrospectiva semanal (domingo 20h no canal de avisos)
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import db, { getEstado, setEstado, BASE } from './db.mjs';

db.exec(`
  CREATE TABLE IF NOT EXISTS lembretes (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    canal   TEXT NOT NULL,
    autor   TEXT NOT NULL,
    texto   TEXT NOT NULL,
    quando  INTEGER NOT NULL,         -- epoch ms
    enviado INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS retro_foto (chave TEXT PRIMARY KEY, valor INTEGER);
`);

// ---------- Canal de avisos (Epic + retrospectiva) ----------
export const canalAvisos = () => getEstado('canal_avisos');
export const definirCanalAvisos = id => setEstado('canal_avisos', id);

// ---------- Lembretes ----------
const DIAS = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 };
const MAX_PENDENTES = 10;
const MAX_DIAS = 60;
const semAcento = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Mesmo intérprete do Zap. Devolve { quando: Date, texto } ou null.
export function interpretar(entrada, agora = new Date()) {
    let resto = entrada.trim();
    const tira = re => { const m = semAcento(resto).match(re); if (m) resto = resto.slice(m[0].length).trim(); return m; };

    const rel = tira(/^(?:(?:em|daqui(?: a)?)\s+)?(\d{1,4})\s*(min|minutos?|m)\b/) ||
        tira(/^(?:em|daqui(?: a)?)\s+(\d{1,3})\s*(h|horas?)\b/);
    if (rel) {
        const n = Number(rel[1]);
        const ms = rel[2].startsWith('h') ? n * 3_600_000 : n * 60_000;
        return resto ? { quando: new Date(agora.getTime() + ms), texto: resto } : null;
    }

    const data = new Date(agora);
    let diaDefinido = false;
    let m;
    if ((m = tira(/^depois de amanha\b/))) { data.setDate(data.getDate() + 2); diaDefinido = true; }
    else if ((m = tira(/^amanha\b/))) { data.setDate(data.getDate() + 1); diaDefinido = true; }
    else if ((m = tira(/^hoje\b/))) { diaDefinido = true; }
    else if ((m = tira(/^(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:-feira)?\b/))) {
        let delta = (DIAS[m[1]] - data.getDay() + 7) % 7;
        if (delta === 0) delta = 7;
        data.setDate(data.getDate() + delta); diaDefinido = true;
    } else if ((m = tira(/^(\d{1,2})\/(\d{1,2})\b/))) {
        data.setMonth(Number(m[2]) - 1, Number(m[1]));
        if (data < agora) data.setFullYear(data.getFullYear() + 1);
        diaDefinido = true;
    }

    tira(/^(?:as|a)\s+/);
    const h = tira(/^(\d{1,2})(?:h(\d{2})?|:(\d{2}))(?:min)?\b/);
    if (!h && !diaDefinido) return null;
    const hora = h ? Number(h[1]) : 9;
    const minuto = h ? Number(h[2] ?? h[3] ?? 0) : 0;
    if (hora > 23 || minuto > 59) return null;
    data.setHours(hora, minuto, 0, 0);
    if (!diaDefinido && data <= agora) data.setDate(data.getDate() + 1);
    if (data <= agora || !resto) return null;
    return { quando: data, texto: resto.slice(0, 200) };
}

const ts = d => `<t:${Math.floor(d.getTime() / 1000)}:f>`;
const AJUDA_LEMBRETE = '⏰ Escreva no campo: `<quando> <o quê>`\n\nQuando pode ser:\n• 20h (hoje)\n• amanhã 9h\n• sexta 20h30\n• 25/12 10h\n• 30min\n• em 2h';

export function lembrar(arg, autor, canal) {
    const r = interpretar(arg ?? '');
    if (!r) return { ok: false, texto: AJUDA_LEMBRETE };
    if (r.quando.getTime() - Date.now() > MAX_DIAS * 86_400_000) return { ok: false, texto: `Só consigo lembrar até ${MAX_DIAS} dias pra frente.` };
    const pendentes = db.prepare('SELECT COUNT(*) AS n FROM lembretes WHERE autor = ? AND enviado = 0').get(autor).n;
    if (pendentes >= MAX_PENDENTES) return { ok: false, texto: `Você já tem ${MAX_PENDENTES} lembretes. Cancele algum com /cancelarlembrete.` };
    const id = db.prepare('INSERT INTO lembretes (canal, autor, texto, quando) VALUES (?, ?, ?, ?)')
        .run(canal, autor, r.texto, r.quando.getTime()).lastInsertRowid;
    return { ok: true, texto: `✅ Lembrete #${id} marcado pra ${ts(r.quando)}: ${r.texto}` };
}

export function listarLembretes(autor) {
    const l = db.prepare('SELECT * FROM lembretes WHERE autor = ? AND enviado = 0 ORDER BY quando').all(autor);
    return l.length ? '⏰ **Seus lembretes**\n' + l.map(x => `#${x.id} — ${ts(new Date(x.quando))}: ${x.texto}`).join('\n') +
        '\n\nPra cancelar: `/cancelarlembrete numero: 12`' : 'Você não tem lembretes marcados.';
}

export function cancelarLembrete(id, autor) {
    const r = db.prepare('UPDATE lembretes SET enviado = 2 WHERE id = ? AND autor = ? AND enviado = 0').run(id, autor);
    return r.changes ? `🗑️ Lembrete #${id} cancelado.` : 'Não achei esse lembrete entre os seus.';
}

// A cada 20 s: manda os vencidos no canal onde foram criados, marcando quem pediu
export async function enviarLembretes(client) {
    const vencidos = db.prepare('SELECT * FROM lembretes WHERE enviado = 0 AND quando <= ? ORDER BY quando').all(Date.now());
    for (const l of vencidos) {
        const canal = await client.channels.fetch(l.canal).catch(() => null);
        if (canal?.isTextBased()) {
            const ok = await canal.send({ content: `⏰ **Lembrete** de <@${l.autor}>: ${l.texto}`, allowedMentions: { users: [l.autor] } })
                .then(() => true).catch(e => { console.error('Lembrete:', e.message); return false; });
            if (!ok) continue;
        }
        db.prepare('UPDATE lembretes SET enviado = 1 WHERE id = ?').run(l.id);
    }
}

// ---------- Jogos grátis da Epic ----------
const EPIC = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=pt-BR&country=BR&allowCountries=BR';

export async function buscarGratis(agora = Date.now()) {
    const res = await fetch(EPIC, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Epic respondeu ${res.status}`);
    const itens = (await res.json())?.data?.Catalog?.searchStore?.elements || [];
    return itens.flatMap(el => {
        const promo = (el.promotions?.promotionalOffers || []).flatMap(p => p.promotionalOffers || [])
            .find(o => Date.parse(o.startDate) <= agora && agora < Date.parse(o.endDate));
        if (!promo || el.price?.totalPrice?.discountPrice !== 0) return [];
        const slug = el.catalogNs?.mappings?.[0]?.pageSlug || el.offerMappings?.[0]?.pageSlug || el.productSlug;
        const imagem = (el.keyImages || []).find(i => i.type === 'OfferImageWide') || (el.keyImages || []).find(i => i.type === 'Thumbnail');
        return [{
            id: el.id, titulo: el.title, fim: promo.endDate, imagem: imagem?.url,
            link: slug ? `https://store.epicgames.com/pt-BR/p/${slug.replace(/\/home$/, '')}` : 'https://store.epicgames.com/pt-BR/free-games'
        }];
    });
}

export const embedGratis = g => ({
    color: 0x2a2a2a, title: `🎁 Grátis na Epic: ${g.titulo}`, url: g.link,
    description: `Resgata até <t:${Math.floor(Date.parse(g.fim) / 1000)}:f>`,
    ...(g.imagem ? { image: { url: g.imagem } } : {})
});

export async function verificarEpic(client) {
    const id = canalAvisos();
    const hora = new Date().getHours();
    if (!id || hora < 9 || hora >= 22) return;
    const canal = await client.channels.fetch(id).catch(() => null);
    if (!canal?.isTextBased()) return;
    for (const g of await buscarGratis()) {
        const chave = `epic_${g.id}_${g.fim}`;
        if (getEstado(chave)) continue;
        await canal.send({ embeds: [embedGratis(g)] });
        setEstado(chave, new Date().toISOString());
        console.log(`🎁 Jogo grátis avisado no Discord: ${g.titulo}`);
    }
}

// ---------- Retrospectiva semanal (mesmo conteúdo da do Zap) ----------
const CAMINHOS = {
    bolao: process.env.BOLAO_DB || `${BASE}/bolao-data/bolao.sqlite`,
    rmdb: process.env.RMDB_DB || `${BASE}/rmdb-data/servidor.sqlite`,
    rgdb: process.env.RGDB_DB || `${BASE}/rgdb-data/servidor.sqlite`,
    aniv: process.env.ANIV_DB || `${BASE}/aniversario-data/servidor.sqlite`
};
const abertos = {};
function outro(nome) {
    if (abertos[nome] !== undefined) return abertos[nome];
    try {
        abertos[nome] = fs.existsSync(CAMINHOS[nome]) ? new Database(path.resolve(CAMINHOS[nome]), { readonly: true, fileMustExist: true }) : null;
        abertos[nome]?.pragma('busy_timeout = 5000');
    } catch (e) {
        console.error(`Retrospectiva: não abri ${nome}:`, e.message);
        abertos[nome] = null;
    }
    return abertos[nome];
}
const todos = (nome, sql, ...a) => outro(nome)?.prepare(sql).all(...a) ?? [];

function contadoresAtuais() {
    const c = new Map();
    for (const r of todos('rmdb', 'SELECT movie_id AS id, vote_count AS n FROM avaliacoes_filmes')) c.set(`f:${r.id}`, r.n);
    for (const r of todos('rgdb', 'SELECT game_id AS id, vote_count AS n FROM avaliacoes_jogos')) c.set(`j:${r.id}`, r.n);
    for (const r of todos('rmdb', 'SELECT user_id AS id, COUNT(*) AS n FROM votos_filmes GROUP BY user_id')) c.set(`uf:${r.id}`, r.n);
    for (const r of todos('rgdb', 'SELECT user_id AS id, COUNT(*) AS n FROM votos_jogos GROUP BY user_id')) c.set(`uj:${r.id}`, r.n);
    return c;
}
const fotoAnterior = () => new Map(db.prepare('SELECT chave, valor FROM retro_foto').all().map(r => [r.chave, r.valor]));
function salvarFoto(c) {
    db.transaction(() => {
        db.prepare('DELETE FROM retro_foto').run();
        const ins = db.prepare('INSERT INTO retro_foto (chave, valor) VALUES (?, ?)');
        for (const [k, v] of c) ins.run(k, v);
    })();
}
function novidades(atual, antes, prefixo) {
    return [...atual].filter(([k]) => k.startsWith(prefixo))
        .map(([k, v]) => ({ id: k.slice(prefixo.length), novos: v - (antes.get(k) ?? 0) }))
        .filter(x => x.novos > 0).sort((a, c) => c.novos - a.novos);
}
const fmt = n => Number(n).toFixed(1);
const medalha = i => ['🥇', '🥈', '🥉'][i] ?? `${i + 1}.`;

export function montarRetro() {
    const atual = contadoresAtuais();
    const antes = fotoAnterior();
    const partes = ['📰 **Retrospectiva da semana no Regresso**'];
    const info = (nome, tabela, col, id) => outro(nome)?.prepare(`SELECT title, server_score FROM ${tabela} WHERE ${col} = ?`).get(id);

    const filmes = novidades(atual, antes, 'f:').map(x => ({ ...x, ...info('rmdb', 'avaliacoes_filmes', 'movie_id', x.id) })).filter(x => x.title);
    if (filmes.length) {
        const melhor = [...filmes].sort((a, c) => c.server_score - a.server_score)[0];
        partes.push(`🎬 **Filmes e séries:** ${filmes.length} avaliado(s) — destaque: **${melhor.title}** (⭐ ${fmt(melhor.server_score)})\n` +
            filmes.slice(0, 5).map(f => `• ${f.title} — ⭐ ${fmt(f.server_score)} (+${f.novos} voto${f.novos > 1 ? 's' : ''})`).join('\n'));
    }
    const jogos = novidades(atual, antes, 'j:').map(x => ({ ...x, ...info('rgdb', 'avaliacoes_jogos', 'game_id', x.id) })).filter(x => x.title);
    if (jogos.length) {
        partes.push(`🎮 **Games:** ${jogos.length} avaliado(s)\n` + jogos.slice(0, 5).map(g => `• ${g.title} — ⭐ ${fmt(g.server_score)} (+${g.novos})`).join('\n'));
    }
    const porPessoa = new Map();
    for (const x of [...novidades(atual, antes, 'uf:'), ...novidades(atual, antes, 'uj:')]) porPessoa.set(x.id, (porPessoa.get(x.id) ?? 0) + x.novos);
    const criticos = [...porPessoa].sort((a, c) => c[1] - a[1]).slice(0, 3);
    if (criticos.length) partes.push('🏅 **Quem mais avaliou:** ' + criticos.map(([id, n], i) => `${medalha(i)} <@${id}> (${n})`).join('  '));

    const desde = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const bolao = todos('bolao', `
        SELECT p.user_id, SUM(p.pontos) AS pontos, SUM(CASE WHEN p.pontos = 25 THEN 1 ELSE 0 END) AS exatos
        FROM palpites p JOIN jogos j ON j.id = p.jogo_id
        WHERE j.status = 'FINISHED' AND j.data_utc >= ? AND p.pontos IS NOT NULL
        GROUP BY p.user_id ORDER BY pontos DESC, exatos DESC LIMIT 5`, desde);
    if (bolao.length) partes.push('⚽ **Bolão na semana:**\n' + bolao.map((r, i) => `${medalha(i)} <@${r.user_id}> — ${r.pontos} pts${r.exatos ? ` (${r.exatos} na mosca)` : ''}`).join('\n'));

    const dias = [];
    for (let i = 1; i <= 7; i++) {
        const x = new Date(Date.now() + i * 86_400_000);
        dias.push(`${String(x.getDate()).padStart(2, '0')}-${String(x.getMonth() + 1).padStart(2, '0')}`);
    }
    const aniv = todos('aniv', `SELECT user_id, birthday FROM birthdays WHERE birthday IN (${dias.map(() => '?').join(',')})`, ...dias)
        .sort((a, b) => dias.indexOf(a.birthday) - dias.indexOf(b.birthday));
    if (aniv.length) partes.push('🎂 **Aniversários da semana que vem:** ' + aniv.map(a => `<@${a.user_id}> (${a.birthday.replace('-', '/')})`).join(', '));

    if (partes.length === 1) partes.push('Semana parada por aqui... bora avaliar uns filmes e jogos! 😴');
    return { texto: partes.join('\n\n'), atual };
}

export async function verificarRetro(client) {
    const id = canalAvisos();
    if (!id) return;
    if (!getEstado('retro_inicio')) {           // primeira vez: só tira a "foto" da semana
        salvarFoto(contadoresAtuais());
        setEstado('retro_inicio', new Date().toISOString());
        return;
    }
    const agora = new Date();
    if (agora.getDay() !== 0 || agora.getHours() < 20) return;
    const chave = `retro_${agora.getFullYear()}-${agora.getMonth() + 1}-${agora.getDate()}`;
    if (getEstado(chave)) return;
    const canal = await client.channels.fetch(id).catch(() => null);
    if (!canal?.isTextBased()) return;
    setEstado(chave, agora.toISOString());
    const { texto, atual } = montarRetro();
    // Menções só aparecem como nome; ninguém é notificado
    await canal.send({ content: texto.slice(0, 2000), allowedMentions: { parse: [] } });
    salvarFoto(atual);
    console.log('📰 Retrospectiva semanal postada no Discord.');
}
