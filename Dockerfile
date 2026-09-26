FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8782

COPY package.json ./
COPY src ./src
COPY contracts ./contracts

RUN mkdir -p /var/lib/codestra/whatsapp && chown -R node:node /app /var/lib/codestra/whatsapp

USER node
EXPOSE 8782
VOLUME ["/var/lib/codestra/whatsapp"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:8782/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node","src/server.mjs"]
