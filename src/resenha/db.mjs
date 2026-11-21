// Banco próprio dos comandos de resenha do Anti Janja (lembretes, canal de avisos, foto da retrospectiva).
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const BASE = process.env.BOTS_DIR || '/home/u243267678/domains/mrbnexus.com.br';
const arquivo = process.env.RESENHA_DB || `${BASE}/antijanja-data/resenha.sqlite`;
fs.mkdirSync(path.dirname(path.resolve(arquivo)), { recursive: true });

const db = new Database(arquivo);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.exec('CREATE TABLE IF NOT EXISTS estado (chave TEXT PRIMARY KEY, valor TEXT)');

export const getEstado = chave => db.prepare('SELECT valor FROM estado WHERE chave = ?').get(chave)?.valor ?? null;
export const setEstado = (chave, valor) => db.prepare(
    'INSERT INTO estado (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor').run(chave, String(valor));

export default db;
