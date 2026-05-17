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
        foreign_net_value::float,
        trust_net_value::float,
        dealer_net_value::float,
        main_player_net_value::float,
        retail_net_value::float,
        updated_at
      FROM stock_institution_flows
      WHERE symbol = $1
        AND date_key = ${todayTaipeiSqlExpr()}
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
