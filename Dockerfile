FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY config.example.json ./config.example.json

ENV BOARD_HOST=0.0.0.0
ENV BOARD_PORT=4173

EXPOSE 4173
CMD ["node", "src/server.js"]
