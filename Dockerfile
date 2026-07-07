# Use the Node.js 18 base image
FROM node:18

# Set the working directory
WORKDIR /app

# Copy package.json first (layer caching - npm install is not repeated
# when only the application code changes)
COPY app/package.json .

# Install dependencies
RUN npm install

# Copy the rest of the application files
COPY app .

# Start the application
CMD ["node", "server.js"]
