# Многоступенчатая сборка: компилируем TypeScript отдельно, в финальный
# образ идёт только скомпилированный JS + прод-зависимости, без tsc/typescript.
FROM node:20-alpine AS builder
WORKDIR /app
# package-lock.json теперь копируется и используется через `npm ci` —
# раньше сюда попадал только package.json, и `npm install` резолвил
# версии заново из семвер-диапазонов при КАЖДОЙ сборке образа. Лок-файл
# при этом уже был закоммичен в репозиторий — то есть версии были
# зафиксированы на бумаге, но реальная сборка Docker их полностью
# игнорировала: два запуска сборки в разное время (или на разных
# машинах) могли молча получить разные транзитивные версии зависимостей,
# а обновлять сам package-lock.json ради воспроизводимости смысла не
# было — сборка всё равно на него не смотрела. `npm ci` — единственная
# команда, которая ГАРАНТИРОВАННО ставит ровно то, что зафиксировано в
# лок-файле (и падает с ошибкой, если package.json и package-lock.json
# разошлись, а не тихо резолвит заново).
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY public ./public
EXPOSE 3000
CMD ["node", "dist/index.js"]
