FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY chrome.js ./
COPY index.js ./
EXPOSE 4001
CMD ["node", "index.js"]
