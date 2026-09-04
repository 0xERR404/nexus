FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY chrome.js ./
COPY index.js ./
COPY lib/ ./lib/
COPY static/ ./static/
EXPOSE 4006
CMD ["node", "index.js"]
