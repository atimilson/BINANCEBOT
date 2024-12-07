const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { zonedTimeToUtc, format } = require('date-fns-tz');
const { mean, std } = require('mathjs');
const ta = require('technicalindicators'); // Para indicadores técnicos
const fs = require('fs');
const { Spot } = require('@binance/connector');
const config = require('./config.js'); // Arquivo com suas credenciais

// Inicializar cliente Binance
const client = new Spot(
    config.apiKey,
    config.apiSecret,
    {
        baseURL: 'https://api.binance.com'
    }
);

// Configurar o caminho do banco de dados SQLite
const dbPath = path.join(__dirname, 'candles.db');
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

        // Criar nova tabela para armazenar sinais e resultados
        db.run(`CREATE TABLE IF NOT EXISTS signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT,
            symbol TEXT,
            signal_type TEXT,
            entry_price REAL,
            stop_loss REAL,
            take_profit REAL,
            exit_price REAL,
            exit_timestamp TEXT,
            result TEXT,
            profit_loss REAL,
            score REAL,
            indicators JSON
        )`);
    }
});

// Configurando o WebSocket para se conectar à Binance
const symbol = 'ethusdt'; // Mantenha o par em letras minúsculas
const interval = '15m'; // Intervalo de vela desejado

const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol}@kline_${interval}`);

ws.on('open', () => {
    console.log('Conectado ao WebSocket da Binance');
});

ws.on('message', (data) => {
    const klineData = JSON.parse(data);

    // Verifica se é um evento de kline
    if (klineData.e === 'kline' && klineData.k) {
        const kline = klineData.k;

        // Converte os timestamps para o fuso horário de Cuiabá (UTC-4)
        const openTimeUTC = new Date(kline.t);
        const closeTimeUTC = new Date(kline.T);

        const openTimeCuiaba = format(openTimeUTC, "yyyy-MM-dd'T'HH:mm:ssXXX", { timeZone: 'America/Cuiaba' });
        const closeTimeCuiaba = format(closeTimeUTC, "yyyy-MM-dd'T'HH:mm:ssXXX", { timeZone: 'America/Cuiaba' });

        // Estruturar os dados da vela com horários convertidos
        const candleData = {
            symbol: kline.s,
            openTime: openTimeCuiaba,
            open: parseFloat(kline.o),
            high: parseFloat(kline.h),
            low: parseFloat(kline.l),
            close: parseFloat(kline.c),
            volume: parseFloat(kline.v),
            closeTime: closeTimeCuiaba,
            quoteAssetVolume: parseFloat(kline.q),
            numberOfTrades: kline.n,
            takerBuyBaseAssetVolume: parseFloat(kline.V),
            takerBuyQuoteAssetVolume: parseFloat(kline.Q),
        };

        // Armazenar a vela no banco de dados
        storeCandle(candleData);
        
        // Analisar a tendência das últimas velas
        analyzeTrend(kline.s, candleData.closeTime);
    }
});

ws.on('error', (error) => {
    console.error('Erro no WebSocket:', error);
});

ws.on('close', () => {
    console.log('WebSocket fechado');
});

// Função para armazenar uma vela no SQLite
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
            console.log("Vela armazenada com sucesso:", candleData);
        }
    });
}

// Função auxiliar para calcular PPO
function calculatePPO(values, fastPeriod, slowPeriod, signalPeriod) {
    const fastEMA = ta.ema({ values, period: fastPeriod });
    const slowEMA = ta.ema({ values, period: slowPeriod });
    
    // Calcula PPO line
    const ppoLine = fastEMA.map((fast, i) => {
        if (i < slowEMA.length) {
            return ((fast - slowEMA[i]) / slowEMA[i]) * 100;
        }
        return 0;
    }).slice(slowPeriod - 1);

    // Calcula Signal line
    const signalLine = ta.ema({ 
        values: ppoLine, 
        period: signalPeriod 
    });

    // Calcula Histogram
    const histogram = ppoLine.map((ppo, i) => {
        if (i < signalLine.length) {
            return ppo - signalLine[i];
        }
        return 0;
    }).slice(signalPeriod - 1);

    return {
        ppo: ppoLine.slice(-1)[0],
        signal: signalLine.slice(-1)[0],
        histogram: histogram.slice(-1)[0]
    };
}

// Função auxiliar para calcular Williams %R manualmente
function calculateWilliamsR(highs, lows, closes, period) {
    try {
        const williamsR = [];
        
        for (let i = period - 1; i < closes.length; i++) {
            const highestHigh = Math.max(...highs.slice(i - period + 1, i + 1));
            const lowestLow = Math.min(...lows.slice(i - period + 1, i + 1));
            const currentClose = closes[i];
            
            // Fórmula do Williams %R: ((Highest High - Close)/(Highest High - Lowest Low)) * -100
            const r = ((highestHigh - currentClose) / (highestHigh - lowestLow)) * -100;
            williamsR.push(r);
        }
        
        return williamsR.length > 0 ? williamsR[williamsR.length - 1] : null;
    } catch (error) {
        console.error('Erro ao calcular Williams %R:', error);
        return null;
    }
}

// Função para analisar a tendência das últimas velas e prever o próximo fechamento
function analyzeTrend(symbol, currentCloseTime, params = {
    rsiPeriod: 14,
    emaShortPeriod: 10,
    emaLongPeriod: 20,
    ema50Period: 50,
    ema200Period: 200,
    adxPeriod: 14,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    cciPeriod: 20,
    atrPeriod: 14,
    volumeMA: 20,
    stochPeriod: 14,
    stochSignal: 3,
    mfiPeriod: 14,
    ichimokuTenkan: 9,
    ichimokuKijun: 26,
    vwapPeriod: 14,
    ppoFast: 12,
    ppoSlow: 26,
    ppoSignal: 9,
    williamsRPeriod: 14,
    aoFastPeriod: 5,
    aoSlowPeriod: 34,
    ichimokuSettings: {
        conversionPeriod: 9,
        basePeriod: 26,
        spanPeriod: 52,
        displacement: 26
    }
}) {
    const thirtyMinutesAgo = format(
        new Date(new Date(currentCloseTime).getTime() - 30 * 60 * 1000).toISOString(),
        "yyyy-MM-dd'T'HH:mm:ssXXX",
        { timeZone: 'America/Cuiaba' }
    );

    console.log(thirtyMinutesAgo);

    const sql = `SELECT close, open, high, low, volume FROM candles WHERE symbol = ? AND closeTime >= ? ORDER BY closeTime DESC LIMIT 50`;

    db.all(sql, [symbol, thirtyMinutesAgo], (err, rows) => {
        if (err) {
            console.error("Erro ao buscar velas:", err.message);
            return;
        }

        console.log(rows.length);
        if (rows.length < 5) {
            console.log("Não há velas suficientes para análise.");
            return;
        }

        const closes = rows.map(row => row.close);
        const opens = rows.map(row => row.open);
        const highs = rows.map(row => row.high);
        const lows = rows.map(row => row.low);
        const lastClose = closes[0];

        // Cálculo de indicadores técnicos
        const rsi = ta.rsi({ values: closes, period: 14 })[0];
        const currentEMA10 = ta.ema({ values: closes, period: 10 }).slice(-1)[0];
        const currentEMA20 = ta.ema({ values: closes, period: 20 }).slice(-1)[0];
        const supportLevel = Math.min(...lows.slice(0, 5));
        const resistanceLevel = Math.max(...highs.slice(0, 5));
        
        const bb = ta.bollingerbands({ values: closes, period: 20, stdDev: 2 });
        // const upperBand = bb[bb.length - 1].upper;
        // const lowerBand = bb[bb.length - 1].lower;

        // Retrocessos de Fibonacci
        const maxHigh = Math.max(...highs);
        const minLow = Math.min(...lows);
        const diff = maxHigh - minLow;
        const fibLevels = [
            maxHigh,
            maxHigh - diff * 0.236,
            maxHigh - diff * 0.382,
            maxHigh - diff * 0.618,
            minLow,
        ];
        const ema50 = ta.ema({ values: closes, period: 50 }).slice(-1)[0];
        const ema200 = ta.ema({ values: closes, period: 200 }).slice(-1)[0];
        const adx = ta.adx({ high: highs, low: lows, close: closes, period: 14 })[0];
        const [macdLine, signalLine, macdHistogram] = ta.macd({ values: closes, fastPeriod: params.macdFast, slowPeriod: params.macdSlow, signalPeriod: params.macdSignal });
        const cci = ta.cci({ high: highs, low: lows, close: closes, period: params.cciPeriod })[0];

        // Determine a direção da tendência
        let trend = "Lateral";
        if (lastClose > currentEMA20) {
            trend = "Alta";
        } else if (lastClose < currentEMA20) {
            trend = "Baixa";
        }

        // Condições de entrada
        let entryPoints = [];
        let buySignal = false;
        let sellSignal = false;

        // Novo: Sistema de pontuação
        let scoreCompra = 0;
        let scoreVenda = 0;

        // Novo: Cálculo de ATR para volatilidade
        const atr = ta.atr({
            high: highs,
            low: lows,
            close: closes,
            period: params.atrPeriod
        }).slice(-1)[0];

        // Novo: Média do volume
        const volumes = rows.map(row => row.volume);
        const volumeMA = ta.sma({
            values: volumes,
            period: params.volumeMA
        }).slice(-1)[0];
        const currentVolume = volumes[0];

        // Análise de RSI com pontuação
        if (rsi > 70) {
            scoreVenda += 2;
        } else if (rsi < 30) {
            scoreCompra += 2;
        }

        // Análise de EMA com confirmação de volume
        if (currentEMA10 > currentEMA20 && lastClose > currentEMA10) {
            if (currentVolume > volumeMA) {
                scoreCompra += 2;
            } else {
                scoreCompra += 1;
            }
        } else if (currentEMA10 < currentEMA20 && lastClose < currentEMA10) {
            if (currentVolume > volumeMA) {
                scoreVenda += 2;
            } else {
                scoreVenda += 1;
            }
        }

        // Novo: Filtro de volatilidade usando ATR
        const volatilityThreshold = atr * 2;
        const isHighVolatility = (highs[0] - lows[0]) > volatilityThreshold;

        // Análise de tendência com ADX
        if (adx > 25) {
            if (currentEMA10 > currentEMA20) {
                scoreCompra += 1;
            } else {
                scoreVenda += 1;
            }
        }

        // Novo: Stop Loss e Take Profit dinâmicos baseados no ATR
        const stopLoss = lastClose - (atr * 1.5);
        const takeProfit = lastClose + (atr * 2);

        // Novos indicadores
        const stoch = ta.Stochastic.calculate({
            high: highs,
            low: lows,
            close: closes,
            period: params.stochPeriod,
            signalPeriod: params.stochSignal
        });
        
        const mfi = ta.mfi({
            high: highs,
            low: lows,
            close: closes,
            volume: volumes,
            period: params.mfiPeriod
        });

        const ppoValues = calculatePPO(
            closes, 
            params.ppoFast, 
            params.ppoSlow, 
            params.ppoSignal
        );

        // Cálculo do VWAP
        const typicalPrices = closes.map((close, i) => (highs[i] + lows[i] + close) / 3);
        const vwap = ta.sma({
            values: typicalPrices.map((tp, i) => tp * volumes[i]),
            period: params.vwapPeriod
        }).map((sum, i) => sum / ta.sma({ values: volumes, period: params.vwapPeriod })[i]);

        // Análise Estocástica
        if (stoch && stoch.length > 0) {
            const currentStoch = stoch[stoch.length - 1];
            
            if (currentStoch.k < 20 && currentStoch.k > currentStoch.d) {
                scoreCompra += 1.5;
            } else if (currentStoch.k > 80 && currentStoch.k < currentStoch.d) {
                scoreVenda += 1.5;
            }
        }

        // Análise MFI (Money Flow Index)
        const currentMFI = mfi[mfi.length - 1];
        if (currentMFI < 20) {
            scoreCompra += 1;
        } else if (currentMFI > 80) {
            scoreVenda += 1;
        }

        // Análise PPO (Percentage Price Oscillator)
        if (ppoValues.ppo > ppoValues.signal) {
            scoreCompra += 1;
        } else {
            scoreVenda += 1;
        }

        // Análise VWAP
        const currentVWAP = vwap[vwap.length - 1];
        if (lastClose > currentVWAP) {
            scoreCompra += 1;
        } else {
            scoreVenda += 1;
        }

        // Confirmação de Volume Adicional
        const volumeChange = ((volumes[0] - volumes[1]) / volumes[1]) * 100;
        if (volumeChange > 20) {
            if (closes[0] > opens[0]) {
                scoreCompra += 1;
            } else {
                scoreVenda += 1;
            }
        }

        // Análise de Momentum
        const momentum = ta.roc({
            values: closes,
            period: 10
        }).slice(-1)[0];

        if (momentum > 0) {
            scoreCompra += 0.5;
        } else {
            scoreVenda += 0.5;
        }

        // Novo: Williams %R
        const currentWilliamsR = calculateWilliamsR(
            highs,
            lows,
            closes,
            params.williamsRPeriod
        );

        // Análise do Williams %R
        if (currentWilliamsR !== null) {
            if (currentWilliamsR < -80) {
                scoreCompra += 1.5;
                console.log('Sinal de compra do Williams %R:', currentWilliamsR);
            } else if (currentWilliamsR > -20) {
                scoreVenda += 1.5;
                console.log('Sinal de venda do Williams %R:', currentWilliamsR);
            }
        }

        // Novo: On-Balance Volume (OBV)
        const obv = calculateOBV(closes, volumes);
        const obvMA = ta.sma({
            values: obv,
            period: 20
        }).slice(-1)[0];

        // Novo: Awesome Oscillator
        const ao = calculateAO(highs, lows, params.aoFastPeriod, params.aoSlowPeriod);
        const currentAO = ao[ao.length - 1];
        const previousAO = ao[ao.length - 2];

        // Novo: Elder Ray Index
        const elderRay = calculateElderRay(highs, lows, closes);

        // Novo: Ichimoku Cloud
        const ichimoku = calculateIchimoku(
            highs,
            lows,
            params.ichimokuSettings
        );

        // Análise dos novos indicadores
        // Williams %R
        if (currentWilliamsR !== null) {
            if (currentWilliamsR < -80) {
                scoreCompra += 1.5;
            } else if (currentWilliamsR > -20) {
                scoreVenda += 1.5;
            }
        }

        // OBV
        if (obv[obv.length - 1] > obvMA) {
            scoreCompra += 1;
        } else {
            scoreVenda += 1;
        }

        // Awesome Oscillator
        if (currentAO > 0 && previousAO < 0) {
            scoreCompra += 2; // Cruzamento de zero para cima
        } else if (currentAO < 0 && previousAO > 0) {
            scoreVenda += 2; // Cruzamento de zero para baixo
        }

        // Elder Ray
        if (elderRay.bullPower > 0 && elderRay.bearPower < 0) {
            scoreCompra += 1;
        } else if (elderRay.bullPower < 0 && elderRay.bearPower > 0) {
            scoreVenda += 1;
        }

        // Ichimoku Cloud
        if (lastClose > ichimoku.senkou_span_a && lastClose > ichimoku.senkou_span_b) {
            scoreCompra += 2;
        } else if (lastClose < ichimoku.senkou_span_a && lastClose < ichimoku.senkou_span_b) {
            scoreVenda += 2;
        }

        // Decisão final com pontuação ajustada
        let sinalFinal = "NEUTRO";
        const pontuacaoMinima = 5; // Aumentado devido aos novos indicadores

        if (scoreCompra > pontuacaoMinima && scoreCompra > scoreVenda) {
            if (!isHighVolatility) {
                sinalFinal = "COMPRA";
                console.log(`Sinal de COMPRA confirmado
                    Stop Loss: ${stopLoss.toFixed(2)}
                    Take Profit: ${takeProfit.toFixed(2)}
                    Pontuação: ${scoreCompra}
                    Volume: ${currentVolume > volumeMA ? 'Alto' : 'Baixo'}
                    ATR: ${atr.toFixed(4)}`);
            }
        } else if (scoreVenda > pontuacaoMinima && scoreVenda > scoreCompra) {
            if (!isHighVolatility) {
                sinalFinal = "VENDA";
                console.log(`Sinal de VENDA confirmado
                    Stop Loss: ${(lastClose + atr * 1.5).toFixed(2)}
                    Take Profit: ${(lastClose - atr * 2).toFixed(2)}
                    Pontuação: ${scoreVenda}
                    Volume: ${currentVolume > volumeMA ? 'Alto' : 'Baixo'}
                    ATR: ${atr.toFixed(4)}`);
            }
        }

        // Métricas expandidas
        const metrics = {
            timestamp: currentCloseTime,
            signal: sinalFinal,
            buyScore: scoreCompra,
            sellScore: scoreVenda,
            // atr: atr,
            // volume: currentVolume,
            // volumeMA: volumeMA,
            // rsi: rsi,
            // adx: adx,
            // // stochastic: currentStoch,
            // mfi: currentMFI,
            // ppo: ppoValues.ppo,
            // vwap: currentVWAP,
            // momentum: momentum,
            // volumeChange: volumeChange,
            // williamsR: currentWilliamsR,
            // obv: obv[obv.length - 1],
            // ao: currentAO,
            // elderRay: elderRay,
            // ichimoku: {
            //     tenkan: ichimoku.tenkan,
            //     kijun: ichimoku.kijun,
            //     senkouA: ichimoku.senkou_span_a,
            //     senkouB: ichimoku.senkou_span_b
            // }
        };

        console.log('Métricas Expandidas:', metrics);

        // Função para registrar sinais
        function registerSignal(signal) {
            const indicators = {
                rsi: signal.indicators.rsi,
                williamsR: signal.indicators.williamsR,
                macd: signal.indicators.macd,
                obv: signal.indicators.obv,
                elderRay: {
                    bullPower: signal.indicators.elderRay?.bullPower,
                    bearPower: signal.indicators.elderRay?.bearPower
                },
                ichimoku: {
                    tenkan: signal.indicators.ichimoku?.tenkan,
                    kijun: signal.indicators.ichimoku?.kijun,
                    senkouA: signal.indicators.ichimoku?.senkou_span_a,
                    senkouB: signal.indicators.ichimoku?.senkou_span_b
                },
                ao: signal.indicators.ao,
                ema: {
                    short: signal.indicators.emaShort,
                    long: signal.indicators.emaLong,
                    ema50: signal.indicators.ema50,
                    ema200: signal.indicators.ema200
                },
                adx: signal.indicators.adx,
                cci: signal.indicators.cci,
                stoch: signal.indicators.stoch,
                mfi: signal.indicators.mfi,
                vwap: signal.indicators.vwap,
                ppo: signal.indicators.ppo
            };

            const sql = `INSERT INTO signals (
                timestamp,
                symbol,
                signal_type,
                entry_price,
                stop_loss,
                take_profit,
                score,
                indicators
            ) VALUES (datetime('now'), ?, ?, ?, ?, ?, ?, ?)`;

            db.run(sql, [
                signal.symbol,
                signal.type,
                signal.entryPrice,
                signal.stopLoss,
                signal.takeProfit,
                signal.score,
                JSON.stringify(indicators)
            ]);
        }

        // Função para verificar resultados dos sinais
        function checkSignalResults() {
            const sql = `
                SELECT * FROM signals 
                WHERE result IS NULL 
                AND timestamp <= datetime('now', '-15 minutes')
            `;

            db.all(sql, [], (err, signals) => {
                if (err) {
                    console.error("Erro ao buscar sinais:", err);
                    return;
                }

                console.log(`Verificando ${signals.length} sinais pendentes`);
                signals.forEach(signal => {
                    analyzeSignalResult(signal);
                });
            });
        }

        // Função para analisar resultado de um sinal
        async function analyzeSignalResult(signal) {
            const sql = `
                SELECT close, timestamp 
                FROM candles 
                WHERE symbol = ? 
                AND timestamp > ? 
                ORDER BY timestamp ASC
                LIMIT 20
            `;

            db.all(sql, [signal.symbol, signal.timestamp], (err, candles) => {
                if (err || !candles.length) return;


                let result = null;
                let exitPrice = null;
                let exitTimestamp = null;
                let profitLoss = 0;

                for (const candle of candles) {
                    if (signal.signal_type === 'COMPRA') {
                        // Para sinais de COMPRA
                        if (parseFloat(candle.close) <= signal.stop_loss) {
                            result = 'STOP_LOSS';
                            exitPrice = signal.stop_loss;
                            exitTimestamp = candle.timestamp;
                            profitLoss = ((exitPrice - signal.entry_price) / signal.entry_price) * 100;
                            break;
                        } else if (parseFloat(candle.close) >= signal.take_profit) {
                            result = 'TAKE_PROFIT';
                            exitPrice = signal.take_profit;
                            exitTimestamp = candle.timestamp;
                            profitLoss = ((exitPrice - signal.entry_price) / signal.entry_price) * 100;
                            break;
                        }
                    } else if (signal.signal_type === 'VENDA') {
                        // Para sinais de VENDA
                        if (parseFloat(candle.close) >= signal.stop_loss) {
                            result = 'STOP_LOSS';
                            exitPrice = signal.stop_loss;
                            exitTimestamp = candle.timestamp;
                            profitLoss = ((signal.entry_price - exitPrice) / signal.entry_price) * 100;
                            break;
                        } else if (parseFloat(candle.close) <= signal.take_profit) {
                            result = 'TAKE_PROFIT';
                            exitPrice = signal.take_profit;
                            exitTimestamp = candle.timestamp;
                            profitLoss = ((signal.entry_price - exitPrice) / signal.entry_price) * 100;
                            break;
                        }
                    }
                }

               // Atualizar o sinal com o resultado
                if (result) {
                    const updateSql = `
                        UPDATE signals 
                        SET result = ?,
                            exit_price = ?,
                            exit_timestamp = ?,
                            profit_loss = ?
                        WHERE id = ?
                    `;

                    db.run(updateSql, [result, exitPrice, exitTimestamp, profitLoss, signal.id], (err) => {
                        if (err) {
                            console.error('Erro ao atualizar resultado do sinal:', err);
                        } else {
                            console.log(`Sinal ${signal.id} atualizado: ${result} (${profitLoss.toFixed(2)}%)`);
                        }
                    });
                }
            });
        }

        // Função para atualizar resultado do sinal
        // Função para verificar sinais pendentes
        function checkPendingSignals() {
            const sql = `
                SELECT * FROM signals 
                WHERE result IS NULL 
                AND timestamp <= datetime('now', '-15 minutes')
            `;

            db.all(sql, [], (err, signals) => {
                if (err) {
                    console.error('Erro ao buscar sinais pendentes:', err);
                    return;
                }

                console.log(`Verificando ${signals.length} sinais pendentes`);
                signals.forEach(signal => {
                    analyzeSignalResult(signal);
                });
            });
}
        // Função para gerar relatório de acertividade
        function generateAccuracyReport(period = '15 minutes') {
            // Primeiro, vamos verificar se existem sinais na tabela
            db.all('SELECT COUNT(*) as total FROM signals', [], (err, countResult) => {
                console.log('Total de sinais na tabela:', countResult[0].total);
            });

            // Agora a consulta principal com formato de data corrigido
            const sql = `
                SELECT 
                    COUNT(*) as total_signals,
                    SUM(CASE WHEN result = 'TAKE_PROFIT' THEN 1 ELSE 0 END) as successful_trades,
                    SUM(CASE WHEN result = 'STOP_LOSS' THEN 1 ELSE 0 END) as failed_trades,
                    COUNT(CASE WHEN result IS NULL THEN 1 END) as pending_trades,
                    AVG(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END) as avg_profit,
                    AVG(CASE WHEN profit_loss < 0 THEN profit_loss ELSE 0 END) as avg_loss,
                    AVG(score) as avg_score,
                    signal_type,
                    GROUP_CONCAT(indicators) as indicator_data
                FROM signals 
                WHERE timestamp >= datetime('now', '-${period}')
                GROUP BY signal_type
            `;

            // Log da consulta SQL para debug
            // console.log('SQL Query:', sql);

            db.all(sql, [], (err, results) => {
                if (err) {
                    console.error("Erro ao gerar relatório:", err);
                    return;
                }

                // Log dos resultados brutos
                console.log('Resultados brutos:', results);

                // Verificar últimos sinais registrados para debug
                db.all(`
                    SELECT timestamp, signal_type, result 
                    FROM signals 
                    ORDER BY timestamp DESC 
                    LIMIT 5
                `, [], (err, lastSignals) => {
                    console.log('Últimos 5 sinais registrados:', lastSignals);
                });

                if (results.length === 0) {
                    console.log('Nenhum sinal encontrado no período especificado.');
                    return;
                }

                const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Cuiaba' });
                let reportText = `\nRelatório de Acertividade - ${now}\n`;
                reportText += '='.repeat(50) + '\n\n';

                if (results.length === 0) {
                    reportText += 'Nenhum sinal encontrado no período especificado.\n';
                    reportText += '='.repeat(50) + '\n\n';
                } else {
                    results.forEach(result => {
                        const winRate = (result.successful_trades / result.total_signals) * 100;
                        const riskRewardRatio = Math.abs(result.avg_profit / result.avg_loss) || 0;
                        reportText += `Sinais Pendentes: ${result.pending_trades}\n`;
                        reportText += `Sinais Concluídos: ${result.successful_trades + result.failed_trades}\n`;    
                        reportText += `Tipo de Sinal: ${result.signal_type}\n`;
                        reportText += '-'.repeat(30) + '\n';
                        reportText += `Total de Sinais: ${result.total_signals}\n`;
                        reportText += `Taxa de Acerto: ${winRate.toFixed(2)}%\n`;
                        reportText += `Lucro Médio: ${result.avg_profit ? result.avg_profit.toFixed(2) : 0}%\n`;
                        reportText += `Perda Média: ${result.avg_loss ? result.avg_loss.toFixed(2) : 0}%\n`;
                        reportText += `Risk/Reward Ratio: ${riskRewardRatio.toFixed(2)}\n`;
                        reportText += `Score Médio: ${result.avg_score ? result.avg_score.toFixed(2) : 0}\n\n`;

                        // Análise dos indicadores
                        if (result.indicator_data) {
                            reportText += 'Efetividade dos Indicadores:\n';
                            reportText += '-'.repeat(30) + '\n';
                            
                            try {
                                const indicators = JSON.parse(`[${result.indicator_data}]`);
                                const indicatorStats = analyzeIndicatorEffectiveness(indicators);
                                
                                Object.entries(indicatorStats).forEach(([indicator, stats]) => {
                                    const effectiveness = (stats.successful / stats.total) * 100;
                                    reportText += `${indicator}: ${effectiveness.toFixed(2)}% de acerto\n`;
                                });
                            } catch (e) {
                                reportText += `Erro ao analisar indicadores: ${e.message}\n`;
                            }
                        }
                        
                        reportText += '\n' + '='.repeat(50) + '\n\n';
                    });
                }

                // Salvar no arquivo
                fs.appendFile('trading_report.txt', reportText, (err) => {
                    if (err) {
                        console.error('Erro ao salvar relatório:', err);
                    } else {
                        console.log('Relatório salvo em trading_report.txt');
                    }
                });

                // Mostrar no console
                console.log(reportText);
            });
        }

        // Função auxiliar para análise de indicadores
        function analyzeIndicatorEffectiveness(indicatorData) {
            const indicatorStats = {};

            indicatorData.forEach(indicators => {
                if (typeof indicators === 'string') {
                    indicators = JSON.parse(indicators);
                }
                
                Object.entries(indicators).forEach(([indicator, value]) => {
                    if (!indicatorStats[indicator]) {
                        indicatorStats[indicator] = {
                            successful: 0,
                            total: 0
                        };
                    }
                    indicatorStats[indicator].total++;
                    if (value > 0) indicatorStats[indicator].successful++;
                });
            });

            return indicatorStats;
        }

        // Configurar intervalo de relatório
        const MINUTE = 60 * 1000;
        const REPORT_INTERVAL = 15 * MINUTE;

        // Agendar geração de relatório
        setInterval(() => {
            generateAccuracyReport('15 minutes');
        }, REPORT_INTERVAL);
        // Executar verificação inicial
        setInterval(() => {
            checkPendingSignals();
            updateActiveSignals();
        }, 60000);
        generateAccuracyReport('15 minutes');

        if (sinalFinal !== "NEUTRO") {
            const signal = {
                timestamp: currentCloseTime,
                symbol: symbol,
                signal_type: sinalFinal,
                entry_price: lastClose,
                stop_loss: stopLoss,
                take_profit: takeProfit,
                score: sinalFinal === "COMPRA" ? scoreCompra : scoreVenda,
                indicators: {
                    rsi: rsi,
                    williamsR: currentWilliamsR,
                    macd: macdLine,
                    obv: obv[obv.length - 1],
                    // ... outros indicadores
                }
            };

            // Registrar sinal
            registerSignal(signal);

            // Verificar condições de risco antes de enviar ordem
            if (checkRiskConditions(signal)) {
                sendOrder(signal);
            }
        }
    });
}

// Funções auxiliares para os novos indicadores
function calculateOBV(closes, volumes) {
    let obv = [volumes[0]];
    
    for (let i = 1; i < closes.length; i++) {
        if (closes[i] > closes[i - 1]) {
            obv.push(obv[obv.length - 1] + volumes[i]);
        } else if (closes[i] < closes[i - 1]) {
            obv.push(obv[obv.length - 1] - volumes[i]);
        } else {
            obv.push(obv[obv.length - 1]);
        }
    }
    
    return obv;
}

function calculateAO(highs, lows, fastPeriod, slowPeriod) {
    const medianPrices = highs.map((high, i) => (high + lows[i]) / 2);
    
    const fastSMA = ta.sma({
        values: medianPrices,
        period: fastPeriod
    });
    
    const slowSMA = ta.sma({
        values: medianPrices,
        period: slowPeriod
    });
    
    return fastSMA.map((fast, i) => fast - slowSMA[i]).slice(slowPeriod - fastPeriod);
}

function calculateElderRay(highs, lows, closes) {
    const ema13 = ta.ema({ values: closes, period: 13 }).slice(-1)[0];
    const highestHigh = Math.max(...highs.slice(0, 13));
    const lowestLow = Math.min(...lows.slice(0, 13));
    
    return {
        bullPower: highestHigh - ema13,
        bearPower: lowestLow - ema13
    };
}

function calculateIchimoku(highs, lows, settings) {
    const tenkan = calculateIchimokuLine(highs, lows, settings.conversionPeriod);
    const kijun = calculateIchimokuLine(highs, lows, settings.basePeriod);
    
    const senkouA = (tenkan + kijun) / 2;
    
    const senkouB = calculateIchimokuLine(
        highs,
        lows,
        settings.spanPeriod
    );
    
    return {
        tenkan: tenkan,
        kijun: kijun,
        senkou_span_a: senkouA,
        senkou_span_b: senkouB
    };
}

function calculateIchimokuLine(highs, lows, period) {
    const highValues = highs.slice(0, period);
    const lowValues = lows.slice(0, period);
    return (Math.max(...highValues) + Math.min(...lowValues)) / 2;
}

// Adicionar configurações de risco
const riskConfig = {
    maxLossPerTrade: 2, // Porcentagem máxima de perda por operação
    maxDailyLoss: 6,    // Porcentagem máxima de perda diária
    minRiskReward: 1.5, // Relação risco/retorno mínima
    trailingStop: true, // Ativar stop móvel
    trailingStopDistance: 1 // Distância do stop móvel em %
};

// Adicionar função para trailing stop
function updateTrailingStop(signal) {
    if (!riskConfig.trailingStop) return;

    const sql = `
        SELECT close 
        FROM candles 
        WHERE symbol = ? 
        AND timestamp > ? 
        ORDER BY timestamp DESC 
        LIMIT 1
    `;

    db.get(sql, [signal.symbol, signal.timestamp], (err, row) => {
        if (err || !row) return;

        const currentPrice = row.close;
        const trailingDistance = currentPrice * (riskConfig.trailingStopDistance / 100);

        if (signal.signal_type === 'COMPRA' && currentPrice > signal.entry_price) {
            const newStopLoss = currentPrice - trailingDistance;
            if (newStopLoss > signal.stop_loss) {
                updateSignalStopLoss(signal.id, newStopLoss);
            }
        } else if (signal.signal_type === 'VENDA' && currentPrice < signal.entry_price) {
            const newStopLoss = currentPrice + trailingDistance;
            if (newStopLoss < signal.stop_loss) {
                updateSignalStopLoss(signal.id, newStopLoss);
            }
        }
    });
}

// Função para enviar ordem à Binance
async function sendOrder(signal) {
    try {
        const quantity = calculateOrderQuantity(signal.entry_price);
        
        const orderParams = {
            symbol: signal.symbol.toUpperCase(),
            side: signal.signal_type === 'COMPRA' ? 'BUY' : 'SELL',
            type: 'LIMIT',
            timeInForce: 'GTC',
            quantity: quantity,
            price: signal.entry_price.toFixed(2),
            stopPrice: signal.stop_loss.toFixed(2),
            takeProfit: signal.take_profit.toFixed(2)
        };

        // Ordem principal
        const mainOrder = await client.newOrder(
            orderParams.symbol,
            orderParams.side,
            orderParams.type,
            {
                quantity: orderParams.quantity,
                price: orderParams.price,
                timeInForce: orderParams.timeInForce
            }
        );

        // Stop Loss
        const stopLossOrder = await client.newOrder(
            orderParams.symbol,
            orderParams.side === 'BUY' ? 'SELL' : 'BUY',
            'STOP_LOSS_LIMIT',
            {
                quantity: orderParams.quantity,
                stopPrice: orderParams.stopPrice,
                price: orderParams.stopPrice,
                timeInForce: 'GTC'
            }
        );

        // Take Profit
        const takeProfitOrder = await client.newOrder(
            orderParams.symbol,
            orderParams.side === 'BUY' ? 'SELL' : 'BUY',
            'LIMIT',
            {
                quantity: orderParams.quantity,
                price: orderParams.takeProfit,
                timeInForce: 'GTC'
            }
        );

        // Registrar ordens no banco
        registerOrders({
            signalId: signal.id,
            mainOrder: mainOrder.data,
            stopLossOrder: stopLossOrder.data,
            takeProfitOrder: takeProfitOrder.data
        });

        console.log(`Ordens enviadas com sucesso para ${signal.symbol}`);
        return true;

    } catch (error) {
        console.error('Erro ao enviar ordem:', error);
        return false;
    }
}

// Função para calcular quantidade baseada no gerenciamento de risco
function calculateOrderQuantity(entryPrice) {
    const riskPerTrade = config.accountBalance * (config.riskPercentage / 100);
    const quantity = (riskPerTrade / entryPrice).toFixed(6);
    return quantity;
}

// Função para verificar condições de risco
function checkRiskConditions(signal) {
    // Verificar perda diária máxima
    const dailyLossCheck = `
        SELECT SUM(profit_loss) as daily_loss 
        FROM signals 
        WHERE date(timestamp) = date('now')
        AND profit_loss < 0
    `;

    return new Promise((resolve) => {
        db.get(dailyLossCheck, [], (err, row) => {
            if (err) {
                console.error('Erro ao verificar perda diária:', err);
                resolve(false);
                return;
            }

            const dailyLoss = Math.abs(row?.daily_loss || 0);
            if (dailyLoss >= config.maxDailyLoss) {
                console.log('Limite de perda diária atingido');
                resolve(false);
                return;
            }

            // Verificar outras condições de risco
            const riskRewardRatio = Math.abs(
                (signal.take_profit - signal.entry_price) / 
                (signal.entry_price - signal.stop_loss)
            );

            if (riskRewardRatio < config.minRiskReward) {
                console.log('RR ratio insuficiente');
                resolve(false);
                return;
            }

            resolve(true);
        });
    });
}

