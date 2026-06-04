FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3001
CMD ["sh", "-c", "node migrate.js && node migrate_fase1.js && node migrate_fase2.js && node migrate_fase3.js && node migrate_fase4.js && node migrate_email_auth.js && node migrate_avatar.js && node index.js"]
