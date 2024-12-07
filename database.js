const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Caminho do banco de dados SQLite
const dbPath = path.join(__dirname, 'candles.db');

// Criar ou abrir o banco de dados
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("Erro ao abrir o banco de dados:", err.message);
    } else {
        console.log("Conectado ao banco de dados SQLite.");
        // Criar tabela de velas se não existir
        db.run(`CREATE TABLE IF NOT EXISTS candles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT,
            openTime TEXT,
            open REAL,
            high REAL,
            low REAL,
            close REAL,
            volume REAL,
            closeTime TEXT,
            quoteAssetVolume REAL,
            numberOfTrades INTEGER,
            takerBuyBaseAssetVolume REAL,
            takerBuyQuoteAssetVolume REAL
        )`, (err) => {
            if (err) {
                console.error("Erro ao criar a tabela:", err.message);
            } else {
                console.log("Tabela 'candles' criada ou já existe.");
            }
        });
    }
});

module.exports = db;
