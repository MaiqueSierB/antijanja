// Gym Rats do Regresso: 1 check-in por dia (com foto) = 1 ponto. Ranking mensal, sequência 🔥, campeão do mês.
// Banco próprio (gym-data/gym.sqlite), compartilhado com o Zap e o Portal. Pessoa = id do Discord.
// As fotos ficam salvas no servidor (o link do Discord expira), redimensionadas.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { BASE } from './db.mjs';

const PASTA = process.env.GYM_DIR || `${BASE}/gym-data`;
export const FOTOS = path.join(PASTA, 'fotos');
fs.mkdirSync(FOTOS, { recursive: true });

const db = new Database(path.join(PASTA, 'gym.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS checkins (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,          -- id do Discord
    nome    TEXT,
    dia     TEXT NOT NULL,          -- AAAA-MM-DD (Brasília)
    quando  TEXT NOT NULL DEFAULT (datetime('now')),
    foto    TEXT,                   -- arquivo em gym-data/fotos
    legenda TEXT,
    origem  TEXT,                   -- discord | zap
    UNIQUE (user_id, dia)
  );
  CREATE TABLE IF NOT EXISTS estado (chave TEXT PRIMARY KEY, valor TEXT);
`);

export const hoje = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const mesDe = dia => dia.slice(0, 7);
const ontem = dia => { const d = new Date(`${dia}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const nomeMes = mes => `${MESES[Number(mes.slice(5, 7)) - 1]} de ${mes.slice(0, 4)}`;

async function salvarFoto(buffer) {
    const { default: sharp } = await import('sharp');
    sharp.concurrency(1);
    const arquivo = `${hoje()}-${crypto.randomBytes(6).toString('hex')}.jpg`;
    await sharp(buffer, { animated: false }).rotate().resize({ width: 1080, height: 1080, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 }).toFile(path.join(FOTOS, arquivo));
    return arquivo;
}

// Dias seguidos com treino, terminando hoje (ou ontem, se ainda não treinou hoje)
export function sequencia(userId, dia = hoje()) {
    const dias = new Set(db.prepare('SELECT dia FROM checkins WHERE user_id = ?').all(userId).map(r => r.dia));
    let d = dias.has(dia) ? dia : ontem(dia);
    let n = 0;
    while (dias.has(d)) { n++; d = ontem(d); }
    return n;
}

export function rankingMes(mes = mesDe(hoje())) {
    return db.prepare(`SELECT user_id, MAX(nome) AS nome, COUNT(*) AS pontos, MAX(dia) AS ultimo
        FROM checkins WHERE substr(dia, 1, 7) = ? GROUP BY user_id ORDER BY pontos DESC, ultimo ASC`).all(mes)
        .map((r, i) => ({ ...r, posicao: i + 1, sequencia: sequencia(r.user_id) }));
}

// Registra o treino do dia. Devolve { ok, motivo?, checkin, pontos, posicao, sequencia }
export async function registrar({ userId, nome, foto, legenda, origem }) {
    const dia = hoje();
    if (db.prepare('SELECT 1 FROM checkins WHERE user_id = ? AND dia = ?').get(userId, dia)) {
        return { ok: false, motivo: 'Você já marcou o treino de hoje. Amanhã tem mais! 💪' };
    }
    const arquivo = foto ? await salvarFoto(foto) : null;
    const id = db.prepare('INSERT INTO checkins (user_id, nome, dia, foto, legenda, origem) VALUES (?, ?, ?, ?, ?, ?)')
        .run(userId, nome, dia, arquivo, (legenda || '').slice(0, 200) || null, origem).lastInsertRowid;
    const ranking = rankingMes();
    const eu = ranking.find(r => r.user_id === userId);
    return { ok: true, id, arquivo, pontos: eu.pontos, posicao: eu.posicao, total: ranking.length, sequencia: eu.sequencia };
}

export function apagarHoje(userId) {
    const c = db.prepare('SELECT * FROM checkins WHERE user_id = ? AND dia = ?').get(userId, hoje());
    if (!c) return false;
    db.prepare('DELETE FROM checkins WHERE id = ?').run(c.id);
    if (c.foto) fs.rmSync(path.join(FOTOS, c.foto), { force: true });
    return true;
}

// Campeão do mês que acabou: uma vez, no dia 1 a partir das 9h
export function campeaoPendente(agora = new Date()) {
    const dia = hoje(agora);
    const hora = Number(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }));
    if (!dia.endsWith('-01') || hora < 9) return null;
    const mesPassado = mesDe(ontem(dia));
    if (db.prepare('SELECT 1 FROM estado WHERE chave = ?').get(`campeao_${mesPassado}`)) return null;
    db.prepare('INSERT OR REPLACE INTO estado (chave, valor) VALUES (?, ?)').run(`campeao_${mesPassado}`, dia);
    const ranking = rankingMes(mesPassado);
    return ranking.length ? { mes: mesPassado, ranking } : null;
}
