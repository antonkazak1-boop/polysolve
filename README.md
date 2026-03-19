# Polymarket Analyzer & Parser

Система для анализа и парсинга событий и кошельков на Polymarket с целью поиска арбитражных возможностей и отслеживания стратегий успешных трейдеров.

## Основные возможности

- 🚀 **Асимметричные доходности** - поиск ставок с ROI 5x+ (главная стратегия)
- 💰 **Арбитраж** - расхождения цен после завершения событий
- 📊 **Крупные ставки** - отслеживание успешных кошельков
- 🔍 **Паттерны** - анализ стратегий топ трейдеров
- ⏰ **Закрывающиеся события** - мониторинг последних минут
- 📈 **Портфель** - управление ставками и аналитика

## Технологический стек

- **Backend**: Node.js + TypeScript + Express
- **Database**: PostgreSQL + Prisma ORM
- **Frontend**: Next.js + React + TypeScript + Tailwind CSS
- **Real-time**: WebSocket (Socket.io)
- **Notifications**: Telegram Bot API

## Установка

1. Клонируйте репозиторий
2. Установите зависимости:
```bash
npm install
cd backend && npm install
cd ../frontend && npm install
```

3. Настройте переменные окружения:
```bash
cp backend/.env.example backend/.env
# Отредактируйте backend/.env
```

4. Запустите базу данных:
```bash
docker-compose up -d
```

5. Настройте Prisma:
```bash
cd backend
npm run prisma:generate
npm run prisma:migrate
```

6. Запустите серверы:
```bash
# Из корня проекта
npm run dev
```

## Деплой на VPS (PM2)

На сервере: Node 20+, `git`, глобально `pm2` (`npm i -g pm2`).

```bash
git clone https://github.com/antonkazak1-boop/polysolve.git && cd polysolve
cp backend/.env.example backend/.env && nano backend/.env
# С другого компа к UI — задай API для билда фронта:
export NEXT_PUBLIC_API_URL=http://ТВОЙ_IP_СЕРВЕРА:3002
./deploy.sh
```

Обновление кода: снова `./deploy.sh`. Остановка: `./stop.sh`. Логи: `pm2 logs`.

Или отдельно:
```bash
# Backend
cd backend && npm run dev

# Frontend
cd frontend && npm run dev
```

## Структура проекта

```
polysolve/
├── backend/          # Backend API
├── frontend/        # Next.js frontend
├── shared/          # Общие типы
└── docker-compose.yml
```

## API Endpoints

### Markets
- `GET /api/markets` - Получить активные рынки
- `GET /api/markets/:id` - Получить рынок по ID
- `GET /api/markets/:id/prices` - Получить цены рынка
- `GET /api/markets/closing/soon` - События, закрывающиеся в ближайшее время

### Wallets
- `GET /api/wallets/top` - Топ кошельков по ROI
- `GET /api/wallets/asymmetric` - Кошельки с асимметричными доходностями
- `GET /api/wallets/:address` - Информация о кошельке
- `GET /api/wallets/:address/bets` - Ставки кошелька
- `POST /api/wallets/:address/track` - Отслеживать новый кошелек

### Portfolio
- `GET /api/portfolio/positions` - Получить позиции
- `GET /api/portfolio/stats` - Статистика портфеля
- `GET /api/portfolio/distribution` - Распределение по категориям
- `POST /api/portfolio/positions` - Создать позицию

### Alerts
- `GET /api/alerts` - Получить алерты
- `GET /api/alerts/unread` - Непрочитанные алерты
- `PUT /api/alerts/:id/read` - Отметить как прочитанный

### Strategies
- `GET /api/strategies/asymmetric-returns` - Сигналы асимметричных доходностей
- `POST /api/strategies/asymmetric-returns/analyze` - Запустить анализ
- `POST /api/strategies/arbitrage/analyze` - Анализ арбитража
- `POST /api/strategies/new-bets/monitor` - Мониторинг новых ставок

## Ключевые метрики

- **ROI (Return on Investment)** - главная метрика для оценки успешности кошельков
- **Асимметричные доходности** - ROI 5x+ (500%+)
- **Успешный кошелек** - средний ROI >300%, минимум 10 ставок

## Лицензия

MIT
