# Stage 1: build the React app.
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Stage 2: Nginx serves it and fronts the APIs and the WebSocket gateways.
FROM nginx:1.27-alpine
COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY nginx/templates /etc/nginx/templates
COPY nginx/certs /etc/nginx/certs
COPY --from=web /web/dist /usr/share/nginx/html
