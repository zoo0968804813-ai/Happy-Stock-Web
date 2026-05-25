require('dotenv').config();

const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();

const PORT = process.env.PORT || 3000;
const TZ = process.env.TZ || 'Asia/Taipei';
const DATABASE_URL = process.env.DATABASE_URL;
const PUBLIC_REFRESH_SECONDS = Number(process.env.PUBLIC_REFRESH_SECONDS || 15);
const DEBUG_USER = process.env.DEBUG_USER || 'admin';
const DEBUG_PASSWORD = process.env.DEBUG_PASSWORD || '';

if (!DATABASE_URL) {
  throw new Error('Missing DATABASE_URL. Please set it in .env or Railway Variables.');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('railway') || DATABASE_URL.includes('proxy.rlwy.net')
    ? { rejectUnauthorized: false }
    : undefined,
});

function safeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 12);
}

function todayTaipeiSqlExpr() {
  return "TO_CHAR(NOW() AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD')";
}

function handleError(res, label, err) {
  console.error(`${label} failed:`, err);
  res.status(500).json({
    error: label,
    message: err.message,
  });
}

function fmtDebugMoney(value) {
  return Number(value || 0).toLocaleString('zh-TW', {
    maximumFractionDigits: 0,
  });
}

function fmtDebugPct(value) {
  const num = Number(value || 0);
  return `${num >= 0 ? '+' : ''}${num.toFixed(2)}%`;
}

function getTradeSideLabel(side) {
  const map = {
    BUY: '買入',
    SELL: '賣出',
    SHORT: '做空',
    COVER: '平倉買回',
  };

  return map[side] || side || '交易';
}

function summarizeTopTrader(trades, sides) {
  const traderMap = new Map();

  for (const trade of trades) {
    if (!sides.includes(trade.side)) continue;

    const key = trade.user_id || trade.username || 'UNKNOWN';

    const current = traderMap.get(key) || {
      username: trade.username || trade.user_id || '未知玩家',
      totalValue: 0,
      amount: 0,
      sides: new Set(),
    };

    current.totalValue += Number(trade.total_value || 0);
    current.amount += Number(trade.amount || 0);
    current.sides.add(getTradeSideLabel(trade.side));

    traderMap.set(key, current);
  }

  return [...traderMap.values()].sort((a, b) => b.totalValue - a.totalValue)[0] || null;
}

function buildStockStatusText(stock, debug, recentTrades) {
  const symbol = stock.symbol;
  const change = Number(stock.change || 0);
  const changePct = Number(stock.change_pct || 0);

  const buyValue = Number(stock.buy_value || 0);
  const sellValue = Number(stock.sell_value || 0);
  const pressureDiff = Number(debug.pressureDiff || 0);

  const panicValue = Number(debug.panicValue || 0);
  const heatValue = Number(debug.heatValue || 0);

  const recentBuyValue = recentTrades
    .filter((trade) => ['BUY', 'COVER'].includes(trade.side))
    .reduce((sum, trade) => sum + Number(trade.total_value || 0), 0);

  const recentSellValue = recentTrades
    .filter((trade) => ['SELL', 'SHORT'].includes(trade.side))
    .reduce((sum, trade) => sum + Number(trade.total_value || 0), 0);

  const topBuyer = summarizeTopTrader(recentTrades, ['BUY', 'COVER']);
  const topSeller = summarizeTopTrader(recentTrades, ['SELL', 'SHORT']);

  const directionText = change > 0
    ? `目前上漲 ${fmtDebugPct(changePct)}`
    : change < 0
      ? `目前下跌 ${fmtDebugPct(changePct)}`
      : '目前價格持平';

  const reasons = [];

  if (recentBuyValue > recentSellValue) {
    reasons.push(`近 10 分鐘買壓較強，買入與平倉買回金額約 ${fmtDebugMoney(recentBuyValue)}，高於賣出與做空金額 ${fmtDebugMoney(recentSellValue)}`);
  } else if (recentSellValue > recentBuyValue) {
    reasons.push(`近 10 分鐘賣壓較強，賣出與做空金額約 ${fmtDebugMoney(recentSellValue)}，高於買入與平倉買回金額 ${fmtDebugMoney(recentBuyValue)}`);
  } else {
    reasons.push('近 10 分鐘買賣力道接近，價格主要受到前面累積交易與系統更新影響');
  }

  if (buyValue > sellValue) {
    reasons.push(`今日累積買壓大於賣壓，買賣壓差約 +${fmtDebugMoney(Math.abs(pressureDiff))}`);
  } else if (sellValue > buyValue) {
    reasons.push(`今日累積賣壓大於買壓，買賣壓差約 -${fmtDebugMoney(Math.abs(pressureDiff))}`);
  } else {
    reasons.push('今日累積買賣壓接近，市場暫時沒有明顯單邊方向');
  }

  if (topBuyer) {
    reasons.push(`${topBuyer.username} 近 10 分鐘主要進行 ${[...topBuyer.sides].join(' / ')}，合計約 ${fmtDebugMoney(topBuyer.totalValue)}`);
  }

  if (topSeller) {
    reasons.push(`${topSeller.username} 近 10 分鐘主要進行 ${[...topSeller.sides].join(' / ')}，合計約 ${fmtDebugMoney(topSeller.totalValue)}`);
  }

  if (panicValue >= 75) {
    reasons.push(`恐慌值 ${panicValue.toFixed(1)} 偏高，代表跌幅、賣壓或盤中震盪正在放大，容易造成追殺或恐慌賣出`);
  } else if (panicValue >= 50) {
    reasons.push(`恐慌值 ${panicValue.toFixed(1)} 中高，代表市場有明顯不安，賣壓更容易影響價格`);
  } else {
    reasons.push(`恐慌值 ${panicValue.toFixed(1)} 不高，這次價格變動比較不像恐慌拋售造成`);
  }

  if (heatValue >= 75) {
    reasons.push(`熱度值 ${heatValue.toFixed(1)} 偏高，代表交易活躍，價格更容易被玩家買賣推動`);
  } else if (heatValue >= 45) {
    reasons.push(`熱度值 ${heatValue.toFixed(1)} 中等，代表市場有一定交易量，但還不是極端熱門`);
  } else {
    reasons.push(`熱度值 ${heatValue.toFixed(1)} 偏低，代表目前交易不算活躍`);
  }

  return `${symbol} ${directionText}。${reasons.join('；')}。`;
}

app.use(express.static(path.join(__dirname, 'public')));

function requireDebugAuth(req, res, next) {
  if (!DEBUG_PASSWORD) {
    return res.status(403).send('Debug panel is disabled. Please set DEBUG_PASSWORD.');
  }

  const auth = req.headers.authorization || '';
  const [scheme, encoded] = auth.split(' ');

  if (scheme !== 'Basic' || !encoded) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Happy Stock Debug"');
    return res.status(401).send('Authentication required.');
  }

  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const separatorIndex = decoded.indexOf(':');
  const username = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);

  if (username === DEBUG_USER && password === DEBUG_PASSWORD) {
    return next();
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Happy Stock Debug"');
  return res.status(401).send('Invalid username or password.');
}

app.get('/debug', requireDebugAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'debug.html'));
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'happy-stock-web',
    time: new Date().toISOString(),
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    refreshSeconds: PUBLIC_REFRESH_SECONDS,
    timezone: TZ,
  });
});

app.get('/api/market', async (req, res) => {
  try {
    const result = await pool.query(`
      WITH today_volume AS (
        SELECT
          symbol,
          COALESCE(SUM(amount), 0) AS volume,
          COALESCE(SUM(CASE WHEN side IN ('BUY', 'COVER') THEN total_value ELSE 0 END), 0) AS buy_value,
          COALESCE(SUM(CASE WHEN side IN ('SELL', 'SHORT') THEN total_value ELSE 0 END), 0) AS sell_value
        FROM stock_trades
        WHERE TO_CHAR(created_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') = ${todayTaipeiSqlExpr()}
        GROUP BY symbol
      )
      SELECT
        s.symbol,
        s.name,
        s.sector,
        s.description,
        s.price::float AS price,
        s.previous_close::float AS previous_close,
        s.open_price::float AS open_price,
        s.high_price::float AS high_price,
        s.low_price::float AS low_price,
        s.fair_price::float AS fair_price,
        s.market_cap::float AS market_cap,
        s.total_shares::bigint AS total_shares,
        s.daily_limit_pct::float AS daily_limit_pct,
        s.status,
        s.updated_at,
        COALESCE(tv.volume, 0)::bigint AS today_volume,
        COALESCE(tv.buy_value, 0)::float AS buy_value,
        COALESCE(tv.sell_value, 0)::float AS sell_value,
        CASE
          WHEN s.open_price > 0 THEN ((s.price - s.open_price) / s.open_price) * 100
          ELSE 0
        END::float AS change_pct,
        (s.price - s.open_price)::float AS change
      FROM stocks s
      LEFT JOIN today_volume tv ON tv.symbol = s.symbol
      ORDER BY s.symbol ASC;
    `);

    const rows = result.rows;
    const totalMarketCap = rows.reduce((sum, row) => sum + Number(row.market_cap || 0), 0);
    const upCount = rows.filter((row) => Number(row.change || 0) > 0).length;
    const downCount = rows.filter((row) => Number(row.change || 0) < 0).length;
    const flatCount = rows.length - upCount - downCount;

    const strongest = [...rows].sort((a, b) => Number(b.change_pct || 0) - Number(a.change_pct || 0))[0] || null;
    const weakest = [...rows].sort((a, b) => Number(a.change_pct || 0) - Number(b.change_pct || 0))[0] || null;

    res.json({
      stocks: rows,
      summary: {
        count: rows.length,
        totalMarketCap,
        upCount,
        downCount,
        flatCount,
        strongest,
        weakest,
        serverTime: new Date().toISOString(),
      },
    });
  } catch (err) {
    handleError(res, 'GET /api/market', err);
  }
});

app.get('/api/debug/market', requireDebugAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      WITH today_volume AS (
        SELECT
          symbol,
          COALESCE(SUM(amount), 0) AS volume,
          COALESCE(SUM(CASE WHEN side IN ('BUY', 'COVER') THEN total_value ELSE 0 END), 0) AS buy_value,
          COALESCE(SUM(CASE WHEN side IN ('SELL', 'SHORT') THEN total_value ELSE 0 END), 0) AS sell_value,
          COUNT(*)::int AS trade_count
        FROM stock_trades
        WHERE TO_CHAR(created_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') = ${todayTaipeiSqlExpr()}
        GROUP BY symbol
      )
      SELECT
        s.symbol,
        s.name,
        s.sector,
        s.price::float AS price,
        s.previous_close::float AS previous_close,
        s.open_price::float AS open_price,
        s.high_price::float AS high_price,
        s.low_price::float AS low_price,
        s.fair_price::float AS fair_price,
        s.market_cap::float AS market_cap,
        s.total_shares::bigint AS total_shares,
        s.daily_limit_pct::float AS daily_limit_pct,
        s.status,
        s.updated_at,
        COALESCE(tv.volume, 0)::bigint AS today_volume,
        COALESCE(tv.buy_value, 0)::float AS buy_value,
        COALESCE(tv.sell_value, 0)::float AS sell_value,
        COALESCE(tv.trade_count, 0)::int AS trade_count,
        CASE
          WHEN s.open_price > 0 THEN ((s.price - s.open_price) / s.open_price) * 100
          ELSE 0
        END::float AS change_pct,
        (s.price - s.open_price)::float AS change
      FROM stocks s
      LEFT JOIN today_volume tv ON tv.symbol = s.symbol
      ORDER BY s.symbol ASC;
    `);

    const recentTradesRes = await pool.query(`
      SELECT
        symbol,
        user_id,
        username,
        side,
        amount::bigint AS amount,
        price::float AS price,
        total_value::float AS total_value,
        created_at
      FROM stock_trades
      WHERE created_at >= NOW() - INTERVAL '10 minutes'
      ORDER BY created_at DESC
      LIMIT 300;
    `);

    const recentTradesBySymbol = new Map();

    for (const trade of recentTradesRes.rows) {
      const list = recentTradesBySymbol.get(trade.symbol) || [];
      list.push(trade);
      recentTradesBySymbol.set(trade.symbol, list);
    }

    const stocks = result.rows.map((stock) => {
      const price = Number(stock.price || 0);
      const openPrice = Number(stock.open_price || 0);
      const highPrice = Number(stock.high_price || 0);
      const lowPrice = Number(stock.low_price || 0);
      const fairPrice = Number(stock.fair_price || 0);
      const buyValue = Number(stock.buy_value || 0);
      const sellValue = Number(stock.sell_value || 0);
      const tradeCount = Number(stock.trade_count || 0);
      const changePct = Number(stock.change_pct || 0);

      const pressureTotal = buyValue + sellValue;
      const buyPressurePct = pressureTotal > 0 ? (buyValue / pressureTotal) * 100 : 50;
      const sellPressurePct = pressureTotal > 0 ? (sellValue / pressureTotal) * 100 : 50;
      const pressureDiff = buyValue - sellValue;

      const priceToFairPct = fairPrice > 0 ? ((price - fairPrice) / fairPrice) * 100 : 0;
      const intradayRangePct = openPrice > 0 ? ((highPrice - lowPrice) / openPrice) * 100 : 0;

      const panicValue = Math.min(100, Math.max(0,
        Math.abs(Math.min(changePct, 0)) * 3
        + sellPressurePct * 0.35
        + Math.max(priceToFairPct, 0) * 0.8
        + intradayRangePct * 1.2
      ));

      const heatValue = Math.min(100, Math.max(0,
        tradeCount * 4
        + Math.abs(changePct) * 2
        + Math.min(pressureTotal / 10000, 40)
      ));

      let riskLabel = '正常';
      if (panicValue >= 75) riskLabel = '高度恐慌';
      else if (panicValue >= 50) riskLabel = '偏恐慌';
      else if (heatValue >= 75) riskLabel = '高度熱門';
      else if (Math.abs(changePct) >= 10) riskLabel = '高波動';

      const recentTrades = recentTradesBySymbol.get(stock.symbol) || [];

      const statusText = buildStockStatusText(stock, {
        buyPressurePct,
        sellPressurePct,
        pressureDiff,
        priceToFairPct,
        intradayRangePct,
        panicValue,
        heatValue,
        riskLabel,
      }, recentTrades);

      return {
        ...stock,
        debug: {
          buyPressurePct,
          sellPressurePct,
          pressureDiff,
          priceToFairPct,
          intradayRangePct,
          panicValue,
          heatValue,
          riskLabel,
          statusText,
          recentTrades: recentTrades.slice(0, 8),
          formulas: {
            changePct: '((price - open_price) / open_price) * 100',
            buyPressurePct: 'buy_value / (buy_value + sell_value) * 100',
            sellPressurePct: 'sell_value / (buy_value + sell_value) * 100',
            priceToFairPct: '((price - fair_price) / fair_price) * 100',
            intradayRangePct: '((high_price - low_price) / open_price) * 100',
            panicValue: '跌幅壓力 + 賣壓 + 高估壓力 + 盤中震盪',
            heatValue: '交易次數 + 漲跌幅波動 + 成交金額'
          }
        }
      };
    });

    res.json({
      serverTime: new Date().toISOString(),
      stocks
    });
  } catch (err) {
    handleError(res, 'GET /api/debug/market', err);
  }
});

app.get('/api/debug/market', requireDebugAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      WITH today_volume AS (
        SELECT
          symbol,
          COALESCE(SUM(amount), 0) AS volume,
          COALESCE(SUM(CASE WHEN side IN ('BUY', 'COVER') THEN total_value ELSE 0 END), 0) AS buy_value,
          COALESCE(SUM(CASE WHEN side IN ('SELL', 'SHORT') THEN total_value ELSE 0 END), 0) AS sell_value,
          COUNT(*)::int AS trade_count
        FROM stock_trades
        WHERE TO_CHAR(created_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') = ${todayTaipeiSqlExpr()}
        GROUP BY symbol
      )
      SELECT
        s.symbol,
        s.name,
        s.sector,
        s.price::float AS price,
        s.previous_close::float AS previous_close,
        s.open_price::float AS open_price,
        s.high_price::float AS high_price,
        s.low_price::float AS low_price,
        s.fair_price::float AS fair_price,
        s.market_cap::float AS market_cap,
        s.total_shares::bigint AS total_shares,
        s.daily_limit_pct::float AS daily_limit_pct,
        s.status,
        s.updated_at,
        COALESCE(tv.volume, 0)::bigint AS today_volume,
        COALESCE(tv.buy_value, 0)::float AS buy_value,
        COALESCE(tv.sell_value, 0)::float AS sell_value,
        COALESCE(tv.trade_count, 0)::int AS trade_count,
        CASE
          WHEN s.open_price > 0 THEN ((s.price - s.open_price) / s.open_price) * 100
          ELSE 0
        END::float AS change_pct,
        (s.price - s.open_price)::float AS change
      FROM stocks s
      LEFT JOIN today_volume tv ON tv.symbol = s.symbol
      ORDER BY s.symbol ASC;
    `);

    const stocks = result.rows.map((stock) => {
      const price = Number(stock.price || 0);
      const openPrice = Number(stock.open_price || 0);
      const highPrice = Number(stock.high_price || 0);
      const lowPrice = Number(stock.low_price || 0);
      const fairPrice = Number(stock.fair_price || 0);
      const buyValue = Number(stock.buy_value || 0);
      const sellValue = Number(stock.sell_value || 0);
      const tradeCount = Number(stock.trade_count || 0);
      const changePct = Number(stock.change_pct || 0);

      const pressureTotal = buyValue + sellValue;
      const buyPressurePct = pressureTotal > 0 ? (buyValue / pressureTotal) * 100 : 50;
      const sellPressurePct = pressureTotal > 0 ? (sellValue / pressureTotal) * 100 : 50;
      const pressureDiff = buyValue - sellValue;

      const priceToFairPct = fairPrice > 0 ? ((price - fairPrice) / fairPrice) * 100 : 0;
      const intradayRangePct = openPrice > 0 ? ((highPrice - lowPrice) / openPrice) * 100 : 0;

      const panicValue = Math.min(100, Math.max(0,
        Math.abs(Math.min(changePct, 0)) * 3
        + sellPressurePct * 0.35
        + Math.max(priceToFairPct, 0) * 0.8
        + intradayRangePct * 1.2
      ));

      const heatValue = Math.min(100, Math.max(0,
        tradeCount * 4
        + Math.abs(changePct) * 2
        + Math.min(pressureTotal / 10000, 40)
      ));

      let riskLabel = '正常';
      if (panicValue >= 75) riskLabel = '高度恐慌';
      else if (panicValue >= 50) riskLabel = '偏恐慌';
      else if (heatValue >= 75) riskLabel = '高度熱門';
      else if (Math.abs(changePct) >= 10) riskLabel = '高波動';

      return {
        ...stock,
        debug: {
          buyPressurePct,
          sellPressurePct,
          pressureDiff,
          priceToFairPct,
          intradayRangePct,
          panicValue,
          heatValue,
          riskLabel,
          formulas: {
            changePct: '((price - open_price) / open_price) * 100',
            buyPressurePct: 'buy_value / (buy_value + sell_value) * 100',
            sellPressurePct: 'sell_value / (buy_value + sell_value) * 100',
            priceToFairPct: '((price - fair_price) / fair_price) * 100',
            intradayRangePct: '((high_price - low_price) / open_price) * 100',
            panicValue: '跌幅壓力 + 賣壓 + 高估壓力 + 盤中震盪',
            heatValue: '交易次數 + 漲跌幅波動 + 成交金額'
          }
        }
      };
    });

    res.json({
      serverTime: new Date().toISOString(),
      stocks
    });
  } catch (err) {
    handleError(res, 'GET /api/debug/market', err);
  }
});

app.get('/api/stocks/:symbol', async (req, res) => {
  const symbol = safeSymbol(req.params.symbol);

  try {
    const stockRes = await pool.query(`
      SELECT
        s.*,
        s.price::float AS price,
        s.previous_close::float AS previous_close,
        s.open_price::float AS open_price,
        s.high_price::float AS high_price,
        s.low_price::float AS low_price,
        s.fair_price::float AS fair_price,
        s.market_cap::float AS market_cap,
        s.daily_limit_pct::float AS daily_limit_pct,
        CASE
          WHEN s.open_price > 0 THEN ((s.price - s.open_price) / s.open_price) * 100
          ELSE 0
        END::float AS change_pct,
        (s.price - s.open_price)::float AS change
      FROM stocks s
      WHERE s.symbol = $1;
    `, [symbol]);

    if (!stockRes.rows.length) {
      res.status(404).json({ error: 'Stock not found.' });
      return;
    }

    const stock = stockRes.rows[0];

    const flowRes = await pool.query(`
      SELECT
        date_key,
        foreign_net_value::float,
        trust_net_value::float,
        dealer_net_value::float,
        main_player_net_value::float,
        retail_net_value::float,
        updated_at
      FROM stock_institution_flows
      WHERE symbol = $1
      ORDER BY updated_at DESC
      LIMIT 1;
    `, [symbol]);

    const holdersRes = await pool.query(`
      SELECT
        h.user_id,
        h.username,
        h.amount::bigint AS amount,
        h.avg_price::float AS avg_price,
        (h.amount * s.price)::float AS market_value,
        CASE
          WHEN s.total_shares > 0 THEN (h.amount::numeric / s.total_shares::numeric) * 100
          ELSE 0
        END::float AS holding_pct
      FROM stock_holdings h
      JOIN stocks s ON s.symbol = h.symbol
      WHERE h.symbol = $1
        AND h.amount > 0
      ORDER BY h.amount DESC
      LIMIT 5;
    `, [symbol]);

    const todayTradesRes = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN side IN ('BUY', 'COVER') THEN total_value ELSE 0 END), 0)::float AS buy_value,
        COALESCE(SUM(CASE WHEN side IN ('SELL', 'SHORT') THEN total_value ELSE 0 END), 0)::float AS sell_value,
        COALESCE(SUM(amount), 0)::bigint AS volume,
        COUNT(DISTINCT CASE WHEN side IN ('BUY', 'COVER') THEN user_id ELSE NULL END)::int AS buy_users,
        COUNT(DISTINCT CASE WHEN side IN ('SELL', 'SHORT') THEN user_id ELSE NULL END)::int AS sell_users
      FROM stock_trades
      WHERE symbol = $1
        AND TO_CHAR(created_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') = ${todayTaipeiSqlExpr()};
    `, [symbol]);

    const revenueRes = await pool.query(`
      SELECT COALESCE(SUM(amount), 0)::bigint AS revenue
      FROM stock_company_revenues
      WHERE symbol = $1
        AND created_at >= NOW() - INTERVAL '7 days';
    `, [symbol]);

    const dividendRes = await pool.query(`
      SELECT *
      FROM stock_dividend_runs
      WHERE symbol = $1
      ORDER BY created_at DESC
      LIMIT 1;
    `, [symbol]);

    const listingsRes = await pool.query(`
      SELECT *
      FROM stock_listing_applications
      WHERE symbol = $1
      ORDER BY created_at DESC
      LIMIT 1;
    `, [symbol]);

    res.json({
      stock,
      flows: flowRes.rows[0] || {
        foreign_net_value: 0,
        trust_net_value: 0,
        dealer_net_value: 0,
        main_player_net_value: 0,
        retail_net_value: 0,
      },
      holders: holdersRes.rows,
      todayTrades: todayTradesRes.rows[0] || {},
      dividend: {
        recentRevenue: Number(revenueRes.rows[0]?.revenue || 0),
        latestRun: dividendRes.rows[0] || null,
      },
      listing: listingsRes.rows[0] || null,
    });
  } catch (err) {
    handleError(res, 'GET /api/stocks/:symbol', err);
  }
});

app.get('/api/stocks/:symbol/holders', async (req, res) => {
  const symbol = String(req.params.symbol || '').trim().toUpperCase();

  if (!/^[A-Z0-9_]{1,12}$/.test(symbol)) {
    return res.status(400).json({ error: 'Invalid symbol' });
  }

  try {
    const stockResult = await pool.query(`
      SELECT
        symbol,
        name,
        price,
        total_shares
      FROM stocks
      WHERE symbol = $1
      LIMIT 1;
    `, [symbol]);

    if (!stockResult.rows.length) {
      return res.status(404).json({ error: 'Stock not found' });
    }

    const stock = stockResult.rows[0];
    const price = Number(stock.price || 0);
    const totalShares = Number(stock.total_shares || 0);

    const playersResult = await pool.query(`
      SELECT
        user_id,
        username,
        amount,
        avg_price,
        (amount * $2::numeric) AS market_value
      FROM stock_holdings
      WHERE symbol = $1
        AND amount > 0
      ORDER BY amount DESC
      LIMIT 10;
    `, [symbol, price]);

    const playerTotalResult = await pool.query(`
      SELECT
        COALESCE(SUM(amount), 0) AS player_shares
      FROM stock_holdings
      WHERE symbol = $1
        AND amount > 0;
    `, [symbol]);

    const marketResult = await pool.query(`
      SELECT
        holder_type,
        shares,
        avg_price,
        cash_balance,
        realized_pnl,
        updated_at
      FROM stock_market_holders
      WHERE symbol = $1
      ORDER BY
        CASE holder_type
          WHEN 'FOREIGN' THEN 1
          WHEN 'TRUST' THEN 2
          WHEN 'DEALER' THEN 3
          WHEN 'MAIN' THEN 4
          WHEN 'RETAIL_POOL' THEN 5
          WHEN 'TREASURY' THEN 6
          ELSE 99
        END;
    `, [symbol]);

    const marketTotalResult = await pool.query(`
      SELECT
        COALESCE(SUM(shares), 0) AS market_shares
      FROM stock_market_holders
      WHERE symbol = $1;
    `, [symbol]);

    const playerShares = Number(playerTotalResult.rows[0]?.player_shares || 0);
    const marketShares = Number(marketTotalResult.rows[0]?.market_shares || 0);
    const allocatedShares = playerShares + marketShares;
    const unallocatedShares = Math.max(totalShares - allocatedShares, 0);
    const overAllocatedShares = Math.max(allocatedShares - totalShares, 0);

    const holderNameMap = {
      FOREIGN: '外資',
      TRUST: '投信',
      DEALER: '自營商',
      MAIN: '主力',
      RETAIL_POOL: '散戶市場池',
      TREASURY: '公司庫藏 / 未釋出',
    };

    const players = playersResult.rows.map((row) => {
      const shares = Number(row.amount || 0);

      return {
        user_id: row.user_id,
        username: row.username,
        shares,
        avg_price: Number(row.avg_price || 0),
        market_value: Number(row.market_value || 0),
        holding_pct: totalShares > 0 ? (shares / totalShares) * 100 : 0,
      };
    });

    const marketHolders = marketResult.rows.map((row) => {
      const shares = Number(row.shares || 0);

      return {
        holder_type: row.holder_type,
        holder_name: holderNameMap[row.holder_type] || row.holder_type,
        shares,
        avg_price: Number(row.avg_price || 0),
        cash_balance: Number(row.cash_balance || 0),
        realized_pnl: Number(row.realized_pnl || 0),
        holding_pct: totalShares > 0 ? (shares / totalShares) * 100 : 0,
        updated_at: row.updated_at,
      };
    });

    res.json({
      stock: {
        symbol: stock.symbol,
        name: stock.name,
        price,
        total_shares: totalShares,
      },
      summary: {
        total_shares: totalShares,
        player_shares: playerShares,
        market_shares: marketShares,
        allocated_shares: allocatedShares,
        unallocated_shares: unallocatedShares,
        over_allocated_shares: overAllocatedShares,
        player_pct: totalShares > 0 ? (playerShares / totalShares) * 100 : 0,
        market_pct: totalShares > 0 ? (marketShares / totalShares) * 100 : 0,
        allocated_pct: totalShares > 0 ? (allocatedShares / totalShares) * 100 : 0,
        is_valid: overAllocatedShares <= 0,
      },
      players,
      market_holders: marketHolders,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('GET /api/stocks/:symbol/holders failed:', err);
    res.status(500).json({ error: 'Failed to load holder distribution' });
  }
});

app.get('/api/debug/flow-check/:symbol', requireDebugAuth, async (req, res) => {
  const symbol = safeSymbol(req.params.symbol);

  try {
    const flowRows = await pool.query(`
      SELECT *
      FROM stock_institution_flows
      WHERE symbol = $1
      ORDER BY date_key DESC
      LIMIT 20;
    `, [symbol]);

    const marketHolderRows = await pool.query(`
      SELECT *
      FROM stock_market_holders
      WHERE symbol = $1
      ORDER BY
        CASE holder_type
          WHEN 'FOREIGN' THEN 1
          WHEN 'TRUST' THEN 2
          WHEN 'DEALER' THEN 3
          WHEN 'MAIN' THEN 4
          WHEN 'RETAIL_POOL' THEN 5
          WHEN 'TREASURY' THEN 6
          ELSE 99
        END;
    `, [symbol]);

    const todayTradeRows = await pool.query(`
      SELECT
        side,
        COUNT(*)::int AS trade_count,
        COALESCE(SUM(amount), 0)::bigint AS amount,
        COALESCE(SUM(total_value), 0)::float AS total_value
      FROM stock_trades
      WHERE symbol = $1
        AND TO_CHAR(created_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') = ${todayTaipeiSqlExpr()}
      GROUP BY side
      ORDER BY side ASC;
    `, [symbol]);

    res.json({
      symbol,
      checkedAt: new Date().toISOString(),
      stock_institution_flows: flowRows.rows,
      stock_market_holders: marketHolderRows.rows,
      today_trades_by_side: todayTradeRows.rows,
      conclusionHint: {
        stock_institution_flows: '網站目前法人籌碼區主要讀這張表。如果這裡是空的或都是 0，首頁法人籌碼就會顯示 +0。',
        stock_market_holders: '這張表比較像法人 / 主力 / 散戶目前持股池。如果 Discord BOT 顯示的是法人持有狀態，很可能要改讀這張表。',
        today_trades_by_side: '這裡可以確認今天玩家買入、賣出、做空、平倉的成交金額。'
      }
    });
  } catch (err) {
    handleError(res, 'GET /api/debug/flow-check/:symbol', err);
  }
});

app.get('/api/stocks/:symbol/intraday', async (req, res) => {
  const symbol = safeSymbol(req.params.symbol);

  try {
    const result = await pool.query(`
      SELECT
        created_at,
        price::float AS price,
        volume::bigint AS volume
      FROM stock_price_ticks
      WHERE symbol = $1
        AND TO_CHAR(created_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') = ${todayTaipeiSqlExpr()}
      ORDER BY created_at ASC;
    `, [symbol]);

    const stockRes = await pool.query(`
      SELECT open_price::float AS open_price, price::float AS price
      FROM stocks
      WHERE symbol = $1;
    `, [symbol]);

    res.json({
      symbol,
      openPrice: Number(stockRes.rows[0]?.open_price || 0),
      currentPrice: Number(stockRes.rows[0]?.price || 0),
      points: result.rows,
    });
  } catch (err) {
    handleError(res, 'GET /api/stocks/:symbol/intraday', err);
  }
});

app.get('/api/stocks/:symbol/candles', async (req, res) => {
  const symbol = safeSymbol(req.params.symbol);

  try {
    const result = await pool.query(`
      SELECT
        open_time,
        close_time,
        open_price::float AS open,
        high_price::float AS high,
        low_price::float AS low,
        close_price::float AS close,
        volume::bigint AS volume
      FROM stock_candles
      WHERE symbol = $1
        AND timeframe = '1d'
      ORDER BY open_time DESC
      LIMIT 30;
    `, [symbol]);

    res.json({
      symbol,
      candles: result.rows.reverse(),
    });
  } catch (err) {
    handleError(res, 'GET /api/stocks/:symbol/candles', err);
  }
});

app.get('/api/news', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 50);

    const result = await pool.query(`
      SELECT
        id,
        event_type,
        user_id,
        username,
        symbol,
        side,
        amount,
        price::float AS price,
        title,
        description,
        created_at
      FROM stock_news_events
      ORDER BY created_at DESC
      LIMIT $1;
    `, [limit]);

    res.json({
      news: result.rows,
    });
  } catch (err) {
    handleError(res, 'GET /api/news', err);
  }
});

app.get('/api/listings', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM stock_listing_applications
      WHERE status IN ('PENDING', 'FUNDING', 'LISTED')
      ORDER BY created_at DESC
      LIMIT 30;
    `);

    res.json({
      listings: result.rows,
    });
  } catch (err) {
    handleError(res, 'GET /api/listings', err);
  }
});

app.get('/api/compare', async (req, res) => {
  const symbols = String(req.query.symbols || '')
    .split(',')
    .map(safeSymbol)
    .filter(Boolean)
    .slice(0, 5);

  if (!symbols.length) {
    res.json({ symbols: [], series: [] });
    return;
  }

  try {
    const result = await pool.query(`
      SELECT
        symbol,
        created_at,
        price::float AS price
      FROM stock_price_ticks
      WHERE symbol = ANY($1::text[])
        AND created_at > NOW() - INTERVAL '24 hours'
      ORDER BY created_at ASC;
    `, [symbols]);

    res.json({
      symbols,
      series: result.rows,
    });
  } catch (err) {
    handleError(res, 'GET /api/compare', err);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Happy Stock Web running on port ${PORT}`);
});
