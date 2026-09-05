FROM node:20-alpine

WORKDIR /app

# ffmpeg powers the background video editor (mediaOptimizer.js), which
# re-encodes/trims videos so they fit each platform's own limits.
RUN apk add --no-cache ffmpeg

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY mediaOptimizer.js ./
COPY public ./public

EXPOSE 8080

CMD ["node", "server.js"]
