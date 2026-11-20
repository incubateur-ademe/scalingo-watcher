# Meme ligne que engines.node de package.json, celle que le buildpack de
# Scalingo installe : Node 26 execute le TypeScript sans option.
FROM node:26.13.1-alpine3.24

WORKDIR /app
COPY package.json relay.ts ./

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# node tourne en PID 1 sans init : il recoit quand meme SIGTERM, parce que
# relay.ts l'ecoute explicitement.
CMD ["node", "relay.ts"]
