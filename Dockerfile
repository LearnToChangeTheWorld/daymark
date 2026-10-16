FROM node:22-alpine
ENV NODE_ENV=production PORT=4317 HOST=0.0.0.0 STUDENT_INBOX_MODE=cloud STUDENT_INBOX_DATA_DIR=/data
WORKDIR /app
COPY --chown=node:node server.mjs package.json ./
COPY --chown=node:node shared ./shared
COPY --chown=node:node public ./public
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 4317
VOLUME ["/data"]
CMD ["node", "server.mjs"]
