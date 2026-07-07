# Same Node.js 18 base image as the API
FROM node:18

WORKDIR /tests

# The build context is ./tests (see docker-compose.yml), so paths are relative
COPY package.json .
RUN npm install

COPY . .

CMD ["npm", "test"]
