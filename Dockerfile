FROM node:20-alpine
WORKDIR /app
COPY stress-test-server.js .
COPY index.html .
COPY report-template.html .
EXPOSE 3457
CMD ["node", "stress-test-server.js"]
