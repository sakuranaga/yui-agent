FROM node:22-alpine

WORKDIR /app

# 依存だけ先に入れる (キャッシュ効率)
COPY package.json ./
RUN npm install

# ソースはマウントするので COPY しない (dev は tsx watch で hot reload)
CMD ["npm", "run", "dev"]
