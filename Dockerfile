# Imagen para AWS App Runner / ECS / cualquier host con Docker.
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "node-server.js"]
