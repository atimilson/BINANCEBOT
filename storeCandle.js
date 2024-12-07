const db = require('./database');

// Função para armazenar uma vela
function storeCandle(candleData) {
    const sql = `INSERT INTO candles (symbol, openTime, open, high, low, close, volume, closeTime, 
                 quoteAssetVolume, numberOfTrades, takerBuyBaseAssetVolume, takerBuyQuoteAssetVolume) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    db.run(sql, [
        candleData.symbol,
        candleData.openTime,
        candleData.open,
        candleData.high,
        candleData.low,
        candleData.close,
        candleData.volume,
        candleData.closeTime,
        candleData.quoteAssetVolume,
        candleData.numberOfTrades,
        candleData.takerBuyBaseAssetVolume,
        candleData.takerBuyQuoteAssetVolume
    ], function(err) {
        if (err) {
            console.error("Erro ao armazenar a vela:", err.message);
        } else {
            console.log("Vela armazenada com sucesso com ID:", this.lastID);
        }
    });
}

// Exemplo de vela a ser armazenada
const exampleCandle = {
    symbol: 'ETHUSDT',
    openTime: '2024-12-06T15:12:00Z',
    open: 4056.33,
    high: 4056.33,
    low: 4052.61,
    close: 4052.62,
    volume: 102.02,
    closeTime: '2024-12-06T15:12:59Z',
    quoteAssetVolume: 413686.21,
    numberOfTrades: 1476,
    takerBuyBaseAssetVolume: 41.51,
    takerBuyQuoteAssetVolume: 168306.69,
};

// Chamar a função para armazenar a vela
storeCandle(exampleCandle);
