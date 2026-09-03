FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY chrome.js ./
COPY metrics.js ./
COPY store.js ./
COPY index.js ./
EXPOSE 4004
CMD ["node", "index.js"]
