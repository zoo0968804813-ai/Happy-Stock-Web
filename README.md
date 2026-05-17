# Happy Stock Web

快樂炒股人公開股市看板。

網站只讀取 PostgreSQL，不提供買賣、做空、上市申請或任何會修改資料庫的功能。

## 本機啟動

```bash
npm install
npm start
```

本機 `.env` 請使用 Railway PostgreSQL 的 Public URL，例如 `xxx.proxy.rlwy.net`，不要用 `postgres.railway.internal`。

## Railway Variables

```env
DATABASE_URL=${{Postgres.DATABASE_URL}}
TZ=Asia/Taipei
PUBLIC_REFRESH_SECONDS=15
```

Railway 不需要手動設定 PORT。
