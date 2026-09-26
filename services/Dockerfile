# One image for every backend service; SERVICE=<name> picks which one runs.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
USER node
EXPOSE 3000
CMD ["node", "src/main.js"]
