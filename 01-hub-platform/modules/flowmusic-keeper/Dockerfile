FROM node:20-alpine

# Системный Chromium из Alpine-репозитория — puppeteer-core им управляет
# по CHROMIUM_PATH, свой бинарник не тащим (в разы легче и без проблем
# с недостающими so-библиотеками, которые ловит бандленный Chromium
# puppeteer на Alpine).
RUN apk add --no-cache chromium

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY chrome.js ./
COPY index.js ./

ENV CHROMIUM_PATH=/usr/bin/chromium-browser
EXPOSE 4007
CMD ["node", "index.js"]
