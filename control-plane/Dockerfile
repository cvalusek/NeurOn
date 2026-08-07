FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm install

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ARG NEURON_BUILD_SHA
ENV NEURON_BUILD_SHA=$NEURON_BUILD_SHA
LABEL org.opencontainers.image.revision=$NEURON_BUILD_SHA
RUN apk add --no-cache docker-cli docker-cli-compose python3 make g++
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY examples ./examples
RUN mkdir -p /app/data
EXPOSE 8090
CMD ["node", "dist/server.js"]
