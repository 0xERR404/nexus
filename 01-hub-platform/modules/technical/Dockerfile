FROM node:20-alpine

# Системный Chromium из Alpine — puppeteer-core им управляет по
# CHROMIUM_PATH (index.js сам перебирает несколько кандидатов пути,
# см. resolveChromiumPath), свой бинарник не тащим.
RUN apk add --no-cache chromium

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY chrome.js ./
COPY index.js ./
EXPOSE 4001
CMD ["node", "index.js"]
