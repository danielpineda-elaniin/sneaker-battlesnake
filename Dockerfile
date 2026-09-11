FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src/ ./src/
COPY server.js ./
EXPOSE 8080
CMD ["node", "server.js"]
