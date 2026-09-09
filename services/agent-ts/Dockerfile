# Railway. Built from the REPO ROOT so npm workspaces and services/ resolve.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY services/agent-ts/package.json services/agent-ts/
RUN npm install --omit=dev --workspace @trial/agent-ts --include-workspace-root
COPY services/agent-ts services/agent-ts
WORKDIR /app/services/agent-ts
CMD ["npm", "run", "worker"]
