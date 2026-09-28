FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production
VOLUME ["/app/data"]

EXPOSE 8787

CMD ["node", "server.js", "--dir=/app/data"]
