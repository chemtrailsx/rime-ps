# Bay Six runs as a long-lived Node process, not as serverless functions.
# It owns its own HTTP server so it can accept a WebSocket upgrade at
# /ws/voice, and it holds one persistent Rime ws3 socket per session for the
# whole session. Any host that can run this image can run Bay Six.
FROM node:22-alpine

WORKDIR /app

# devDependencies are needed at build time (next, typescript) and at run time
# (tsx runs the TypeScript server directly), so this image does not prune.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
