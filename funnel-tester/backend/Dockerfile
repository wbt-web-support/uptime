FROM mcr.microsoft.com/playwright:v1.48.2-noble

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

# The base image bundles Playwright's own Chromium, but this project
# launches with channel:"chrome" (real Google Chrome) - install that
# channel explicitly so it matches what runs locally.
RUN npx playwright install --with-deps chrome

COPY . .

EXPOSE 4000
CMD ["npm", "start"]
