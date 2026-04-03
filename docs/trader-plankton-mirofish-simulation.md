# Трейдер «plankton» (copy-wallet) — данные, стратегия, семя для MiroFish

Документ для **микро-симуляции** в MiroFish: что мы **фактически знаем** из системы PolySolve, как **интерпретировать логи**, и какие **правила зеркала** применяет бот (это не то же самое, что «личная стратегия» трейдера, но влогах видно и то, и другое).

---

## 1. Кто такой «plankton» в PolySolve

- В UI copy-trading кошелёк задаётся как **`CopyWallet`**: адрес + опциональный **`label`** (например `plankton` / `planktonXD`).
- **Источник истины по действиям трейдера** — его сделки на Polymarket: бэкенд тянет последние трейды через **`gammaClient.getWalletTrades(wallet, 80)`** (см. `backend/src/services/copy-trade.ts`).
- **Наши попытки копирования** пишутся в таблицу **`copy_trade_logs`** (`CopyTradeLog`): `BUY` / `SELL`, цена источника vs наша, сумма, статус `COPIED` / `SKIPPED` / `FAILED`, `skipReason`.
- В **live** дополнительно живут **`live_trades`**: реальные ордера CLOB, TP-лимитки, ретраи SELL и т.д.

Публичный proxy-кошелёк в Polymarket (**planktonXD**): `0x4ffe49ba2a4cae123536a8af4fda48faeb609f71` — в проекте совпадает с label **plankton** в `copy_wallets`. **Полный JSON** всех полей API: [`docs/data/plankton-last-200-trades.json`](./data/plankton-last-200-trades.json). **Таблица из 200 сделок** — в §8 в конце файла (снимок `data-api` на момент выгрузки).

---

## 2. Что можно вывести о стратегии *самого трейдера* из логов (метод)

Это **реконструкция по наблюдаемым действиям**, не «интервью».

| Сигнал в данных | Что оценить |
|-----------------|-------------|
| Частота `BUY` vs `SELL` | Скальп / свинг / редкие крупные входы |
| Распределение `sourcePrice` | Любит ли дешёвые исходы (&lt;10¢), середины, дорогие |
| Удержание | Время от `BUY` до `SELL` по тому же `marketId` + `outcome` |
| Повторные входы в тот же рынок | Доливка / усреднение (наш бот дедупит BUY за 7 дней — см. ниже) |
| Категории рынков | По `marketTitle` / тегам Gamma (если обогащать выгрузку) |
| Размер в USD | Поле `usdcSize` в сыром трейде — масштаб позиций |

**Практический экспорт для анализа:**

- API: `GET /api/copytrading/logs?limit=200&wallet=<адрес>` (с авторизацией).
- Или SQL по SQLite: таблица `copy_trade_logs` + при необходимости `live_trades`.

Для MiroFish удобно собрать **хронологический JSON** (см. §5).

---

## 3. Стратегия **зеркала** PolySolve (как бот следует за plankton)

Это **наши** правила; они объясняют расхождения «трейдер сделал X — у нас в логе SKIPPED / другой размер».

### 3.1 Опрос и окна времени

- Поллинг кошельков: **~30 с** (`POLL_INTERVAL_MS`).
- **BUY** копируется только если сделка источника **не старше 30 минут** (цена могла уехать).
- **SELL** обрабатывается до **7 суток** назад (чтобы догнать выход после даунтайма).

### 3.2 Фильтры цены (глобальные / per-user)

- По умолчанию: **не покупать** если цена &lt; **0.004** или &gt; **0.95** (`minCopyPrice` / `maxCopyPrice` в `copy_trading_settings` / `userCopySettings`).

### 3.3 Дедупликация BUY

- Если за последние **7 дней** уже был успешный `COPIED` **BUY** на тот же `marketId` + `outcome` — новый BUY **пропускается**.

### 3.4 Размер позиции

- Базово: **`usdcSize` источника × `copyScale`**, потолок **`amountPerTrade`**.
- Минимум по CLOB: **5 shares**; если USD мало — докручиваем до `minOrderShares * price`.

### 3.5 LIVE: регион, CLOB, tokenId

- Без готового CLOB / без `tokenId` / **регион заблокирован** — BUY или SELL могут быть **skipped** или **deferred** (FAILED SELL с ретраем).

### 3.6 Следование SELL источника

- Доля продажи: **`traderSellShares / сумма всех BUY shares источника`** по этому `conditionId|outcome` в окне последних 80 трейдов.
- Перед SELL: отмена висящих **BUY** лимиток, если источник уже вышел; учёт **частичного fill** и баланса с **data-api positions**.

### 3.7 Take-profit (опционально, per wallet)

- После **FILLED** BUY может выставляться **лимитный SELL** на часть позиции:
  - целевая цена: `entry * (1 + takeProfitRoiPercent/100)`, если ≥ 1.0 — **cap** на `takeProfitFallbackPrice` (дефолт **0.80**);
  - доля закрытия: `takeProfitClosePercent` (дефолт **40%**).

### 3.8 Выходы без сделки источника (live)

- **`syncTraderExits`**: если у источника **нет** позиции по рынку/outcome, а у нас есть — продаём (лимит по **ask**), с отложкой при VPN.
- **`syncStalePositions`** (cron):  
  - **stale**: держим ≥ `staleExitDays` дней и цена упала ≥ `staleExitLossPct`% от входа;  
  - **pre-close**: до закрытия рынка ≤ `preCloseExitHours` часов и текущая цена **ниже** входа.
- **`sweepOrphanPositions`**: «осиротевшие» шары на кошельке без открытого BUY в БД.

### 3.9 Типичные `skipReason` в логах (для симуляции персонажа)

- Ошибка CLOB в `FAILED` / `skipReason`.
- `BUY was unfilled — cancelled pending order instead of selling` — источник продал, наш лимит BUY ещё не исполнился.
- (Многие пропуски **не пишут** отдельную строку в `copy_trade_logs` — только счётчик `skipped` в полле.)

---

## 4. Разрыв «логи трейдера» vs «логи копира»

| Ситуация | Как выглядит |
|----------|----------------|
| Трейдер купил дёшево (&lt; min price) | У трейдера есть сделка, у нас **нет** COPIED BUY |
| Трейдер докупил тот же исход за 7 дней | Второй BUY у нас часто **skipped** |
| Трейдер продал, наш BUY ещё LIVE | Отмена BUY или SELL после fill |
| TP сработал раньше трейдера | Мы могли выйти **раньше** источника |
| Stale / pre-close | Мы вышли **без** SELL в ленте трейдера |

Для MiroFish полезно моделировать **два агента**: «plankton как на цепи» и «бот-копир с правилами §3».

---

## 5. Семя данных для MiroFish (шаблон JSON)

Готовая лента **200 сделок** с полями API лежит в [`docs/data/plankton-last-200-trades.json`](./data/plankton-last-200-trades.json) — можно вставить в MiroFish как `trader_observed_trades` (после лёгкой нормализации ключей). Дополнительно подмешай `copy_trade_logs` из `/api/copytrading/logs`, если нужен слой «копир».

```json
{
  "meta": {
    "trader_label": "plankton",
    "trader_wallet": "0x4ffe49ba2a4cae123536a8af4fda48faeb609f71",
    "period_utc": { "from": "2026-01-01T00:00:00Z", "to": "2026-03-23T23:59:59Z" },
    "copy_engine_version": "polysovle-copy-trade (poll 30s, buy_age 30m, sell_age 7d)"
  },
  "trader_observed_trades": [
    {
      "ts": "2026-03-20T12:00:00Z",
      "side": "BUY",
      "market_title": "…",
      "outcome": "YES",
      "price": 0.42,
      "usdc": 120,
      "shares": 285
    }
  ],
  "our_copy_logs": [
    {
      "ts": "2026-03-20T12:00:30Z",
      "action": "BUY",
      "status": "COPIED",
      "source_price": 0.42,
      "copy_price": 0.43,
      "amount_usdc": 25,
      "skip_reason": null
    }
  ],
  "inferred_hypotheses": [
    "Частые входы в бинарники с ценой 0.15–0.45",
    "Среднее удержание 2–5 дней",
    "Частичные выходы перед резолвом"
  ]
}
```

Блок `inferred_hypotheses` заполняется **после** твоей агрегации логов (не выдумывать в MiroFish — только если ты туда перенёс цифры).

---

## 6. Микро-промпт для MiroFish (вставить в запрос)

```
Ты симулируешь двух агентов на prediction market (Polymarket-like):

A) «Plankton» — реальный трейдер; поведение задано только полем trader_observed_trades в семени (частоты, цены, размеры, удержание).

B) «CopyBot» — следует за A с правилами из meta.copy_engine_version и секции our_copy_logs (ограничения по цене, дедуп BUY 7d, пропорциональный SELL, TP/stale/pre-close).

Задача:
1) В 3–5 буллетах опиши **инвестиционный стиль Plankton** (риск, горизонт, любимые диапазоны цен) — строго из trader_observed_trades.
2) Перечисли **3–5 систематических рассинхронов** A vs B из правил копира.
3) Сымитируй **один короткий сценарий** (5–8 шагов времени): Plankton делает цепочку сделок → что делает CopyBot на каждом шаге и почему.
4) Один абзац: какие риски (регион, ликвидность, частичный fill) ломают идеальное копирование.

Не придумывай сделки вне семени; если данных мало — явно скажи «недостаточно наблюдений».
```

---

## 8. Приложение — последние 200 сделок planktonXD (сырые данные Polymarket)

**Источник:** `GET https://data-api.polymarket.com/activity?user=<wallet>&limit=200`

**Кошелёк (proxy):** `0x4ffe49ba2a4cae123536a8af4fda48faeb609f71`  
**Профиль:** [polymarket.com/profile/0x4ffe49ba2a4cae123536a8af4fda48faeb609f71](https://polymarket.com/profile/0x4ffe49ba2a4cae123536a8af4fda48faeb609f71)
**Выгрузка сохранена:** [`docs/data/plankton-last-200-trades.json`](./data/plankton-last-200-trades.json) (полный JSON, ~200 записей)

### Сводка по этим 200 событиям

| Метрика | Значение |
|---------|----------|
| Всего строк | 200 |
| BUY | 133 |
| SELL | 67 |
| Сумма USDC (BUY) | $380.12 |
| Сумма USDC (SELL) | $299.85 |
| Цена: медиана | 0.043 |
| Цена: p10–p90 | 0.001 – 0.340 |

### Набросок гипотез для MiroFish (из этой выборки, не догма)

- Много сделок по **очень дешёвым** исходам (медиана ~4.3¢, p10 ≈ 0.1¢) — высокий **леверидж по ROI**, много «лотерейных» ног.
- Смесь **киберспорт** (LoL, Dota 2, CS2, Valorant), **спорт** (MLB, теннис), **политика/гео** (Дания, Бразилия, Иран и т.д.), **мемы/соц** (Elon tweets, Netflix, App Store).
- **Высокая частота** в одних и тех же `eventSlug` (Дания, один матч) — похоже на **доливки/скальп** внутри одного события.
- BUY &gt; SELL по числу сделок в окне — активный **набор** позиций; SELL часто мелкими кусками (частичные выходы).

### Топ eventSlug по числу сделок (в этой выборке)

| Сделок | eventSlug |
|--------|-----------|
| 20 | `next-prime-minister-of-denmark-after-parliamentary-election` |
| 12 | `cs2-prv-vit-2026-03-23` |
| 11 | `dota2-vp-og-2026-03-23` |
| 10 | `lol-es1-gal-2026-03-23` |
| 10 | `brazil-presidential-election-first-round-2nd-place` |
| 10 | `dota2-flc-ts8-2026-03-23` |
| 8 | `cs2-ast-matrix-2026-03-23` |
| 7 | `mlb-cws-oak-2026-03-23` |
| 7 | `lol-big1-kcb-2026-03-23` |
| 6 | `mlb-sea-sd-2026-03-23` |
| 5 | `cs2-nem-k271-2026-03-23` |
| 5 | `wta-cirstea-gauff-2026-03-23` |

### Таблица: 200 сделок (новые сверху — как в API)

| # | UTC | Side | Price | USDC | Shares | Outcome | Market |
|---|-----|------|-------|------|--------|---------|--------|
| 1 | 2026-03-23 20:57:17Z | SELL | 0.470 | 3.58 | 7.62 | Gibson | Set Handicap: Rybakina (-1.5) vs Gibson (+1.5) |
| 2 | 2026-03-23 20:57:13Z | SELL | 0.440 | 10.12 | 23.00 | No | Will Team Spirit qualify to Blast Open Rotterdam Playoffs? |
| 3 | 2026-03-23 20:57:09Z | SELL | 0.001 | 0.05 | 45.95 | Virtus.pro | Dota 2: Virtus.pro vs OG - Game 2 Winner |
| 4 | 2026-03-23 20:56:57Z | BUY | 0.220 | 3.30 | 15.00 | Chicago White Sox | Chicago White Sox vs. Athletics |
| 5 | 2026-03-23 20:56:55Z | BUY | 0.220 | 1.98 | 9.00 | Chicago White Sox | Chicago White Sox vs. Athletics |
| 6 | 2026-03-23 20:56:39Z | SELL | 0.002 | 0.13 | 64.56 | Eintracht Spandau | LoL: Eintracht Spandau vs Galions - Game 2 Winner |
| 7 | 2026-03-23 20:56:27Z | BUY | 0.014 | 0.14 | 10.14 | No | Will "One Piece: Season 2" be the top global Netflix show this week? |
| 8 | 2026-03-23 20:56:07Z | BUY | 0.083 | 1.16 | 14.00 | No | Will ChatGPT be #1 Free App in the US Apple App Store on March 24? |
| 9 | 2026-03-23 20:55:53Z | SELL | 0.210 | 0.42 | 2.00 | Chicago White Sox | Chicago White Sox vs. Athletics |
| 10 | 2026-03-23 20:55:51Z | SELL | 0.210 | 1.68 | 8.00 | Chicago White Sox | Chicago White Sox vs. Athletics |
| 11 | 2026-03-23 20:55:27Z | BUY | 0.051 | 0.05 | 1.05 | Pigeons | Valorant: M80 vs Pigeons (BO3) - VCL North America: Stage 2 Swiss Stage  |
| 12 | 2026-03-23 20:55:19Z | BUY | 0.044 | 8.98 | 204.00 | Yes | Will Elon Musk post 420-439 tweets from March 17 to March 24, 2026? |
| 13 | 2026-03-23 20:54:51Z | SELL | 0.036 | 6.84 | 190.09 | Yes | Will Denmark win the televote for Eurovision 2026? |
| 14 | 2026-03-23 20:54:31Z | SELL | 0.410 | 1.00 | 2.44 | Yes | Will Aryna Sabalenka win the 2026 women's singles tournament at the Miam |
| 15 | 2026-03-23 20:54:03Z | BUY | 0.200 | 2.60 | 13.00 | Chicago White Sox | Chicago White Sox vs. Athletics |
| 16 | 2026-03-23 20:53:59Z | BUY | 0.200 | 3.00 | 15.00 | Chicago White Sox | Chicago White Sox vs. Athletics |
| 17 | 2026-03-23 20:53:47Z | BUY | 0.200 | 2.00 | 10.00 | Chicago White Sox | Chicago White Sox vs. Athletics |
| 18 | 2026-03-23 20:53:39Z | SELL | 0.032 | 0.75 | 23.50 | Yes | Will Elon Musk post 1840-1919 tweets in April 2026? |
| 19 | 2026-03-23 20:53:15Z | SELL | 0.029 | 0.29 | 9.97 | Yes | Will Denmark win the televote for Eurovision 2026? |
| 20 | 2026-03-23 20:53:01Z | SELL | 0.360 | 12.06 | 33.50 | Yes | Will The MongolZ qualify to Blast Open Rotterdam Playoffs? |
| 21 | 2026-03-23 20:52:03Z | BUY | 0.001 | 0.33 | 325.86 | Ursa | Counter-Strike: 1WIN vs Ursa (BO3) - ESL Challenger League Europe Cup #2 |
| 22 | 2026-03-23 20:51:27Z | BUY | 0.001 | 0.03 | 28.19 | Yes | Will The Alternative win the second most seats in the Danish Folketing i |
| 23 | 2026-03-23 20:51:27Z | BUY | 0.001 | 0.01 | 10.00 | Yes | Will The Alternative win the second most seats in the Danish Folketing i |
| 24 | 2026-03-23 20:51:27Z | BUY | 0.001 | 0.00 | 2.50 | Yes | Will The Alternative win the second most seats in the Danish Folketing i |
| 25 | 2026-03-23 20:51:27Z | BUY | 0.001 | 0.06 | 63.48 | Yes | Will The Alternative win the second most seats in the Danish Folketing i |
| 26 | 2026-03-23 20:51:27Z | SELL | 0.002 | 0.01 | 6.76 | Eintracht Spandau | LoL: Eintracht Spandau vs Galions - Game 2 Winner |
| 27 | 2026-03-23 20:51:21Z | BUY | 0.180 | 0.55 | 3.05 | Yes | Will the Social Democrats win <35 seats in the Danish Folketing in the 2 |
| 28 | 2026-03-23 20:50:09Z | SELL | 0.400 | 9.83 | 24.58 | Yes | Will Hannah Pingree win the 2026 Maine Governor Democratic primary elect |
| 29 | 2026-03-23 20:49:23Z | BUY | 0.140 | 0.41 | 2.91 | Yes | Will Meta (META) close at $590-$600 on the final day of trading of the w |
| 30 | 2026-03-23 20:48:31Z | SELL | 0.002 | 0.45 | 226.07 | Eintracht Spandau | LoL: Eintracht Spandau vs Galions - Game 2 Winner |
| 31 | 2026-03-23 20:48:31Z | SELL | 0.001 | 0.47 | 472.85 | Eintracht Spandau | LoL: Eintracht Spandau vs Galions - Game 2 Winner |
| 32 | 2026-03-23 20:47:21Z | BUY | 0.001 | 3.66 | 3660.00 | Eintracht Spandau | LoL: Eintracht Spandau vs Galions (BO3) - EMEA Masters Playoffs |
| 33 | 2026-03-23 20:46:57Z | SELL | 0.003 | 0.24 | 80.00 | Eintracht Spandau | LoL: Eintracht Spandau vs Galions - Game 2 Winner |
| 34 | 2026-03-23 20:46:37Z | BUY | 0.022 | 0.33 | 15.21 | Yes | Will Carlos Roberto Massa Júnior finish in second place in the first rou |
| 35 | 2026-03-23 20:45:55Z | BUY | 0.001 | 0.54 | 543.90 | Yes | Marcus Smart: Points O/U 8.5 |
| 36 | 2026-03-23 20:45:17Z | SELL | 0.350 | 4.55 | 13.00 | San Diego Padres | Seattle Mariners vs. San Diego Padres |
| 37 | 2026-03-23 20:45:17Z | SELL | 0.350 | 1.09 | 3.11 | San Diego Padres | Seattle Mariners vs. San Diego Padres |
| 38 | 2026-03-23 20:44:45Z | BUY | 0.200 | 0.63 | 3.13 | Yes | Will Google (GOOGL) close at $300-$305 on the final day of trading of th |
| 39 | 2026-03-23 20:44:23Z | BUY | 0.001 | 0.01 | 5.00 | Eintracht Spandau | LoL: Eintracht Spandau vs Galions - Game 2 Winner |
| 40 | 2026-03-23 20:44:15Z | BUY | 0.001 | 1.26 | 1255.91 | Eintracht Spandau | LoL: Eintracht Spandau vs Galions - Game 2 Winner |
| 41 | 2026-03-23 20:43:47Z | SELL | 0.410 | 1.00 | 2.44 | Yes | Will Aryna Sabalenka win the 2026 women's singles tournament at the Miam |
| 42 | 2026-03-23 20:42:47Z | SELL | 0.170 | 0.03 | 0.18 | Sergio Luis Hernandez | Bucaramanga: Peter Bertran vs Sergio Luis Hernandez |
| 43 | 2026-03-23 20:42:47Z | SELL | 0.170 | 10.00 | 58.82 | Sergio Luis Hernandez | Bucaramanga: Peter Bertran vs Sergio Luis Hernandez |
| 44 | 2026-03-23 20:42:33Z | BUY | 0.001 | 0.00 | 1.00 | Eintracht Spandau | LoL: Eintracht Spandau vs Galions (BO3) - EMEA Masters Playoffs |
| 45 | 2026-03-23 20:42:23Z | BUY | 0.370 | 8.88 | 24.00 | Gibson | Set Handicap: Rybakina (-1.5) vs Gibson (+1.5) |
| 46 | 2026-03-23 20:42:17Z | SELL | 0.001 | 0.03 | 25.00 | Virtus.pro | Dota 2: Virtus.pro vs OG - Game 2 Winner |
| 47 | 2026-03-23 20:42:11Z | SELL | 0.340 | 6.80 | 20.00 | OG | Dota 2: OG vs Team Spirit - Game 1 Winner |
| 48 | 2026-03-23 20:41:57Z | BUY | 0.001 | 0.61 | 609.87 | Yes | Will Iowa win the 2026 Women's NCAA Tournament? |
| 49 | 2026-03-23 20:40:45Z | BUY | 0.001 | 0.79 | 786.18 | Eintracht Spandau | LoL: Eintracht Spandau vs Galions (BO3) - EMEA Masters Playoffs |
| 50 | 2026-03-23 20:40:25Z | BUY | 0.150 | 5.10 | 34.00 | Sergio Luis Hernandez | Bucaramanga: Peter Bertran vs Sergio Luis Hernandez |
| 51 | 2026-03-23 20:40:25Z | BUY | 0.150 | 3.75 | 25.00 | Sergio Luis Hernandez | Bucaramanga: Peter Bertran vs Sergio Luis Hernandez |
| 52 | 2026-03-23 20:40:23Z | SELL | 0.001 | 0.01 | 6.77 | Virtus.pro | Dota 2: Virtus.pro vs OG - Game 2 Winner |
| 53 | 2026-03-23 20:40:11Z | SELL | 0.340 | 11.02 | 32.42 | Yes | Will Venstre win the third most seats in the Danish Folketing in the 202 |
| 54 | 2026-03-23 20:40:09Z | BUY | 0.050 | 9.00 | 180.00 | Yes | Will Lars Løkke Rasmussen be the next prime minister of Denmark after th |
| 55 | 2026-03-23 20:39:13Z | SELL | 0.001 | 0.00 | 3.15 | Virtus.pro | Dota 2: Virtus.pro vs OG - Game 2 Winner |
| 56 | 2026-03-23 20:38:57Z | SELL | 0.001 | 0.54 | 540.00 | Virtus.pro | Dota 2: Virtus.pro vs OG - Game 2 Winner |
| 57 | 2026-03-23 20:38:25Z | BUY | 0.270 | 0.00 | 0.01 | Yes | Gensyn FDV above $400M one day after launch? |
| 58 | 2026-03-23 20:38:23Z | BUY | 0.320 | 7.31 | 22.83 | OG | Dota 2: OG vs Team Spirit - Game 1 Winner |
| 59 | 2026-03-23 20:38:21Z | SELL | 0.360 | 5.00 | 13.89 | San Diego Padres | Seattle Mariners vs. San Diego Padres |
| 60 | 2026-03-23 20:38:09Z | BUY | 0.340 | 8.84 | 26.00 | No | Will Crude Oil (CL) settle at $90+ in March? |
| 61 | 2026-03-23 20:37:55Z | BUY | 0.027 | 0.91 | 33.52 | Yes | Will Alex Vanopslagh be the next prime minister of Denmark after the 202 |
| 62 | 2026-03-23 20:37:53Z | BUY | 0.027 | 5.40 | 200.00 | Yes | Will Alex Vanopslagh be the next prime minister of Denmark after the 202 |
| 63 | 2026-03-23 20:37:53Z | BUY | 0.027 | 1.37 | 50.80 | Yes | Will Alex Vanopslagh be the next prime minister of Denmark after the 202 |
| 64 | 2026-03-23 20:37:39Z | BUY | 0.027 | 0.27 | 10.00 | Yes | Will Alex Vanopslagh be the next prime minister of Denmark after the 202 |
| 65 | 2026-03-23 20:37:39Z | BUY | 0.027 | 1.04 | 38.68 | Yes | Will Alex Vanopslagh be the next prime minister of Denmark after the 202 |
| 66 | 2026-03-23 20:37:35Z | BUY | 0.005 | 0.03 | 6.00 | Yes | Will the highest temperature in Wuhan be 11°C or below on March 26? |
| 67 | 2026-03-23 20:37:09Z | SELL | 0.420 | 2.10 | 5.00 | Yes | Will Kenyan McDuffie win the 2026 Democratic D.C. Mayoral Primary? |
| 68 | 2026-03-23 20:35:59Z | BUY | 0.027 | 0.12 | 4.57 | Yes | Will Alex Vanopslagh be the next prime minister of Denmark after the 202 |
| 69 | 2026-03-23 20:35:59Z | BUY | 0.027 | 0.11 | 4.14 | Yes | Will Alex Vanopslagh be the next prime minister of Denmark after the 202 |
| 70 | 2026-03-23 20:35:57Z | BUY | 0.027 | 0.38 | 13.95 | Yes | Will Alex Vanopslagh be the next prime minister of Denmark after the 202 |
| 71 | 2026-03-23 20:35:55Z | SELL | 0.320 | 3.20 | 10.00 | Yes | Will S&P 500 (SPX) hit $6,300 (LOW) in March 2026? |
| 72 | 2026-03-23 20:35:55Z | BUY | 0.027 | 4.52 | 167.41 | Yes | Will Alex Vanopslagh be the next prime minister of Denmark after the 202 |
| 73 | 2026-03-23 20:34:37Z | BUY | 0.018 | 8.98 | 499.00 | Yes | US strike on Cuba by March 31? |
| 74 | 2026-03-23 20:33:41Z | SELL | 0.390 | 10.92 | 28.00 | No | Pakistan military action against Afghanistan by March 31? |
| 75 | 2026-03-23 20:33:25Z | BUY | 0.140 | 0.41 | 2.91 | Yes | Will Meta (META) close at $590-$600 on the final day of trading of the w |
| 76 | 2026-03-23 20:32:03Z | BUY | 0.001 | 1.08 | 1081.94 | Virtus.pro | Dota 2: Virtus.pro vs OG - Game 2 Winner |
| 77 | 2026-03-23 20:31:53Z | BUY | 0.140 | 7.84 | 56.00 | Yes | Will Romeu Zema finish in third place in the first round of the 2026 Bra |
| 78 | 2026-03-23 20:31:41Z | BUY | 0.001 | 0.96 | 963.38 | Virtus.pro | Dota 2: Virtus.pro vs OG - Game 2 Winner |
| 79 | 2026-03-23 20:31:25Z | BUY | 0.051 | 2.65 | 52.00 | Yes | Will Renan Santos finish in second place in the first round of the 2026  |
| 80 | 2026-03-23 20:31:25Z | BUY | 0.051 | 6.32 | 124.00 | Yes | Will Renan Santos finish in second place in the first round of the 2026  |
| 81 | 2026-03-23 20:31:25Z | BUY | 0.008 | 0.08 | 10.00 | Yes | Will Carlos Roberto Massa Júnior finish in second place in the first rou |
| 82 | 2026-03-23 20:31:25Z | BUY | 0.030 | 0.78 | 26.00 | Yes | Will Fernando Haddad finish in second place in the first round of the 20 |
| 83 | 2026-03-23 20:31:25Z | BUY | 0.008 | 0.21 | 26.00 | Yes | Will Carlos Roberto Massa Júnior finish in second place in the first rou |
| 84 | 2026-03-23 20:31:25Z | BUY | 0.008 | 0.23 | 29.10 | Yes | Will Carlos Roberto Massa Júnior finish in second place in the first rou |
| 85 | 2026-03-23 20:31:25Z | BUY | 0.030 | 0.30 | 10.00 | Yes | Will Fernando Haddad finish in second place in the first round of the 20 |
| 86 | 2026-03-23 20:31:23Z | BUY | 0.030 | 0.90 | 30.00 | Yes | Will Fernando Haddad finish in second place in the first round of the 20 |
| 87 | 2026-03-23 20:31:23Z | BUY | 0.030 | 2.64 | 87.98 | Yes | Will Fernando Haddad finish in second place in the first round of the 20 |
| 88 | 2026-03-23 20:31:15Z | SELL | 0.002 | 0.00 | 0.01 | FURIA fe | Counter-Strike: FURIA fe vs Isurus - Map 2 Winner |
| 89 | 2026-03-23 20:30:51Z | SELL | 0.380 | 2.99 | 7.87 | No | Will Iran take military action against a Gulf State on March 23, 2026? |
| 90 | 2026-03-23 20:30:31Z | BUY | 0.300 | 8.70 | 29.00 | Pigeons | Valorant: M80 vs Pigeons (BO3) - VCL North America: Stage 2 Swiss Stage  |
| 91 | 2026-03-23 20:30:11Z | BUY | 0.001 | 0.03 | 32.00 | Virtus.pro | Dota 2: Virtus.pro vs OG - Game 2 Winner |
| 92 | 2026-03-23 20:29:59Z | BUY | 0.016 | 8.99 | 562.00 | Yes | Will the highest temperature in Atlanta be between 54-55°F on March 25? |
| 93 | 2026-03-23 20:29:19Z | BUY | 0.027 | 2.70 | 100.00 | Yes | Will Alex Vanopslagh be the next prime minister of Denmark after the 202 |
| 94 | 2026-03-23 20:27:35Z | BUY | 0.027 | 0.24 | 9.00 | Yes | Will Alex Vanopslagh be the next prime minister of Denmark after the 202 |
| 95 | 2026-03-23 20:27:29Z | BUY | 0.081 | 4.33 | 53.43 | No | Will ChatGPT be #1 Free App in the US Apple App Store on March 24? |
| 96 | 2026-03-23 20:27:13Z | BUY | 0.320 | 8.96 | 28.00 | Yes | Will Renan Santos finish in third place in the first round of the 2026 B |
| 97 | 2026-03-23 20:27:07Z | BUY | 0.001 | 3.66 | 3660.00 | FURIA fe | Counter-Strike: FURIA fe vs Isurus - Map 2 Winner |
| 98 | 2026-03-23 20:26:31Z | BUY | 0.001 | 0.07 | 74.30 | Virtus.pro | Dota 2: Virtus.pro vs OG - Game 2 Winner |
| 99 | 2026-03-23 20:25:11Z | SELL | 0.003 | 2.23 | 743.24 | Karmine Corp Blue | LoL: Berlin International Gaming vs Karmine Corp Blue (BO3) - EMEA Maste |
| 100 | 2026-03-23 20:25:03Z | SELL | 0.240 | 1.68 | 7.00 | San Diego Padres | Seattle Mariners vs. San Diego Padres |
| 101 | 2026-03-23 20:23:55Z | BUY | 0.090 | 5.35 | 59.49 | Ursa | Counter-Strike: 1WIN vs Ursa (BO3) - ESL Challenger League Europe Cup #2 |
| 102 | 2026-03-23 20:23:53Z | BUY | 0.090 | 3.65 | 40.51 | Ursa | Counter-Strike: 1WIN vs Ursa (BO3) - ESL Challenger League Europe Cup #2 |
| 103 | 2026-03-23 20:23:37Z | SELL | 0.005 | 0.01 | 2.35 | Karmine Corp Blue | LoL: Berlin International Gaming vs Karmine Corp Blue (BO3) - EMEA Maste |
| 104 | 2026-03-23 20:23:29Z | BUY | 0.030 | 0.26 | 8.59 | Yes | Will Elon Musk post 1840-1919 tweets in April 2026? |
| 105 | 2026-03-23 20:23:27Z | BUY | 0.220 | 0.25 | 1.14 | San Diego Padres | Seattle Mariners vs. San Diego Padres |
| 106 | 2026-03-23 20:22:53Z | SELL | 0.005 | 0.01 | 1.00 | Karmine Corp Blue | LoL: Berlin International Gaming vs Karmine Corp Blue (BO3) - EMEA Maste |
| 107 | 2026-03-23 20:22:11Z | SELL | 0.079 | 61.63 | 780.13 | No | Will ChatGPT be #1 Free App in the US Apple App Store on March 24? |
| 108 | 2026-03-23 20:21:55Z | BUY | 0.220 | 7.89 | 35.86 | San Diego Padres | Seattle Mariners vs. San Diego Padres |
| 109 | 2026-03-23 20:20:39Z | BUY | 0.001 | 3.66 | 3660.00 | FURIA fe | Counter-Strike: FURIA fe vs Isurus (BO3) - CCT South America Series #10  |
| 110 | 2026-03-23 20:20:27Z | BUY | 0.001 | 0.00 | 1.80 | FURIA fe | Counter-Strike: FURIA fe vs Isurus - Map 2 Winner |
| 111 | 2026-03-23 20:20:09Z | SELL | 0.390 | 9.75 | 25.00 | Yes | Norman Powell: Points O/U 19.5 |
| 112 | 2026-03-23 20:20:05Z | SELL | 0.001 | 0.29 | 210.00 | Matrix | Counter-Strike: ASTRAL vs Matrix (BO1) - Urban Riga Open #3 Group C |
| 113 | 2026-03-23 20:19:47Z | SELL | 0.240 | 0.30 | 1.25 | Yes | NATO x Russia military clash by December 31, 2026? |
| 114 | 2026-03-23 20:19:41Z | BUY | 0.050 | 1.00 | 20.00 | Yes | Will Lars Løkke Rasmussen be the next prime minister of Denmark after th |
| 115 | 2026-03-23 20:19:41Z | BUY | 0.050 | 0.43 | 8.53 | Yes | Will Lars Løkke Rasmussen be the next prime minister of Denmark after th |
| 116 | 2026-03-23 20:19:01Z | SELL | 0.180 | 1.80 | 10.00 | Team Nemesis | Counter-Strike: Team Nemesis vs K27 (BO3) - ESL Challenger League Europe |
| 117 | 2026-03-23 20:19:01Z | SELL | 0.180 | 4.66 | 25.89 | Team Nemesis | Counter-Strike: Team Nemesis vs K27 (BO3) - ESL Challenger League Europe |
| 118 | 2026-03-23 20:18:59Z | SELL | 0.180 | 1.80 | 10.00 | Team Nemesis | Counter-Strike: Team Nemesis vs K27 (BO3) - ESL Challenger League Europe |
| 119 | 2026-03-23 20:18:35Z | BUY | 0.032 | 8.99 | 281.00 | Yes | Jacob Elordi announced as next James Bond? |
| 120 | 2026-03-23 20:18:21Z | SELL | 0.001 | 0.01 | 14.58 | Matrix | Counter-Strike: ASTRAL vs Matrix (BO1) - Urban Riga Open #3 Group C |
| 121 | 2026-03-23 20:18:21Z | SELL | 0.001 | 0.02 | 18.88 | Matrix | Counter-Strike: ASTRAL vs Matrix (BO1) - Urban Riga Open #3 Group C |
| 122 | 2026-03-23 20:17:59Z | BUY | 0.351 | 8.78 | 25.00 | No | Will Hezbollah conduct military action against Israel on March 22, 2026? |
| 123 | 2026-03-23 20:17:51Z | BUY | 0.081 | 0.41 | 5.03 | Yes | Will the upper bound of the target federal funds rate be 4.0% at the end |
| 124 | 2026-03-23 20:17:27Z | BUY | 0.020 | 6.60 | 330.23 | Xtreme Gaming | Dota 2: paiN Gaming vs Xtreme Gaming - Game 2 Winner |
| 125 | 2026-03-23 20:17:21Z | BUY | 0.043 | 1.06 | 24.57 | Yes | Israel x Hezbollah ceasefire by March 31, 2026? |
| 126 | 2026-03-23 20:17:19Z | BUY | 0.020 | 2.40 | 119.77 | Xtreme Gaming | Dota 2: paiN Gaming vs Xtreme Gaming - Game 2 Winner |
| 127 | 2026-03-23 20:17:09Z | BUY | 0.001 | 1.15 | 1145.00 | Philadelphia Phillies | Tampa Bay Rays vs. Philadelphia Phillies |
| 128 | 2026-03-23 20:17:05Z | BUY | 0.020 | 6.22 | 311.21 | Yes | Will Carlos Roberto Massa Júnior finish in third place in the first roun |
| 129 | 2026-03-23 20:17:05Z | SELL | 0.079 | 3.24 | 40.97 | Yes | Will Alexander Zverev win the 2026 men's singles tournament at the Miami |
| 130 | 2026-03-23 20:16:51Z | SELL | 0.170 | 1.04 | 6.11 | Team Nemesis | Counter-Strike: Team Nemesis vs K27 (BO3) - ESL Challenger League Europe |
| 131 | 2026-03-23 20:16:37Z | SELL | 0.004 | 0.97 | 243.17 | Yes | Will Frances Tiafoe win the 2026 men's singles tournament at the Miami O |
| 132 | 2026-03-23 20:16:25Z | SELL | 0.390 | 2.06 | 5.28 | Yes | Will Aryna Sabalenka win the 2026 women's singles tournament at the Miam |
| 133 | 2026-03-23 20:15:17Z | BUY | 0.050 | 0.51 | 10.16 | Yes | Will Lars Løkke Rasmussen be the next prime minister of Denmark after th |
| 134 | 2026-03-23 20:14:33Z | BUY | 0.010 | 9.00 | 900.00 | Team Spirit | Dota 2: Team Falcons vs Team Spirit (BO2) - ESL One Birmingham Group B |
| 135 | 2026-03-23 20:14:29Z | SELL | 0.380 | 7.00 | 18.43 | No | Will Iran conduct a military action against Israel on March 24, 2026? |
| 136 | 2026-03-23 20:13:53Z | BUY | 0.050 | 0.48 | 9.58 | Yes | Will Lars Løkke Rasmussen be the next prime minister of Denmark after th |
| 137 | 2026-03-23 20:13:51Z | BUY | 0.050 | 2.50 | 50.00 | Yes | Will Lars Løkke Rasmussen be the next prime minister of Denmark after th |
| 138 | 2026-03-23 20:13:51Z | BUY | 0.050 | 1.56 | 31.18 | Yes | Will Lars Løkke Rasmussen be the next prime minister of Denmark after th |
| 139 | 2026-03-23 20:13:51Z | BUY | 0.050 | 0.50 | 10.00 | Yes | Will Lars Løkke Rasmussen be the next prime minister of Denmark after th |
| 140 | 2026-03-23 20:13:51Z | BUY | 0.050 | 2.00 | 40.00 | Yes | Will Lars Løkke Rasmussen be the next prime minister of Denmark after th |
| 141 | 2026-03-23 20:13:31Z | BUY | 0.160 | 8.32 | 52.00 | Team Nemesis | Counter-Strike: Team Nemesis vs K27 (BO3) - ESL Challenger League Europe |
| 142 | 2026-03-23 20:13:29Z | BUY | 0.120 | 9.00 | 75.00 | Virtus.pro | Dota 2: Virtus.pro vs OG - Game 2 Winner |
| 143 | 2026-03-23 20:12:41Z | SELL | 0.169 | 7.10 | 42.00 | Team Spirit | Dota 2: Team Falcons vs Team Spirit - Game 2 Winner |
| 144 | 2026-03-23 20:12:37Z | BUY | 0.090 | 1.80 | 20.00 | New York Yankees | New York Yankees vs. Chicago Cubs |
| 145 | 2026-03-23 20:12:33Z | BUY | 0.090 | 1.80 | 20.00 | New York Yankees | New York Yankees vs. Chicago Cubs |
| 146 | 2026-03-23 20:12:29Z | BUY | 0.270 | 5.60 | 20.73 | No | Will Iran conduct a military action against Israel on March 24, 2026? |
| 147 | 2026-03-23 20:11:11Z | SELL | 0.001 | 0.02 | 15.15 | Matrix | Counter-Strike: ASTRAL vs Matrix (BO1) - Urban Riga Open #3 Group C |
| 148 | 2026-03-23 20:11:07Z | BUY | 0.310 | 8.99 | 28.99 | Yes | Will Carlos Roberto Massa Júnior finish in third place in the first roun |
| 149 | 2026-03-23 20:11:03Z | BUY | 0.157 | 6.59 | 42.00 | Team Spirit | Dota 2: Team Falcons vs Team Spirit - Game 2 Winner |
| 150 | 2026-03-23 20:11:01Z | BUY | 0.160 | 8.96 | 56.00 | Virtus.pro | Dota 2: Virtus.pro vs OG - Game 2 Winner |
| 151 | 2026-03-23 20:10:49Z | BUY | 0.022 | 9.00 | 409.00 | No | Will "One Piece: Season 2" be the top global Netflix show this week? |
| 152 | 2026-03-23 20:10:27Z | BUY | 0.001 | 3.66 | 3660.00 | Nigma Galaxy | Dota 2: Aurora vs Nigma Galaxy - Game 2 Winner |
| 153 | 2026-03-23 20:10:21Z | BUY | 0.001 | 0.21 | 208.99 | Nigma Galaxy | Dota 2: Aurora vs Nigma Galaxy (BO2) - ESL One Birmingham Group B |
| 154 | 2026-03-23 20:10:19Z | BUY | 0.010 | 0.04 | 4.04 | Gauff | Set Handicap: Gauff (-1.5) vs Cirstea (+1.5) |
| 155 | 2026-03-23 20:10:11Z | BUY | 0.001 | 3.45 | 3451.01 | Nigma Galaxy | Dota 2: Aurora vs Nigma Galaxy (BO2) - ESL One Birmingham Group B |
| 156 | 2026-03-23 20:09:59Z | BUY | 0.010 | 3.43 | 343.43 | Gauff | Set Handicap: Gauff (-1.5) vs Cirstea (+1.5) |
| 157 | 2026-03-23 20:09:49Z | BUY | 0.010 | 4.66 | 466.40 | Gauff | Set Handicap: Gauff (-1.5) vs Cirstea (+1.5) |
| 158 | 2026-03-23 20:09:41Z | BUY | 0.010 | 0.86 | 86.06 | Gauff | Set Handicap: Gauff (-1.5) vs Cirstea (+1.5) |
| 159 | 2026-03-23 20:09:31Z | SELL | 0.410 | 4.58 | 11.18 | No | Will Crude Oil (CL) settle at $90+ in March? |
| 160 | 2026-03-23 20:09:01Z | SELL | 0.150 | 20.10 | 133.99 | Team Spirit | Dota 2: Team Falcons vs Team Spirit (BO2) - ESL One Birmingham Group B |
| 161 | 2026-03-23 20:08:57Z | SELL | 0.329 | 8.22 | 24.99 | Team Spirit | Dota 2: Team Falcons vs Team Spirit - Game 2 Winner |
| 162 | 2026-03-23 20:08:51Z | SELL | 0.329 | 0.76 | 2.32 | Team Spirit | Dota 2: Team Falcons vs Team Spirit - Game 2 Winner |
| 163 | 2026-03-23 20:08:31Z | BUY | 0.051 | 8.98 | 176.00 | Yes | Israel x Hezbollah ceasefire by March 31, 2026? |
| 164 | 2026-03-23 20:08:31Z | SELL | 0.329 | 0.31 | 0.94 | Team Spirit | Dota 2: Team Falcons vs Team Spirit - Game 2 Winner |
| 165 | 2026-03-23 20:08:29Z | BUY | 0.050 | 6.40 | 128.00 | Gauff | Set Handicap: Gauff (-1.5) vs Cirstea (+1.5) |
| 166 | 2026-03-23 20:08:25Z | SELL | 0.329 | 0.58 | 1.75 | Team Spirit | Dota 2: Team Falcons vs Team Spirit - Game 2 Winner |
| 167 | 2026-03-23 20:08:19Z | SELL | 0.001 | 0.01 | 6.68 | Matrix | Counter-Strike: ASTRAL vs Matrix (BO1) - Urban Riga Open #3 Group C |
| 168 | 2026-03-23 20:07:43Z | SELL | 0.001 | 0.01 | 9.29 | Matrix | Counter-Strike: ASTRAL vs Matrix (BO1) - Urban Riga Open #3 Group C |
| 169 | 2026-03-23 20:07:03Z | BUY | 0.141 | 4.23 | 30.00 | Team Spirit | Dota 2: Team Falcons vs Team Spirit - Game 2 Winner |
| 170 | 2026-03-23 20:06:43Z | BUY | 0.010 | 9.00 | 900.00 | PARIVISION | Map Handicap: VIT (-1.5) vs PARIVISION (+1.5) |
| 171 | 2026-03-23 20:06:43Z | BUY | 0.010 | 0.05 | 5.00 | Over | Games Total: O/U 2.5 |
| 172 | 2026-03-23 20:06:43Z | BUY | 0.010 | 0.05 | 5.00 | Over | Games Total: O/U 2.5 |
| 173 | 2026-03-23 20:06:43Z | BUY | 0.010 | 6.47 | 647.48 | Over | Games Total: O/U 2.5 |
| 174 | 2026-03-23 20:06:17Z | BUY | 0.020 | 0.99 | 49.62 | Over | Games Total: O/U 2.5 |
| 175 | 2026-03-23 20:05:47Z | BUY | 0.001 | 0.03 | 26.44 | Karmine Corp Blue | LoL: Berlin International Gaming vs Karmine Corp Blue (BO3) - EMEA Maste |
| 176 | 2026-03-23 20:05:29Z | SELL | 0.001 | 0.05 | 50.00 | Matrix | Counter-Strike: ASTRAL vs Matrix (BO1) - Urban Riga Open #3 Group C |
| 177 | 2026-03-23 20:05:11Z | BUY | 0.001 | 0.16 | 163.71 | Karmine Corp Blue | LoL: Berlin International Gaming vs Karmine Corp Blue (BO3) - EMEA Maste |
| 178 | 2026-03-23 20:05:03Z | BUY | 0.001 | 1.00 | 1005.00 | Karmine Corp Blue | LoL: Berlin International Gaming vs Karmine Corp Blue (BO3) - EMEA Maste |
| 179 | 2026-03-23 20:05:01Z | SELL | 0.150 | 2.44 | 16.25 | Over | Games Total: O/U 2.5 |
| 180 | 2026-03-23 20:04:57Z | BUY | 0.090 | 9.00 | 100.00 | Team Spirit | Dota 2: Team Falcons vs Team Spirit (BO2) - ESL One Birmingham Group B |
| 181 | 2026-03-23 20:04:37Z | BUY | 0.001 | 2.28 | 2284.32 | Karmine Corp Blue | LoL: Berlin International Gaming vs Karmine Corp Blue (BO3) - EMEA Maste |
| 182 | 2026-03-23 20:04:35Z | BUY | 0.007 | 0.21 | 30.00 | Yes | Will Italy win the televote for Eurovision 2026? |
| 183 | 2026-03-23 20:04:35Z | BUY | 0.004 | 0.10 | 25.55 | Yes | Will Cyprus win the televote for Eurovision 2026? |
| 184 | 2026-03-23 20:04:09Z | SELL | 0.009 | 4.68 | 520.00 | Yes | Marcus Smart: Rebounds O/U 2.5 |
| 185 | 2026-03-23 20:04:07Z | BUY | 0.001 | 0.52 | 520.00 | Yes | Marcus Smart: Rebounds O/U 2.5 |
| 186 | 2026-03-23 20:03:45Z | BUY | 0.070 | 0.17 | 2.47 | Over | Games Total: O/U 2.5 |
| 187 | 2026-03-23 20:03:41Z | BUY | 0.070 | 0.08 | 1.08 | Over | Games Total: O/U 2.5 |
| 188 | 2026-03-23 20:03:39Z | BUY | 0.070 | 0.17 | 2.47 | Over | Games Total: O/U 2.5 |
| 189 | 2026-03-23 20:03:37Z | BUY | 0.070 | 0.17 | 2.47 | Over | Games Total: O/U 2.5 |
| 190 | 2026-03-23 20:03:37Z | BUY | 0.070 | 0.38 | 5.38 | Over | Games Total: O/U 2.5 |
| 191 | 2026-03-23 20:03:37Z | BUY | 0.220 | 8.80 | 40.00 | New York Yankees | New York Yankees vs. Chicago Cubs |
| 192 | 2026-03-23 20:03:29Z | BUY | 0.070 | 0.17 | 2.38 | Over | Games Total: O/U 2.5 |
| 193 | 2026-03-23 20:03:17Z | SELL | 0.360 | 28.80 | 80.00 | paiN Gaming | Dota 2: paiN Gaming vs Xtreme Gaming (BO2) - ESL One Birmingham Group B |
| 194 | 2026-03-23 20:03:13Z | BUY | 0.001 | 3.66 | 3660.00 | Yes | Will the highest temperature in Wellington be 16°C on March 24? |
| 195 | 2026-03-23 20:02:57Z | BUY | 0.011 | 1.15 | 104.86 | Yes | Will Julian Assange win the Nobel Peace Prize in 2026? |
| 196 | 2026-03-23 20:02:49Z | BUY | 0.001 | 3.66 | 3660.00 | Daniel Dutra da Silva | Sao Paulo: Juan Carlos Prado vs Daniel Dutra da Silva |
| 197 | 2026-03-23 20:02:17Z | BUY | 0.270 | 0.37 | 1.37 | No | Will Iran conduct a military action against Israel on March 24, 2026? |
| 198 | 2026-03-23 20:01:59Z | SELL | 0.330 | 3.30 | 10.00 | No | Will Iran conduct a military action against Israel on March 24, 2026? |
| 199 | 2026-03-23 20:01:03Z | SELL | 0.012 | 13.20 | 1065.00 | Matrix | Counter-Strike: ASTRAL vs Matrix (BO1) - Urban Riga Open #3 Group C |
| 200 | 2026-03-23 20:00:43Z | BUY | 0.001 | 0.31 | 313.86 | Nigma Galaxy | Dota 2: Aurora vs Nigma Galaxy - Game 2 Winner |

*Shares = `size` в ответе API; UTC из `timestamp` (секунды).*

## 7. Следующий шаг в репо (опционально)

**Обновить JSON** (те же 200 сделок, свежий снимок):

```bash
curl -sS "https://data-api.polymarket.com/activity?user=0x4ffe49ba2a4cae123536a8af4fda48faeb609f71&limit=200" \
  -H "User-Agent: Mozilla/5.0" \
  -o docs/data/plankton-last-200-trades.json
```

Таблицу в §8 и сводку пересобери скриптом или вручную из JSON (поля: `timestamp`, `side`, `price`, `usdcSize`, `size`, `outcome`, `title`).

Скрипт `npm run copy:export-seed` → единый JSON для MiroFish можно добавить отдельно по запросу.

---

*Дисклеймер: симуляция и интерпретация логов — для анализа и обучения моделей, не инвестиционный совет.*
