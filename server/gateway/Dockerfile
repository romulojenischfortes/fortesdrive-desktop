FROM node:20-alpine

WORKDIR /app
COPY server.js ./

ENV NODE_ENV=production \
    PORT=8790 \
    DATA_DIR=/data

# A pasta de dados é o volume montado pelo docker-compose; a área de preparo
# (.tmp) é criada pelo próprio gateway, dentro dela.
RUN mkdir -p /data/.tmp

EXPOSE 8790

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]